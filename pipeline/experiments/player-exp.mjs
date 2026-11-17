// Player-model experiments on DEV seasons (train ≤2021, early-stop 2022, score 2023-24).
import fs from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { predictRow } from '../lib/gbm.mjs';
const pg = JSON.parse(fs.readFileSync(new URL('../../data/cache/player_games.json', import.meta.url))).filter(p => p.done);
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const POS = { fantasy_points_ppr: ['QB', 'RB', 'WR', 'TE'], passing_yards: ['QB'], passing_tds: ['QB'], rushing_yards: ['QB', 'RB', 'WR'], carries: ['QB', 'RB', 'WR'],
  rushing_tds: ['QB', 'RB', 'WR'], targets: ['RB', 'WR', 'TE'], receiving_yards: ['RB', 'WR', 'TE'], receiving_tds: ['RB', 'WR', 'TE'] };
const only = process.argv[2] ? process.argv[2].split(',') : Object.keys(POS);
const ALL = Object.keys(pg[0].features).filter(k => k !== 'line_source' && k !== 'td_rate_rz');
const NEW = k => /adj|qb_epa|qb_cpoe|qb_db|rz_|gl_|ez_|deep_/.test(k);
const OLD = ALL.filter(k => !NEW(k));
const P = { nTrees: 1500, lr: 0.04, maxDepth: 5, minLeaf: 50, lambda: 10, subsample: 0.7, colsample: 0.5, earlyStop: 60 };
const VARIANTS = process.env.BAG ? { s1: [ALL, { ...P, lr: 0.02, nTrees: 3000, earlyStop: 120, minLeaf: 80, seed: 1 }], s2: [ALL, { ...P, lr: 0.02, nTrees: 3000, earlyStop: 120, minLeaf: 80, seed: 2, colsample: 0.4 }], s3: [ALL, { ...P, lr: 0.02, nTrees: 3000, earlyStop: 120, minLeaf: 80, seed: 3, subsample: 0.6 }] } : { old: [OLD, P], new: [ALL, P], 'new-poisson': [ALL, { ...P, loss: 'poisson' }], 'new-slow': [ALL, { ...P, lr: 0.02, nTrees: 3000, earlyStop: 120, minLeaf: 80 }] };
const cols = (rows, names) => names.map(n => Float64Array.from(rows, r => r.features[n] ?? NaN));
const jobs = [];
for (const t of only) for (const [v, [names, opts]] of Object.entries(VARIANTS)) {
  if (v === 'new-poisson' && /yards|fantasy/.test(t)) continue;
  jobs.push({ t, v, names, opts });
}
let i = 0;
const results = [];
await Promise.all(Array.from({ length: Math.min(os.cpus().length - 1, 8) }, async () => {
  while (i < jobs.length) {
    const j = jobs[i++];
    const rows = pg.filter(p => POS[j.t].includes(p.pos));
    const tr = rows.filter(p => p.season <= 2021), va = rows.filter(p => p.season === 2022), dev = rows.filter(p => p.season >= 2023 && p.season <= 2024);
    const model = await new Promise((res, rej) => {
      const w = new Worker(new URL('../lib/gbm-worker.mjs', import.meta.url), { workerData: { cols: cols(tr, j.names), y: Float64Array.from(tr, p => p.actual[j.t]), names: j.names, opts: j.opts,
        valid: { cols: cols(va, j.names), y: Float64Array.from(va, p => p.actual[j.t]) } } });
      w.once('message', res); w.once('error', rej);
    });
    const pr = dev.map(p => Math.max(0, predictRow(model, j.names.map(n => p.features[n] ?? NaN))));
    const a = dev.map(p => p.actual[j.t]);
    (globalThis.PR ??= {})[j.t] ??= { a, p: [] }; globalThis.PR[j.t].p.push(pr);
    results.push({ t: j.t, v: j.v, trees: model.trees.length, mae: mean(pr.map((x, k) => Math.abs(x - a[k]))), rmse: Math.sqrt(mean(pr.map((x, k) => (x - a[k]) ** 2))) });
  }
}));
results.sort((a, b) => a.t.localeCompare(b.t) || a.rmse - b.rmse);
for (const r of results) console.log(r.t.padEnd(20), r.v.padEnd(12), `trees ${String(r.trees).padStart(4)}  MAE ${r.mae.toFixed(3)}  RMSE ${r.rmse.toFixed(3)}`);

if (process.env.BAG) for (const [t, { a, p }] of Object.entries(globalThis.PR)) {
  const avg = a.map((_, k) => mean(p.map(x => x[k])));
  console.log(t.padEnd(20), 'BAG of', p.length, `MAE ${mean(avg.map((x, k) => Math.abs(x - a[k]))).toFixed(3)}  RMSE ${Math.sqrt(mean(avg.map((x, k) => (x - a[k]) ** 2))).toFixed(3)}`);
}
