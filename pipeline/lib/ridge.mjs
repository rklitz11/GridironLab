// Ridge regression with standardization and mean-imputation of missing values.
export function trainRidge(cols, y, { lambda = 10 } = {}) {
  const n = y.length, F = cols.length;
  const mu = new Float64Array(F), sd = new Float64Array(F);
  for (let f = 0; f < F; f++) {
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) if (!Number.isNaN(cols[f][i])) { s += cols[f][i]; c++; }
    mu[f] = c ? s / c : 0;
    let v = 0;
    for (let i = 0; i < n; i++) { const x = Number.isNaN(cols[f][i]) ? mu[f] : cols[f][i]; v += (x - mu[f]) ** 2; }
    sd[f] = Math.sqrt(v / n) || 1;
  }
  const Z = cols.map((c, f) => Float64Array.from(c, x => ((Number.isNaN(x) ? mu[f] : x) - mu[f]) / sd[f]));
  let ym = 0; for (let i = 0; i < n; i++) ym += y[i]; ym /= n;
  // normal equations (Z'Z + λI) w = Z'(y - ȳ)
  const A = Array.from({ length: F }, () => new Float64Array(F + 1));
  for (let a = 0; a < F; a++) {
    for (let b = a; b < F; b++) { let s = 0; const za = Z[a], zb = Z[b]; for (let i = 0; i < n; i++) s += za[i] * zb[i]; A[a][b] = s; A[b][a] = s; }
    A[a][a] += lambda;
    let s = 0; for (let i = 0; i < n; i++) s += Z[a][i] * (y[i] - ym); A[a][F] = s;
  }
  for (let c = 0; c < F; c++) { // Gaussian elimination with partial pivoting
    let p = c; for (let r = c + 1; r < F; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < F; r++) if (r !== c) { const m = A[r][c] / A[c][c]; if (m) for (let k = c; k <= F; k++) A[r][k] -= m * A[c][k]; }
  }
  const w = Array.from({ length: F }, (_, f) => A[f][F] / A[f][f]);
  return { kind: 'ridge', mu: [...mu], sd: [...sd], w, b: ym };
}
export function predictRidge(m, x) {
  let s = m.b;
  for (let f = 0; f < m.w.length; f++) { const v = x[f] == null || Number.isNaN(x[f]) ? m.mu[f] : x[f]; s += m.w[f] * (v - m.mu[f]) / m.sd[f]; }
  return s;
}
