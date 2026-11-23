// Does an explicit "expected share after injuries" feature help? The vacated-opportunity features (vac_car, vac_tgt)
// exist, but in the back-test RBs whose backfield lost 30%+ of its carries got ~1 more carry than projected.
// Variant "opp" adds each player's share re-scaled for the vacated opportunity, and the volume it implies.
// DEV design (same as player-exp): train <=2021, early-stop 2022, score 2023-24; also reports the vacated subset.
import fs from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { predictRow } from '../lib/gbm.mjs';
import { addOppFeatures } from '../lib/opp.mjs';
const pg = JSON.parse(fs.readFileSync(new URL('../../data/cache/player_games.json', import.meta.url))).filter(p => p.done);
for (const p of pg) addOppFeatures(p.features);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const POS = { fantasy_points_ppr: ['QB', 'RB', 'WR', 'TE'], carries: ['QB', 'RB', 'WR'], rushing_yards: ['QB', 'RB', 'WR'], targets: ['RB', 'WR', 'TE'], receiving_yards: ['RB', 'WR', 'TE'], receptions: ['RB', 'WR', 'TE'] };
const POISSON = new Set(['carries', 'targets', 'receptions']);
const SLOW = new Set(['rushing_yards', 'receiving_yards', 'fantasy_points_ppr']);
const NEWF = ['exp_car_share', 'exp_tgt_share', 'exp_carries', 'exp_targets'];
const BASE = Object.keys(pg[0].features).filter(k => k !== 'line_source' && k !== 'td_rate_rz' && !NEWF.includes(k));
const P = { nTrees: 1500, lr: 0.04, maxDepth: 5, minLeaf: 50, lambda: 10, subsample: 0.7, colsample: 0.5, earlyStop: 60 };
const optsFor = k => (POISSON.has(k) ? { ...P, loss: 'poisson' } : SLOW.has(k) ? { ...P, lr: 0.02, nTrees: 3000, earlyStop: 120, minLeaf: 80 } : P);
const only = process.argv[2] ? process.argv[2].split(',') : Object.keys(POS);
const cols = (rows, names) => names.map(n => Float64Array.from(rows, r => r.features[n] ?? NaN));
const jobs = [];
for (const t of only) for (const [v, names] of Object.entries({ base: BASE, opp: [...BASE, ...NEWF] })) jobs.push({ t, v, names });
let i = 0;
const out = [];
await Promise.all(Array.from({ length: Math.min(os.cpus().length - 1, 8) }, async () => {
  while (i < jobs.length) {
    const j = jobs[i++];
    const rows = pg.filter(p => POS[j.t].includes(p.pos));
    const tr = rows.filter(p => p.season <= 2021), va = rows.filter(p => p.season === 2022), dev = rows.filter(p => p.season >= 2023 && p.season <= 2024);
    const model = await new Promise((res, rej) => {
      const w = new Worker(new URL('../lib/gbm-worker.mjs', import.meta.url), { workerData: { cols: cols(tr, j.names), y: Float64Array.from(tr, p => p.actual[j.t]), names: j.names, opts: optsFor(j.t),
        valid: { cols: cols(va, j.names), y: Float64Array.from(va, p => p.actual[j.t]) } } });
      w.once('message', res); w.once('error', rej);
    });
    const ev = dev.map(p => ({ p, pr: Math.max(0, predictRow(model, j.names.map(n => p.features[n] ?? NaN))), a: p.actual[j.t] }));
    const vac = ev.filter(e => (e.p.features.vac_car || 0) + (e.p.features.vac_tgt || 0) >= 0.15);
    out.push({ t: j.t, v: j.v, mae: mean(ev.map(e => Math.abs(e.pr - e.a))), rmse: Math.sqrt(mean(ev.map(e => (e.pr - e.a) ** 2))),
      vn: vac.length, vmae: mean(vac.map(e => Math.abs(e.pr - e.a))), vbias: mean(vac.map(e => e.a - e.pr)) });
  }
}));
out.sort((a, b) => a.t.localeCompare(b.t) || a.v.localeCompare(b.v));
for (const r of out) console.log(r.t.padEnd(18), r.v.padEnd(5), `MAE ${r.mae.toFixed(3)} RMSE ${r.rmse.toFixed(3)} | vacated n=${r.vn} MAE ${r.vmae.toFixed(3)} bias ${r.vbias.toFixed(3)}`);
