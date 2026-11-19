// Is "chance of a rushing or receiving TD" calibrated? P(TD) = 1 - exp(-(proj rush TD + proj rec TD)).
// Scored on 2025-26 games the models never trained on.  Usage: node pipeline/experiments/td-exp.mjs
import path from 'node:path';
import { OUT } from '../lib/config.mjs';
import { loadPlayers } from '../lib/picks.mjs';

const rows = [];
for (const p of loadPlayers(path.join(OUT, 'players'))) for (const g of p.log) {
  if (!g.stats || !g.proj || g.season < 2025 || p.pos === 'QB') continue;
  const lam = (g.proj.rushing_tds || 0) + (g.proj.receiving_tds || 0);
  rows.push({ season: g.season, p: 1 - Math.exp(-lam), td: (g.stats.rushing_tds || 0) + (g.stats.receiving_tds || 0) > 0, week: g.week, game: g.game_id, pos: p.pos });
}
const pct = x => `${(100 * x).toFixed(1)}%`;
for (const s of [2025, 2026]) {
  console.log(`\n${s}  bucket        n    claimed  actual`);
  for (const [lo, hi] of [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 1]]) {
    const b = rows.filter(r => r.season === s && r.p >= lo && r.p < hi);
    if (b.length) console.log(`  ${pct(lo).padStart(6)}-${pct(hi).padEnd(7)} ${String(b.length).padStart(5)}   ${pct(b.reduce((a, r) => a + r.p, 0) / b.length).padStart(6)}  ${pct(b.filter(r => r.td).length / b.length).padStart(6)}`);
  }
  // top 10 per week
  const weeks = {};
  for (const r of rows.filter(r => r.season === s)) (weeks[r.week] ??= []).push(r);
  let n = 0, hit = 0, cl = 0;
  for (const l of Object.values(weeks)) { const t = l.sort((a, b) => b.p - a.p).slice(0, 10); n += t.length; hit += t.filter(r => r.td).length; cl += t.reduce((a, r) => a + r.p, 0); }
  console.log(`  top 10 per week: claimed ${pct(cl / n)}, scored ${pct(hit / n)} (${n} player-games)`);
}
