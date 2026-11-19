// Do "confident pick" probabilities hold up? A pick is: player OVER/UNDER his season-to-date average on one stat,
// with P(over) read from the calibrated outcome distribution at the model's projection.
// Calibration is built from 2025 out-of-sample games and scored on 2026, so the test never sees its own outcomes.
// Usage: node pipeline/experiments/picks-exp.mjs   (needs data/out from `npm run model`)
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from '../lib/config.mjs';
import { STATS, buildCalib, distFor, pOver, lineFor } from '../lib/picks.mjs';

const CAL = 2025, TEST = 2026;
const rows = [];
for (const f of fs.readdirSync(path.join(OUT, 'players'))) {
  const p = JSON.parse(fs.readFileSync(path.join(OUT, 'players', f), 'utf8'));
  const log = p.log.filter(g => g.game_type === 'REG' || g.game_type == null);
  for (let i = 0; i < log.length; i++) {
    const g = log[i];
    if (!g.stats || !g.proj || g.season < CAL) continue;
    const prior = log.slice(0, i).filter(h => h.season === g.season && h.stats);
    for (const [k, cfg] of Object.entries(STATS)) {
      if (!cfg.pos.includes(p.pos) || g.proj[k] == null) continue;
      const vals = prior.map(h => h.stats[k] ?? 0);
      rows.push({ season: g.season, game: g.game_id, name: p.name, pos: p.pos, k, pred: g.proj[k], act: g.stats[k] ?? 0,
        n: vals.length, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null });
    }
  }
}
const calib = buildCalib(rows.filter(r => r.season === CAL));
const cand = rows.filter(r => r.season === TEST && r.n >= 3 && r.avg >= STATS[r.k].min).map(r => {
  const line = lineFor(r.avg, r.k);
  const po = pOver(distFor(calib, r.k, r.pred), line);
  const over = po >= 0.5;
  return { ...r, line, over, conf: over ? po : 1 - po, hit: over ? r.act > line : r.act < line };
});
const pct = x => `${(100 * x).toFixed(1)}%`;
console.log(`test picks (2026): ${cand.length}`);
const naiveUnder = cand.filter(c => c.act < c.line).length / cand.length;
console.log(`baseline: always UNDER season avg hits ${pct(naiveUnder)}`);
console.log('\nconfidence bucket   n     claimed   actual');
for (const [lo, hi] of [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.75], [0.75, 1.01]]) {
  const b = cand.filter(c => c.conf >= lo && c.conf < hi);
  if (!b.length) continue;
  console.log(`${pct(lo).padStart(6)}-${pct(Math.min(hi, 1)).padEnd(7)} ${String(b.length).padStart(5)}   ${pct(b.reduce((a, c) => a + c.conf, 0) / b.length).padStart(6)}   ${pct(b.filter(c => c.hit).length / b.length).padStart(6)}`);
}
// top N per game (one pick per player, best stat)
for (const N of [3, 5]) {
  const byGame = {};
  for (const c of cand) (byGame[c.game] ??= []).push(c);
  let n = 0, hit = 0, claimed = 0;
  for (const list of Object.values(byGame)) {
    const best = {};
    for (const c of list) if (!best[c.name] || c.conf > best[c.name].conf) best[c.name] = c;
    const top = Object.values(best).sort((a, b) => b.conf - a.conf).slice(0, N);
    n += top.length; hit += top.filter(c => c.hit).length; claimed += top.reduce((a, c) => a + c.conf, 0);
  }
  console.log(`\ntop ${N} per game: ${n} picks, claimed ${pct(claimed / n)}, hit ${pct(hit / n)}`);
}
const byStat = {};
for (const c of cand.filter(c => c.conf >= 0.62)) (byStat[c.k] ??= []).push(c);
console.log('\nconf >= 62% by stat:');
for (const [k, l] of Object.entries(byStat)) console.log(`  ${k.padEnd(20)} n=${String(l.length).padStart(4)} over=${pct(l.filter(c => c.over).length / l.length)} hit=${pct(l.filter(c => c.hit).length / l.length)}`);

// Does the model add anything beyond skew? Same picks, but the distribution is centred on the season average
// instead of the model's projection (so it only knows "stats are right-skewed").
const skew = rows.filter(r => r.season === TEST && r.n >= 3 && r.avg >= STATS[r.k].min).map(r => {
  const line = lineFor(r.avg, r.k);
  const po = pOver(distFor(calib, r.k, r.avg), line);
  const over = po >= 0.5;
  return { ...r, over, conf: over ? po : 1 - po, hit: over ? r.act > line : r.act < line };
});
for (const [lbl, set] of [['model', cand], ['skew only', skew]]) {
  const byGame = {};
  for (const c of set) (byGame[c.game] ??= []).push(c);
  let n = 0, hit = 0;
  for (const list of Object.values(byGame)) {
    const best = {};
    for (const c of list) if (!best[c.name] || c.conf > best[c.name].conf) best[c.name] = c;
    const top = Object.values(best).sort((a, b) => b.conf - a.conf).slice(0, 4);
    n += top.length; hit += top.filter(c => c.hit).length;
  }
  console.log(`top 4 per game, ${lbl.padEnd(9)}: hit ${pct(hit / n)} (${n})`);
}
const overs = cand.filter(c => c.over && c.conf >= 0.6);
console.log(`model OVER picks >= 60%: n=${overs.length}, claimed ${pct(overs.reduce((a, c) => a + c.conf, 0) / overs.length)}, hit ${pct(overs.filter(c => c.hit).length / overs.length)}`);
