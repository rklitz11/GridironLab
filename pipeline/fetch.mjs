// Download raw nflverse data. Past seasons are cached forever; current season + live files refresh each run.
import fs from 'node:fs';
import path from 'node:path';
import { RAW, SEASONS, CURRENT_SEASON, SOURCES } from './lib/config.mjs';

fs.mkdirSync(RAW, { recursive: true });
const force = process.argv.includes('--force');

async function get([url, name], { live }) {
  const dest = path.join(RAW, name);
  if (!force && !live && fs.existsSync(dest) && fs.statSync(dest).size > 0) return 'cached';
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) return `HTTP ${res.status}`;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest + '.tmp', buf);
  fs.renameSync(dest + '.tmp', dest);
  return `${(buf.length / 1e6).toFixed(1)} MB`;
}

const jobs = [
  [SOURCES.games(), true], [SOURCES.players(), true],
  [SOURCES.ngsRec(), true], [SOURCES.ngsRush(), true], [SOURCES.ngsPass(), true],
  // current rosters (IR, releases, practice squad) and the daily ESPN depth chart drive who is projected for upcoming games
  [SOURCES.rosterWeekly(CURRENT_SEASON), true], [SOURCES.depthCharts(CURRENT_SEASON), true],
];
for (const s of SEASONS) {
  const live = s === CURRENT_SEASON;
  for (const k of ['stats', 'pbp', 'snaps', 'injuries']) jobs.push([SOURCES[k](s), live]);
  if (s >= 2018) for (const k of ['pfrPass', 'pfrRush', 'pfrRec']) jobs.push([SOURCES[k](s), live]);
}

let i = 0;
async function worker() {
  while (i < jobs.length) {
    const [src, live] = jobs[i++];
    const r = await get(src, { live }).catch(e => `ERR ${e.message}`);
    console.log(`${src[1].padEnd(34)} ${r}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
console.log('fetch complete');
