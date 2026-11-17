// Histogram gradient-boosted regression trees (squared loss) with native missing-value handling.
// Small, dependency-free, deterministic (seeded). Comparable in spirit to LightGBM/XGBoost "hist".

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Build quantile bin edges for each feature. X: array of Float64Array columns. */
function makeBins(cols, maxBins) {
  return cols.map(col => {
    const v = [];
    for (let i = 0; i < col.length; i++) if (!Number.isNaN(col[i])) v.push(col[i]);
    v.sort((a, b) => a - b);
    const uniq = [];
    for (let i = 0; i < v.length; i++) if (i === 0 || v[i] !== v[i - 1]) uniq.push(v[i]);
    if (uniq.length <= maxBins) {
      const edges = [];
      for (let i = 0; i < uniq.length - 1; i++) edges.push((uniq[i] + uniq[i + 1]) / 2);
      return edges;
    }
    const edges = [];
    for (let b = 1; b < maxBins; b++) {
      const q = v[Math.floor((b / maxBins) * (v.length - 1))];
      if (!edges.length || q > edges[edges.length - 1]) edges.push(q);
    }
    return edges;
  });
}

function binValue(edges, x) {
  if (Number.isNaN(x)) return 0;
  let lo = 0, hi = edges.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (x <= edges[m]) hi = m; else lo = m + 1; }
  return lo + 1; // 1..edges.length+1 ; 0 = missing
}

