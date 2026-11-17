// Minimal, fast CSV reader (RFC4180 quoting, no embedded newlines needed but supported).
import fs from 'node:fs';
import zlib from 'node:zlib';

function parseLine(line, out) {
  out.length = 0;
  let i = 0, n = line.length;
  while (i <= n) {
    if (line.charCodeAt(i) === 34) { // quoted
      let s = '', j = i + 1;
      for (;;) {
        const q = line.indexOf('"', j);
        if (q === -1) { s += line.slice(j); i = n + 1; break; }
        s += line.slice(j, q);
        if (line.charCodeAt(q + 1) === 34) { s += '"'; j = q + 2; continue; }
        i = q + 2; // skip quote + comma
        break;
      }
      out.push(s);
    } else {
      let c = line.indexOf(',', i);
      if (c === -1) c = n;
      out.push(line.slice(i, c));
      i = c + 1;
    }
  }
  return out;
}

function quotesBalanced(s) {
  let c = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 34) c++;
  return c % 2 === 0;
}

/** Read a CSV (optionally .gz) into array of objects. `columns` optionally restricts kept columns. */
export function readCsv(file, { columns = null, filter = null } = {}) {
  let buf = fs.readFileSync(file);
  if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  const text = buf.toString('utf8');
  const rows = [];
  let pos = 0;
  const nextLine = () => {
    if (pos >= text.length) return null;
    let e = text.indexOf('\n', pos);
    if (e === -1) e = text.length;
    let line = text.slice(pos, e);
    pos = e + 1;
    while (!quotesBalanced(line) && pos < text.length) {
      let e2 = text.indexOf('\n', pos);
      if (e2 === -1) e2 = text.length;
      line += '\n' + text.slice(pos, e2);
      pos = e2 + 1;
    }
    if (line.endsWith('\r')) line = line.slice(0, -1);
    return line;
  };
  const header = parseLine(nextLine().replace(/^﻿/, ''), []).slice();
  const keep = columns ? header.map((h, i) => (columns.includes(h) ? i : -1)).filter(i => i >= 0) : header.map((_, i) => i);
  const vals = [];
  let line;
  while ((line = nextLine()) !== null) {
    if (!line) continue;
    parseLine(line, vals);
    const o = {};
    for (const i of keep) {
      const v = vals[i];
      o[header[i]] = v === undefined || v === '' || v === 'NA' ? null : v;
    }
    if (!filter || filter(o)) rows.push(o);
  }
  return rows;
}

export const num = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(+v) ? +v : null));
