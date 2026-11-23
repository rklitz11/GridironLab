// Trains game-environment and player models, back-tests them out-of-sample, and writes the website's JSON.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { CACHE, OUT, CURRENT_SEASON } from './lib/config.mjs';
import { predictRow } from './lib/gbm.mjs';
import { trainRidge, predictRidge } from './lib/ridge.mjs';
import { addOppFeatures, OPP_FEATS } from './lib/opp.mjs';

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const load = f => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'));
const r = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const quantile = (sorted, q) => { if (!sorted.length) return null; const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo); };
const Phi = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };

const games = load('games.json');
const teamGames = load('team_games.json');
const playerGames = load('player_games.json');
const pmeta = load('players_meta.json');
const gameById = Object.fromEntries(games.map(g => [g.game_id, g]));
log(`loaded ${teamGames.length} team rows, ${playerGames.length} player rows`);

// Back-test design: models are trained on seasons < TEST_FROM and evaluated on everything after (never seen).
const TEST_FROM = CURRENT_SEASON - 1;
const MARKET = new Set(['spread', 'total', 'implied', 'opp_implied']);

// ------------------------------------------------------------ parallel trainer
const jobs = [];
function toCols(rows, names) {
  const cols = names.map(() => new Float64Array(rows.length));
  rows.forEach((row, i) => names.forEach((nm, f) => { const v = row.features[nm]; cols[f][i] = v == null ? NaN : v; }));
  return cols;
}
function queue(name, rowsTrain, yTrain, names, opts, rowsValid = null, yValid = null) {
  const job = { name, names, opts, cols: toCols(rowsTrain, names), y: Float64Array.from(yTrain) };
  if (rowsValid) job.valid = { cols: toCols(rowsValid, names), y: Float64Array.from(yValid) };
  return new Promise((resolve, reject) => jobs.push({ job, resolve, reject }));
}
async function runQueue() {
  const nWorkers = Math.max(1, Math.min(os.cpus().length - 1, 8));
  let i = 0;
  const workerUrl = new URL('./lib/gbm-worker.mjs', import.meta.url);
  await Promise.all(Array.from({ length: nWorkers }, async () => {
    while (i < jobs.length) {
      const { job, resolve, reject } = jobs[i++];
      const t = Date.now();
      await new Promise(done => {
        const w = new Worker(workerUrl, { workerData: job });
        w.once('message', m => { resolve(m); log(`  trained ${job.name} (${m.trees.length} trees, ${((Date.now() - t) / 1000).toFixed(1)}s)`); done(); });
        w.once('error', e => { reject(e); done(); });
      });
    }
  }));
  jobs.length = 0;
}
const vec = (row, names) => names.map(nm => (row.features[nm] == null ? NaN : row.features[nm]));

// ============================================================ GAME MODEL (team points)
const allTeamFeat = Object.keys(teamGames[0].features);
const GAME_FEATS = allTeamFeat.filter(k => !MARKET.has(k));
const tgDone = teamGames.filter(t => t.done && t.target != null);
const tgTrain = tgDone.filter(t => t.season < TEST_FROM - 1);
const tgVal = tgDone.filter(t => t.season === TEST_FROM - 1);
const tgTest = tgDone.filter(t => t.season >= TEST_FROM);
const GAME_OPTS = { nTrees: 2000, lr: 0.02, maxDepth: 2, minLeaf: 60, lambda: 20, subsample: 0.7, colsample: 0.5, earlyStop: 150 };
const TEAM_TARGETS = {
  points: t => t.target,
  plays: t => t.actual?.plays,
  pass_rate: t => t.actual?.pass_rate,
};
const teamModelsBT = {}, teamModelsFinal = {};
log('game models: back-test fit');
for (const [k, fn] of Object.entries(TEAM_TARGETS)) {
  const tr = tgTrain.filter(t => fn(t) != null), va = tgVal.filter(t => fn(t) != null);
  queue(`team:${k}:bt`, tr, tr.map(fn), GAME_FEATS, GAME_OPTS, va, va.map(fn)).then(m => (teamModelsBT[k] = m));
}
await runQueue();
for (const [k, fn] of Object.entries(TEAM_TARGETS)) {
  const all = tgDone.filter(t => fn(t) != null);
  const nT = Math.max(50, Math.round(teamModelsBT[k].bestIter * 1.1));
  // back-test model refit through TEST_FROM-1 (train+val), then a final model on everything
  const btRows = all.filter(t => t.season < TEST_FROM);
  queue(`team:${k}:bt2`, btRows, btRows.map(fn), GAME_FEATS, { ...GAME_OPTS, nTrees: nT }).then(m => (teamModelsBT[k] = m));
  queue(`team:${k}:final`, all, all.map(fn), GAME_FEATS, { ...GAME_OPTS, nTrees: nT }).then(m => (teamModelsFinal[k] = m));
}
await runQueue();

