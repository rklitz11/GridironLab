// Game-model experiments on DEV seasons (2023-24). 2025+ stays untouched for the final test.
import fs from 'node:fs';
import { train, predictRow } from '../lib/gbm.mjs';
import { trainRidge, predictRidge } from '../lib/ridge.mjs';
const tg = JSON.parse(fs.readFileSync(new URL('../../data/cache/team_games.json', import.meta.url)));
const games = JSON.parse(fs.readFileSync(new URL('../../data/cache/games.json', import.meta.url)));
const G = Object.fromEntries(games.map(g => [g.game_id, g]));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const MARKET = new Set(['spread', 'total', 'implied', 'opp_implied']);
const done = tg.filter(t => t.done && t.target != null);
const TR = done.filter(t => t.season <= 2021), VA = done.filter(t => t.season === 2022), DEV = done.filter(t => t.season >= 2023 && t.season <= 2024);
const ALL = Object.keys(tg[0].features).filter(k => !MARKET.has(k));
const NEW = k => /adj|qb_epa|qb_cpoe|qb_db/.test(k);
const cols = (rows, names) => names.map(n => Float64Array.from(rows, r => r.features[n] ?? NaN));
const vec = (r, names) => names.map(n => r.features[n] ?? NaN);

function evalPreds(pred) { // pred: Map row -> points
  const by = {};
  for (const r of DEV) (by[r.game_id] ??= {})[G[r.game_id].home === r.team ? 'h' : 'a'] = pred.get(r);
  const e = Object.entries(by).filter(([, v]) => v.h != null && v.a != null).map(([id, v]) => ({ g: G[id], pm: v.h - v.a, pt: v.h + v.a }));
  const am = x => x.g.home_score - x.g.away_score, at = x => x.g.home_score + x.g.away_score;
  return { margin: mean(e.map(x => Math.abs(am(x) - x.pm))), total: mean(e.map(x => Math.abs(at(x) - x.pt))),
    vmargin: mean(e.filter(x => x.g.spread_line != null).map(x => Math.abs(am(x) - x.g.spread_line))),
    vtotal: mean(e.filter(x => x.g.total_line != null).map(x => Math.abs(at(x) - x.g.total_line))),
    pts: mean(DEV.map(r => Math.abs(r.target - pred.get(r)))) };
}
const fmt = o => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(3)}`).join('  ');

function gbm(names, opts) {
  const m = train(cols(TR, names), Float64Array.from(TR, r => r.target), { ...opts, valid: { cols: cols(VA, names), y: Float64Array.from(VA, r => r.target) } });
  return new Map(DEV.map(r => [r, predictRow(m, vec(r, names))]));
}
function ridge(names, lambda) {
  const rows = [...TR, ...VA];
  const m = trainRidge(cols(rows, names), Float64Array.from(rows, r => r.target), { lambda });
  return new Map(DEV.map(r => [r, predictRidge(m, vec(r, names))]));
}
const base = { nTrees: 2000, lr: 0.02, maxDepth: 3, minLeaf: 60, lambda: 20, subsample: 0.7, colsample: 0.5, earlyStop: 150 };
const OLD = ALL.filter(k => !NEW(k));
const res = {};
const run = (name, p) => { res[name] = p; console.log(name.padEnd(28), fmt(evalPreds(p))); };
run('gbm old features', gbm(OLD, base));
run('gbm all features', gbm(ALL, base));
run('gbm all depth2', gbm(ALL, { ...base, maxDepth: 2 }));
run('gbm all depth4 leaf100', gbm(ALL, { ...base, maxDepth: 4, minLeaf: 100 }));
const CORE = ['is_home', 'neutral', 'div_game', 'rest_diff', 'travel_mi', 'tz_shift', 'body_clock', 'indoor', 'wind', 'temp', 'precip', 'elev', 'qb_change', 'opp_qb_change',
  'qb_epa', 'qb_cpoe', 'opp_qb_epa', 'off_adj_pts', 'off_adj_epa', 'off_adj_pass_epa', 'off_adj_rush_epa', 'off_adj_success', 'off_pf', 'off_epa_play', 'off_pts_drive', 'off_plays', 'off_sec_per_play', 'off_proe', 'off_to_rate', 'off_explosive', 'off_rz_td',
  'oppdef_adj_pts', 'oppdef_adj_epa', 'oppdef_adj_pass_epa', 'oppdef_adj_rush_epa', 'oppdef_adj_success', 'oppdef_pa', 'oppdef_epa_play', 'oppdef_to_rate', 'oppdef_explosive',
  'oppoff_sec_per_play', 'oppoff_plays', 'def_adj_epa', 'oppoff_adj_epa', 'games_played', 'week', 'playoff'];
for (const l of [30, 100, 300, 1000]) run(`ridge core λ${l}`, ridge(CORE.filter(k => ALL.includes(k)), l));
const LT = ['ltoff_adj_pts', 'ltoff_adj_epa', 'ltoff_adj_pass_epa', 'ltoff_adj_rush_epa', 'ltoff_adj_success', 'ltoppdef_adj_pts', 'ltoppdef_adj_epa', 'ltoppdef_adj_pass_epa', 'ltoppdef_adj_rush_epa', 'ltoppdef_adj_success'];
for (const l of [100, 300, 1000]) run(`ridge core+LT λ${l}`, ridge([...CORE, ...LT].filter(k => ALL.includes(k)), l));
run('gbm all+LT', gbm(ALL, { ...base, maxDepth: 2 }));
for (const w of [0.3, 0.5, 0.7]) {
  const a = res['gbm all+LT'], b = res['ridge core+LT λ300'];
  run(`blend gbm ${w} / ridge`, new Map(DEV.map(r => [r, w * a.get(r) + (1 - w) * b.get(r)])));
}

