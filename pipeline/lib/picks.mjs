import fs from 'node:fs';
import path from 'node:path';
// Confident picks: a player's projected stat against his season-to-date average, as an OVER/UNDER with a probability.
// The probability comes from an empirical outcome distribution: out-of-sample games are bucketed by projection and
// the spread of actual results in the bucket around the projection is reused for new projections.

// stats worth a pick, the positions they apply to, and the smallest season average that makes the pick meaningful
export const STATS = {
  passing_yards: { pos: ['QB'], min: 150, label: 'pass yds' },
  completions: { pos: ['QB'], min: 14, label: 'completions' },
  rushing_yards: { pos: ['QB', 'RB'], min: 25, label: 'rush yds' },
  carries: { pos: ['RB'], min: 8, label: 'carries' },
  receiving_yards: { pos: ['RB', 'WR', 'TE'], min: 25, label: 'rec yds' },
  receptions: { pos: ['RB', 'WR', 'TE'], min: 2.5, label: 'receptions' },
  fantasy_points_ppr: { pos: ['QB', 'RB', 'WR', 'TE'], min: 8, label: 'PPR pts' },
};

const NB = 10;
/** rows: [{k, pred, act}] out-of-sample. Returns {k: [{pred, resid: sorted actual/pred ratios}]} */
export function buildCalib(rows) {
  const out = {};
  for (const k of Object.keys(STATS)) {
    const ev = rows.filter(r => r.k === k && r.pred > 0).sort((a, b) => a.pred - b.pred);
    const bins = [];
    for (let b = 0; b < NB; b++) {
      const c = ev.slice(Math.floor((b * ev.length) / NB), Math.floor(((b + 1) * ev.length) / NB));
      if (c.length < 30) continue;
      bins.push({ pred: c.reduce((a, r) => a + r.pred, 0) / c.length, ratio: c.map(r => r.act / r.pred).sort((x, y) => x - y) });
    }
    out[k] = bins;
  }
  return out;
}

/** Outcome sample for a projection: the nearest bucket's actual/projection ratios scaled to this projection. */
export function distFor(calib, k, pred) {
  const bins = calib[k];
  if (!bins?.length || !(pred > 0)) return [0];
  let best = bins[0];
  for (const b of bins) if (Math.abs(b.pred - pred) < Math.abs(best.pred - pred)) best = b;
  return best.ratio.map(r => r * pred);
}

export const pOver = (dist, line) => dist.filter(v => v > line).length / dist.length;

/** Betting-style half-point line at the season average, so a pick can never push. */
export const lineFor = (avg, k) => (k === 'fantasy_points_ppr' ? Math.round(avg * 2) / 2 + (Number.isInteger(Math.round(avg * 2) / 2) ? 0.5 : 0) : Math.floor(avg) + 0.5);

// The back-test showed claimed probabilities run 2-5 points hot, so shown confidence is pulled toward 50%.
export const SHRINK = 0.85;
const shrink = c => 0.5 + (c - 0.5) * SHRINK;

/** Every player's game log (from data/out/players). */
export function loadPlayers(dir) {
  return fs.readdirSync(dir).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

/** Out-of-sample rows for calibration: finished games in seasons >= fromSeason that have a projection. */
export function calibRows(players, fromSeason, toSeason = Infinity) {
  const rows = [];
  for (const p of players) for (const g of p.log) {
    if (!g.stats || !g.proj || g.season < fromSeason || g.season > toSeason) continue;
    for (const [k, cfg] of Object.entries(STATS)) if (cfg.pos.includes(p.pos) && g.proj[k] != null) rows.push({ k, pred: g.proj[k], act: g.stats[k] ?? 0 });
  }
  return rows;
}

/**
 * Picks for every player-game in `season` that `want(game)` accepts: each player's most confident OVER/UNDER against
 * his season-to-date average (3+ games), then the top 3-5 per game. Players listed with an injury are skipped,
 * since a pick on them is really a bet on whether they play.
 */
export function buildPicks(players, calib, season, want) {
  const byGame = {};
  for (const p of players) {
    const log = p.log.filter(g => g.season === season);
    for (let i = 0; i < log.length; i++) {
      const g = log[i];
      if (!g.proj || !want(g) || (!g.stats && g.injury)) continue;
      const prior = log.slice(0, i).filter(h => h.stats);
      if (prior.length < 3) continue;
      let best = null;
      for (const [k, cfg] of Object.entries(STATS)) {
        if (!cfg.pos.includes(p.pos) || g.proj[k] == null) continue;
        const avg = prior.reduce((a, h) => a + (h.stats[k] ?? 0), 0) / prior.length;
        if (avg < cfg.min) continue;
        const line = lineFor(avg, k);
        const po = pOver(distFor(calib, k, g.proj[k]), line);
        const over = po >= 0.5, conf = shrink(over ? po : 1 - po);
        if (!best || conf > best.conf) best = { k, label: cfg.label, line, avg, proj: g.proj[k], over, conf };
      }
      if (!best) continue;
      const pick = { gsis: p.gsis, name: p.name, pos: p.pos, team: g.team, games: prior.length, ...best };
      if (g.stats) { pick.act = g.stats[best.k] ?? 0; pick.hit = best.over ? pick.act > best.line : pick.act < best.line; }
      (byGame[g.game_id] ??= []).push(pick);
    }
  }
  for (const [id, list] of Object.entries(byGame)) {
    list.sort((a, b) => b.conf - a.conf);
    const strong = list.filter(c => c.conf >= 0.6);
    byGame[id] = (strong.length >= 3 ? strong : list).slice(0, 5);
  }
  return byGame;
}