// Team points = blend of the trees above with a ridge regression on core, opponent-adjusted ratings.
// (Chosen on 2023-24 dev seasons: ridge alone beat trees; a 70/30 blend was best overall.)
const RIDGE_FEATS = ['is_home', 'neutral', 'div_game', 'rest_diff', 'travel_mi', 'tz_shift', 'body_clock', 'indoor', 'wind', 'temp', 'precip', 'elev', 'qb_change', 'opp_qb_change',
  'qb_epa', 'qb_cpoe', 'opp_qb_epa', 'off_adj_pts', 'off_adj_epa', 'off_adj_pass_epa', 'off_adj_rush_epa', 'off_adj_success', 'off_pf', 'off_epa_play', 'off_pts_drive', 'off_plays',
  'off_sec_per_play', 'off_proe', 'off_to_rate', 'off_explosive', 'off_rz_td', 'oppdef_adj_pts', 'oppdef_adj_epa', 'oppdef_adj_pass_epa', 'oppdef_adj_rush_epa', 'oppdef_adj_success',
  'oppdef_pa', 'oppdef_epa_play', 'oppdef_to_rate', 'oppdef_explosive', 'oppoff_sec_per_play', 'oppoff_plays', 'def_adj_epa', 'oppoff_adj_epa', 'games_played', 'week', 'playoff']
  .filter(k => GAME_FEATS.includes(k));
const RIDGE_W = 0.7;
const ridgeFit = rows => trainRidge(toCols(rows, RIDGE_FEATS), Float64Array.from(rows, t => t.target), { lambda: 150 });
const ridgeBT = ridgeFit(tgDone.filter(t => t.season < TEST_FROM)), ridgeFinal = ridgeFit(tgDone);

// Predict every team-game: back-test model for the test seasons, final model for upcoming games.
const tgPred = {};
for (const t of teamGames) {
  const useBT = t.done ? t.season >= TEST_FROM : false;
  if (t.done && !useBT) continue;
  const models = useBT ? teamModelsBT : teamModelsFinal;
  const x = vec(t, GAME_FEATS);
  const o = Object.fromEntries(Object.keys(TEAM_TARGETS).map(k => [k, predictRow(models[k], x)]));
  o.points = RIDGE_W * predictRidge(useBT ? ridgeBT : ridgeFinal, vec(t, RIDGE_FEATS)) + (1 - RIDGE_W) * o.points;
  tgPred[`${t.game_id}|${t.team}`] = o;
}

// Residual spreads from the out-of-sample seasons → probability distributions
const gameEval = [];
for (const g of games) {
  const h = tgPred[`${g.game_id}|${g.home}`], a = tgPred[`${g.game_id}|${g.away}`];
  if (!h || !a || !g.done) continue;
  gameEval.push({ g, pm: h.points - a.points, pt: h.points + a.points, am: g.home_score - g.away_score, at: g.home_score + g.away_score });
}
const sdMargin = Math.sqrt(mean(gameEval.map(e => (e.am - e.pm) ** 2)));
const sdTotal = Math.sqrt(mean(gameEval.map(e => (e.at - e.pt) ** 2)));