export function train(cols, y, opts = {}) {
  const {
    nTrees = 400, lr = 0.05, maxDepth = 5, minLeaf = 40, lambda = 5, subsample = 0.7, colsample = 0.6,
    maxBins = 48, seed = 7, valid = null, earlyStop = 40, names = null, minGain = 0, loss = 'l2',
  } = opts;
  const pois = loss === 'poisson';
  const n = y.length, F = cols.length;
  const edges = makeBins(cols, maxBins);
  const nb = edges.map(e => e.length + 2);
  const maxNb = Math.max(...nb);
  const B = cols.map((col, f) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = binValue(edges[f], col[i]); return b; });
  let base = 0; for (let i = 0; i < n; i++) base += y[i]; base /= n;
  if (pois) base = Math.log(Math.max(base, 1e-6));
  const pred = new Float64Array(n).fill(base);
  const grad = new Float64Array(n), hess = new Float64Array(n).fill(1);
  const rand = rng(seed);
  const trees = [];
  const gain = new Float64Array(F);

  let vB = null, vPred = null, best = Infinity, bestIter = 0, vy = null;
  if (valid) {
    vy = valid.y;
    vB = valid.cols.map((col, f) => { const b = new Uint8Array(vy.length); for (let i = 0; i < vy.length; i++) b[i] = binValue(edges[f], col[i]); return b; });
    vPred = new Float64Array(vy.length).fill(base);
  }

  const histG = new Float64Array(F * maxNb), histN = new Float64Array(F * maxNb), histH = new Float64Array(F * maxNb);
  function buildHist(idx, feats) {
    for (const f of feats) {
      const off = f * maxNb, bf = B[f];
      for (let j = 0; j < nb[f]; j++) { histG[off + j] = 0; histN[off + j] = 0; histH[off + j] = 0; }
      for (let k = 0; k < idx.length; k++) { const i = idx[k]; const b = bf[i]; histG[off + b] += grad[i]; histN[off + b] += 1; histH[off + b] += hess[i]; }
    }
  }

  for (let t = 0; t < nTrees; t++) {
    if (pois) for (let i = 0; i < n; i++) { const mu = Math.exp(pred[i]); grad[i] = y[i] - mu; hess[i] = Math.max(mu, 1e-6); }
    else for (let i = 0; i < n; i++) grad[i] = y[i] - pred[i]; // negative gradient
    const rows = [];
    for (let i = 0; i < n; i++) if (rand() < subsample) rows.push(i);
    const feats = [];
    for (let f = 0; f < F; f++) if (rand() < colsample) feats.push(f);
    if (!feats.length) feats.push(Math.floor(rand() * F));

    const nodes = []; // {f, bin, missLeft, left, right, value}
    // stack-based growth
    const root = { idx: Int32Array.from(rows), depth: 0, id: 0 };
    nodes.push(null);
    const queue = [root];
    while (queue.length) {
      const node = queue.pop();
      const idx = node.idx;
      let G = 0, H = 0; for (let k = 0; k < idx.length; k++) { G += grad[idx[k]]; H += hess[idx[k]]; }
      const N = idx.length;
      // Poisson works on the log scale with hessian-weighted sums, so it needs a lighter penalty and a step cap
      const lam = pois ? lambda * 0.1 : lambda;
      const leafVal = pois ? Math.max(-3, Math.min(3, G / (H + lam))) : G / (H + lam);
      if (node.depth >= maxDepth || N < 2 * minLeaf) { nodes[node.id] = { value: leafVal * lr }; continue; }
      buildHist(idx, feats);
      const parentScore = (G * G) / (H + lam);
      let bestGain = minGain, bf = -1, bbin = 0, bMissLeft = false;
      for (const f of feats) {
        const off = f * maxNb;
        const gm = histG[off], nm = histN[off], hm = histH[off];
        let gl = 0, nl = 0, hl = 0;
        for (let b = 1; b < nb[f] - 1; b++) {
          gl += histG[off + b]; nl += histN[off + b]; hl += histH[off + b];
          // missing → right
          const nr = N - nl - nm, gr = G - gl - gm, hr = H - hl - hm;
          if (nl >= minLeaf && nr + nm >= minLeaf) {
            const s = (gl * gl) / (hl + lam) + ((gr + gm) * (gr + gm)) / (hr + hm + lam) - parentScore;
            if (s > bestGain) { bestGain = s; bf = f; bbin = b; bMissLeft = false; }
          }
          if (nm > 0 && nl + nm >= minLeaf && nr >= minLeaf) {
            const s = ((gl + gm) * (gl + gm)) / (hl + hm + lam) + (gr * gr) / (hr + lam) - parentScore;
            if (s > bestGain) { bestGain = s; bf = f; bbin = b; bMissLeft = true; }
          }
        }
      }
      if (bf < 0) { nodes[node.id] = { value: leafVal * lr }; continue; }
      gain[bf] += bestGain;
      const L = [], R = [];
      const bfArr = B[bf];
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k], b = bfArr[i];
        if (b === 0 ? bMissLeft : b <= bbin) L.push(i); else R.push(i);
      }
      const lid = nodes.length, rid = nodes.length + 1;
      nodes.push(null, null);
      nodes[node.id] = { f: bf, thr: edges[bf][bbin - 1], bin: bbin, missLeft: bMissLeft, left: lid, right: rid };
      queue.push({ idx: Int32Array.from(L), depth: node.depth + 1, id: lid });
      queue.push({ idx: Int32Array.from(R), depth: node.depth + 1, id: rid });
    }
    trees.push(nodes);
    // update predictions (binned traversal)
    for (let i = 0; i < n; i++) pred[i] += walkBinned(nodes, B, i);
    if (valid) {
      let se = 0;
      for (let i = 0; i < vy.length; i++) { vPred[i] += walkBinned(nodes, vB, i); const d = vy[i] - (pois ? Math.exp(vPred[i]) : vPred[i]); se += d * d; }
      const mse = se / vy.length;
      if (mse < best - 1e-9) { best = mse; bestIter = t + 1; }
      else if (t + 1 - bestIter >= earlyStop) break;
    }
  }
  const finalTrees = valid ? trees.slice(0, bestIter) : trees;
  const imp = {};
  const tot = gain.reduce((a, b) => a + b, 0) || 1;
  (names || cols.map((_, i) => `f${i}`)).forEach((nm, i) => { if (gain[i] > 0) imp[nm] = gain[i] / tot; });
  return { loss, base, trees: finalTrees.map(compact), bestIter: valid ? bestIter : trees.length, validMse: valid ? best : null, importance: imp };
}

function walkBinned(nodes, B, i) {
  let k = 0;
  for (;;) {
    const nd = nodes[k];
    if (nd.value !== undefined) return nd.value;
    const b = B[nd.f][i];
    k = (b === 0 ? nd.missLeft : b <= nd.bin) ? nd.left : nd.right;
  }
}

function compact(nodes) {
  return nodes.map(nd => (nd.value !== undefined ? { v: nd.value } : { f: nd.f, t: nd.thr, m: nd.missLeft ? 1 : 0, l: nd.left, r: nd.right }));
}

export function predictRow(model, x) {
  let s = model.base;
  for (const nodes of model.trees) {
    let k = 0;
    for (;;) {
      const nd = nodes[k];
      if (nd.v !== undefined) { s += nd.v; break; }
      const v = x[nd.f];
      k = (Number.isNaN(v) || v == null ? nd.m === 1 : v <= nd.t) ? nd.l : nd.r;
    }
  }
  return model.loss === 'poisson' ? Math.exp(s) : s;
}