function gameMetrics(list) {
  const out = { n: list.length };
  const withLine = list.filter(e => e.g.spread_line != null && e.g.total_line != null);
  out.margin_mae = mean(list.map(e => Math.abs(e.am - e.pm)));
  out.total_mae = mean(list.map(e => Math.abs(e.at - e.pt)));
  out.vegas_margin_mae = mean(withLine.map(e => Math.abs(e.am - e.g.spread_line)));
  out.vegas_total_mae = mean(withLine.map(e => Math.abs(e.at - e.g.total_line)));
  out.model_margin_mae_lined = mean(withLine.map(e => Math.abs(e.am - e.pm)));
  out.model_total_mae_lined = mean(withLine.map(e => Math.abs(e.at - e.pt)));
  const su = list.filter(e => e.am !== 0);
  out.winner_acc = mean(su.map(e => (Math.sign(e.pm) === Math.sign(e.am) ? 1 : 0)));
  out.vegas_winner_acc = mean(su.filter(e => e.g.spread_line).map(e => (Math.sign(e.g.spread_line) === Math.sign(e.am) ? 1 : 0)));
  out.brier = mean(su.map(e => { const p = Phi(e.pm / sdMargin); return (p - (e.am > 0 ? 1 : 0)) ** 2; }));
  // against-the-spread / totals when the model disagrees with the market by >= X points
  for (const thr of [0, 1.5, 3]) {
    const ats = withLine.filter(e => Math.abs(e.pm - e.g.spread_line) >= thr && e.am - e.g.spread_line !== 0);
    const ou = withLine.filter(e => Math.abs(e.pt - e.g.total_line) >= thr && e.at !== e.g.total_line);
    out[`ats_${thr}`] = { n: ats.length, win: mean(ats.map(e => (Math.sign(e.pm - e.g.spread_line) === Math.sign(e.am - e.g.spread_line) ? 1 : 0))) };
    out[`ou_${thr}`] = { n: ou.length, win: mean(ou.map(e => (Math.sign(e.pt - e.g.total_line) === Math.sign(e.at - e.g.total_line) ? 1 : 0))) };
  }
  return out;
}
const gameMetricsOut = { overall: gameMetrics(gameEval), sd_margin: sdMargin, sd_total: sdTotal, by_season: {} };
for (const s of [...new Set(gameEval.map(e => e.g.season))]) gameMetricsOut.by_season[s] = gameMetrics(gameEval.filter(e => e.g.season === s));
log(`game back-test: margin MAE ${gameMetricsOut.overall.margin_mae.toFixed(2)} (vegas ${gameMetricsOut.overall.vegas_margin_mae.toFixed(2)}), total MAE ${gameMetricsOut.overall.total_mae.toFixed(2)} (vegas ${gameMetricsOut.overall.vegas_total_mae.toFixed(2)})`);

// Upcoming games without a posted line: let player models see the model's own spread/total instead.
for (const row of [...teamGames, ...playerGames]) {
  const f = row.features;
  if (row.done || f.spread != null) continue;
  const me = tgPred[`${row.game_id}|${row.team}`], op = tgPred[`${row.game_id}|${row.opp}`];
  if (!me || !op) continue;
  f.spread = r(op.points - me.points, 2); f.total = r(me.points + op.points, 2);
  f.implied = r(me.points, 2); f.opp_implied = r(op.points, 2); f.line_source = 'model';
}

// ============================================================ PLAYER MODELS
const PT = {
  attempts: ['QB'], completions: ['QB'], passing_yards: ['QB'], passing_tds: ['QB'], passing_interceptions: ['QB'],
  carries: ['QB', 'RB', 'WR'], rushing_yards: ['QB', 'RB', 'WR'], rushing_tds: ['QB', 'RB', 'WR'],
  targets: ['RB', 'WR', 'TE'], receptions: ['RB', 'WR', 'TE'], receiving_yards: ['RB', 'WR', 'TE'], receiving_tds: ['RB', 'WR', 'TE'],
  fantasy_points_ppr: ['QB', 'RB', 'WR', 'TE'],
};
for (const p of playerGames) addOppFeatures(p.features);
const P_FEATS = Object.keys(playerGames[0].features).filter(k => k !== 'line_source' && k !== 'td_rate_rz' && !OPP_FEATS.includes(k));
// Expected-share-after-injuries features help the rushing and fantasy-point models (pipeline/experiments/opp-exp.mjs:
// carries RMSE 2.625 -> 2.614, rushing yards and PPR slightly better) but not the receiving ones, so only those use them.
const OPP_STATS = new Set(['carries', 'rushing_yards', 'rushing_tds', 'fantasy_points_ppr']);
const featsFor = k => (OPP_STATS.has(k) ? [...P_FEATS, ...OPP_FEATS] : P_FEATS);
const P_BASE = { nTrees: 1500, lr: 0.04, maxDepth: 5, minLeaf: 50, lambda: 10, subsample: 0.7, colsample: 0.5, earlyStop: 60 };
// Count stats use a Poisson objective; yardage and fantasy points learn slower with larger leaves (both chosen on dev seasons).
const POISSON = new Set(['carries', 'targets', 'receptions', 'passing_tds', 'rushing_tds', 'receiving_tds', 'passing_interceptions']);
const SLOW = new Set(['passing_yards', 'rushing_yards', 'receiving_yards', 'fantasy_points_ppr']);
const optsFor = k => (POISSON.has(k) ? { ...P_BASE, loss: 'poisson' } : SLOW.has(k) ? { ...P_BASE, lr: 0.02, nTrees: 3000, earlyStop: 120, minLeaf: 80 } : P_BASE);
const pgDone = playerGames.filter(p => p.done);
const pgTrain = pgDone.filter(p => p.season < TEST_FROM - 1);
const pgVal = pgDone.filter(p => p.season === TEST_FROM - 1);
const pModelsBT = {}, pModelsFinal = {};
log('player models: early-stopping fit');
for (const [k, pos] of Object.entries(PT)) {
  const tr = pgTrain.filter(p => pos.includes(p.pos)), va = pgVal.filter(p => pos.includes(p.pos));
  queue(`player:${k}:es`, tr, tr.map(p => p.actual[k]), featsFor(k), optsFor(k), va, va.map(p => p.actual[k])).then(m => (pModelsBT[k] = m));
}
await runQueue();
log('player models: back-test + final fit');
for (const [k, pos] of Object.entries(PT)) {
  const nT = Math.max(50, Math.round(pModelsBT[k].bestIter * 1.1));
  const bt = pgDone.filter(p => pos.includes(p.pos) && p.season < TEST_FROM);
  const all = pgDone.filter(p => pos.includes(p.pos));
  queue(`player:${k}:bt`, bt, bt.map(p => p.actual[k]), featsFor(k), { ...optsFor(k), nTrees: nT }).then(m => (pModelsBT[k] = m));
  queue(`player:${k}:final`, all, all.map(p => p.actual[k]), featsFor(k), { ...optsFor(k), nTrees: nT }).then(m => (pModelsFinal[k] = m));
}
await runQueue();

const clampStat = (k, v) => Math.max(0, v);
const pPred = new Map();
for (const p of playerGames) {
  const useBT = p.done && p.season >= TEST_FROM;
  if (p.done && !useBT) continue;
  const models = useBT ? pModelsBT : pModelsFinal;
  const x = vec(p, P_FEATS), xOpp = vec(p, featsFor('carries'));
  const o = {};
  // players already ruled Out for an upcoming game are projected at zero
  const ruledOut = !p.done && /^Out/.test(p.injury || '');
  for (const [k, pos] of Object.entries(PT)) if (pos.includes(p.pos)) o[k] = ruledOut ? 0 : clampStat(k, predictRow(models[k], OPP_STATS.has(k) ? xOpp : x));
  pPred.set(p, o);
}

// Calibrated ranges: for each stat, bucket out-of-sample predictions and record the actual distribution.
const QS = Array.from({ length: 21 }, (_, i) => i / 20);
const calib = {};
const playerMetrics = {};
for (const [k, pos] of Object.entries(PT)) {
  const ev = pgDone.filter(p => p.season >= TEST_FROM && pos.includes(p.pos) && pPred.get(p)?.[k] != null).map(p => ({ p, pr: pPred.get(p)[k], a: p.actual[k] }));
  ev.sort((a, b) => a.pr - b.pr);
  const nBins = 12, bins = [];
  for (let b = 0; b < nBins; b++) {
    const chunk = ev.slice(Math.floor((b * ev.length) / nBins), Math.floor(((b + 1) * ev.length) / nBins));
    if (!chunk.length) continue;
    const acts = chunk.map(c => c.a).sort((x, y) => x - y);
    bins.push({ pred: mean(chunk.map(c => c.pr)), q: QS.map(q => r(quantile(acts, q), 2)) });
  }
  calib[k] = bins;
  const baselineKey = `p_${k}`;
  const m = { n: ev.length, mae: mean(ev.map(e => Math.abs(e.a - e.pr))), rmse: Math.sqrt(mean(ev.map(e => (e.a - e.pr) ** 2))) };
  const base = ev.filter(e => e.p.features[baselineKey] != null);
  m.baseline_mae = mean(base.map(e => Math.abs(e.a - e.p.features[baselineKey])));
  m.model_mae_same_rows = mean(base.map(e => Math.abs(e.a - e.pr)));
  const ybar = mean(ev.map(e => e.a));
  m.r2 = 1 - mean(ev.map(e => (e.a - e.pr) ** 2)) / mean(ev.map(e => (e.a - ybar) ** 2));
  m.by_pos = {};
  for (const ps of pos) {
    const sub = ev.filter(e => e.p.pos === ps);
    const sb = sub.filter(e => e.p.features[baselineKey] != null);
    m.by_pos[ps] = { n: sub.length, mae: mean(sub.map(e => Math.abs(e.a - e.pr))), baseline_mae: mean(sb.map(e => Math.abs(e.a - e.p.features[baselineKey]))) };
  }
  playerMetrics[k] = m;
}
log(`fantasy PPR back-test MAE ${playerMetrics.fantasy_points_ppr.mae.toFixed(2)} vs rolling-average baseline ${playerMetrics.fantasy_points_ppr.baseline_mae.toFixed(2)}`);

function rangeFor(k, pred) {
  const bins = calib[k];
  if (!bins?.length) return null;
  if (pred <= 0) return QS.map(() => 0);
  const first = bins[0], last = bins[bins.length - 1];
  let q;
  if (pred <= first.pred) q = first.q.map(v => v + (pred - first.pred));
  else if (pred >= last.pred) q = last.q.map(v => v * (pred / (last.pred || 1)));
  else {
    const i = bins.findIndex(b => b.pred >= pred);
    const a = bins[i - 1], b = bins[i], w = (pred - a.pred) / (b.pred - a.pred || 1);
    q = a.q.map((v, j) => v + (b.q[j] - v) * w);
  }
  return q.map(v => r(Math.max(0, v), 1));
}

// ============================================================ OUTPUT
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'players'), { recursive: true });
const write = (f, o) => fs.writeFileSync(path.join(OUT, f), JSON.stringify(o));

// team-game lookup for context
const tgByKey = Object.fromEntries(teamGames.map(t => [`${t.game_id}|${t.team}`, t]));
const TEAM_PROFILE = ['off_pf', 'off_epa_play', 'off_pass_epa', 'off_rush_epa', 'off_success', 'off_explosive', 'off_plays', 'off_sec_per_play', 'off_proe',
  'off_neutral_pass', 'off_pts_drive', 'off_rz_td', 'off_to_rate', 'def_pa', 'def_epa_play', 'def_pass_epa', 'def_rush_epa', 'def_success', 'def_explosive',
  'def_to_rate', 'def_fpa_QB', 'def_fpa_RB', 'def_fpa_WR', 'def_fpa_TE', 'rest', 'travel_mi', 'tz_shift', 'body_clock', 'qb_change', 'games_played'];

const gamesOut = games.map(g => {
  const h = tgPred[`${g.game_id}|${g.home}`], a = tgPred[`${g.game_id}|${g.away}`];
  const th = tgByKey[`${g.game_id}|${g.home}`], ta = tgByKey[`${g.game_id}|${g.away}`];
  const o = { ...g };
  if (h && a) {
    const margin = h.points - a.points, total = h.points + a.points;
    o.pred = {
      home_pts: r(h.points), away_pts: r(a.points), margin: r(margin), total: r(total),
      home_wp: r(Phi(margin / sdMargin), 3),
      home_cover: g.spread_line != null ? r(Phi((margin - g.spread_line) / sdMargin), 3) : null,
      over: g.total_line != null ? r(Phi((total - g.total_line) / sdTotal), 3) : null,
      home_plays: r(h.plays), away_plays: r(a.plays), home_pass_rate: r(h.pass_rate, 3), away_pass_rate: r(a.pass_rate, 3),
      source: g.done ? 'backtest' : 'live',
    };
  }
  if (th && ta && (g.season >= CURRENT_SEASON - 2)) {
    o.profile = {
      home: Object.fromEntries(TEAM_PROFILE.map(k => [k, r(th.features[k], 3)])),
      away: Object.fromEntries(TEAM_PROFILE.map(k => [k, r(ta.features[k], 3)])),
    };
    o.home_qb_status = th.usual_qb_status; o.away_qb_status = ta.usual_qb_status;
    o.home_usual_qb = pmeta[th.usual_qb]?.name || null; o.away_usual_qb = pmeta[ta.usual_qb]?.name || null;
  }
  if (g.done && th?.actual && ta?.actual) {
    const pick = x => ({ plays: x.plays, pass_rate: r(x.pass_rate, 3), epa_play: r(x.epa_play, 3), script: r(x.script, 1), trail8: r(x.trail8, 3), lead8: r(x.lead8, 3), sec_per_play: r(x.sec_per_play, 1), proe: r(x.proe, 1), to: x.to_rate != null ? Math.round(x.to_rate * x.plays) : null });
    o.box = { home: pick(th.actual), away: pick(ta.actual) };
  }
  return o;
});
write('games.json', gamesOut);

// player files
const byPlayer = {};
for (const p of playerGames) (byPlayer[p.gsis] ??= []).push(p);
const CTX = ['spread', 'total', 'implied', 'temp', 'wind', 'precip', 'indoor', 'turf', 'kick_et', 'body_clock', 'rest', 'travel_mi', 'tz_shift', 'is_home', 'neutral', 'div_game', 'oppdef_fpa_pos', 'vac_tgt', 'vac_car'];
const KEYF = ['p_snap_pct', 'p_target_share', 'p_carry_share', 'p_air_yards_share', 'p_fantasy_points_ppr', 'l3_fantasy_points_ppr', 'p_games_season', 'ypc', 'ypt', 'ypa',
  'p_ngs_sep', 'p_ngs_ryoe', 'p_ngs_cpoe', 'p_pfr_press', 'p_pfr_yaco', 'p_pfr_drop', 'off_proe', 'off_plays', 'oppdef_pass_epa', 'oppdef_rush_epa', 'inj_status'];
const projections = [];
const index = [];
for (const [gsis, rows] of Object.entries(byPlayer)) {
  const meta = pmeta[gsis] || {};
  const log_ = rows.map(p => {
    const g = gameById[p.game_id];
    const tgt = tgByKey[`${p.game_id}|${p.team}`];
    const isHome = p.team === g.home;
    const o = {
      game_id: p.game_id, season: p.season, week: p.week, gameday: p.gameday, game_type: g.game_type, team: p.team, opp: p.opp,
      loc: g.neutral ? 'N' : isHome ? 'H' : 'A', roof: g.roof, surface: g.surface, stadium: g.stadium, gametime: g.gametime, weekday: g.weekday,
      team_pts: isHome ? g.home_score : g.away_score, opp_pts: isHome ? g.away_score : g.home_score,
      script: r(tgt?.actual?.script, 1), team_pass_rate: r(tgt?.actual?.pass_rate, 3), team_plays: tgt?.actual?.plays ?? null,
      ctx: Object.fromEntries(CTX.map(k => [k, r(p.features[k], 2)])), injury: p.injury,
      line_source: p.features.line_source || (p.features.spread != null ? 'vegas' : null),
    };
    if (p.actual) o.stats = p.actual;
    const pr = pPred.get(p);
    if (pr) {
      o.proj = Object.fromEntries(Object.entries(pr).map(([k, v]) => [k, r(v, 2)]));
      if (!p.done) {
        o.range = Object.fromEntries(Object.keys(pr).map(k => [k, rangeFor(k, pr[k])]));
        o.key = Object.fromEntries(KEYF.map(k => [k, r(p.features[k], 3)]));
      }
    }
    return o;
  });
  write(`players/${gsis}.json`, { gsis, ...meta, log: log_ });
  const done = rows.filter(p => p.done);
  const last = done[done.length - 1];
  const seasonRows = done.filter(p => p.season === (last?.season ?? 0));
  const upcoming = rows.filter(p => !p.done);
  const next = upcoming[0];
  index.push({ gsis, name: meta.name, pos: meta.pos, team: last?.team || meta.team, headshot: meta.headshot, last_season: last?.season,
    last_game: last?.gameday, games: done.length,
    season_fp: r(mean(seasonRows.map(p => p.actual.fantasy_points_ppr))), next_proj: next ? r(pPred.get(next)?.fantasy_points_ppr) : null });
  for (const p of upcoming) {
    const pr = pPred.get(p);
    if (!pr) continue;
    projections.push({ gsis, name: meta.name, pos: p.pos, team: p.team, opp: p.opp, game_id: p.game_id, season: p.season, week: p.week, gameday: p.gameday,
      injury: p.injury, headshot: meta.headshot, line_source: p.features.line_source || 'vegas',
      proj: Object.fromEntries(Object.entries(pr).map(([k, v]) => [k, r(v, 2)])),
      range: Object.fromEntries(Object.keys(pr).map(k => [k, rangeFor(k, pr[k])])),
      key: Object.fromEntries(KEYF.map(k => [k, r(p.features[k], 3)])),
      ctx: Object.fromEntries(CTX.map(k => [k, r(p.features[k], 2)])) });
  }
}
// per-game player sheets (recent seasons + upcoming) for the game detail page
fs.mkdirSync(path.join(OUT, 'games'), { recursive: true });
const sheet = {};
for (const p of playerGames) {
  if (p.season < CURRENT_SEASON - 2) continue;
  const pr = pPred.get(p);
  if (p.done && !(p.actual.snap_pct > 0.05 || p.actual.fantasy_points_ppr || p.actual.attempts || p.actual.targets || p.actual.carries)) continue;
  (sheet[p.game_id] ??= []).push({ gsis: p.gsis, name: p.name, pos: p.pos, team: p.team, injury: p.injury, headshot: pmeta[p.gsis]?.headshot || null,
    stats: p.actual || null, proj: pr ? Object.fromEntries(Object.entries(pr).map(([k, v]) => [k, r(v, 2)])) : null,
    range: pr && !p.done ? { fantasy_points_ppr: rangeFor('fantasy_points_ppr', pr.fantasy_points_ppr) } : null,
    snap: r(p.features.p_snap_pct, 3), tshare: r(p.features.p_target_share, 3) });
}
for (const [gid, rows] of Object.entries(sheet)) write(`games/${gid}.json`, rows);

index.sort((a, b) => (b.last_game || '').localeCompare(a.last_game || '') || (b.season_fp || 0) - (a.season_fp || 0));
write('players.json', index.filter(p => p.last_season >= CURRENT_SEASON - 3));
write('projections.json', projections);

const topImp = m => Object.entries(m.importance).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, r(v, 4)]);
const upcomingGames = games.filter(g => !g.done);
// "next week" = first week where at least half the games are still to be played (skips a lone Monday-nighter)
const wkKey = g => `${g.season}|${g.week}`;
const nextKey = [...new Set(upcomingGames.map(wkKey))].find(k => upcomingGames.filter(g => wkKey(g) === k).length * 2 >= games.filter(g => wkKey(g) === k).length) || (upcomingGames[0] && wkKey(upcomingGames[0]));
const nextWeek = nextKey ? { season: +nextKey.split("|")[0], week: +nextKey.split("|")[1] } : null;
write('meta.json', {
  updated: new Date().toISOString(), current_season: CURRENT_SEASON, next_week: nextWeek, test_from: TEST_FROM,
  game_metrics: gameMetricsOut, player_metrics: playerMetrics, calib,
  importance: { team_points: topImp(teamModelsFinal.points), ...Object.fromEntries(Object.keys(PT).map(k => [k, topImp(pModelsFinal[k])])) },
  counts: { games: games.length, team_rows: teamGames.length, player_rows: playerGames.length, players: index.length },
});
log(`wrote ${index.length} player files, ${projections.length} projections`);
