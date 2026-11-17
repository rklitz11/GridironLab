// Pull kickoff-window weather for every game from Open-Meteo (historical archive + forecast).
// Output: data/cache/weather.json  { game_id: {temp_f, wind_mph, gust_mph, precip_in, snow_in, humidity, source} }
import fs from 'node:fs';
import path from 'node:path';
import { RAW, CACHE, FIRST_SEASON } from './lib/config.mjs';
import { readCsv } from './lib/csv.mjs';
import { STADIUMS } from './lib/stadiums.mjs';

const CACHE_FILE = path.join(CACHE, 'weather.json');
fs.mkdirSync(CACHE, { recursive: true });
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};

const games = readCsv(path.join(RAW, 'games.csv'), { filter: g => +g.season >= FIRST_SEASON });
const today = new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const archiveCutoff = addDays(today, -6);   // archive lags ~5 days
const forecastMax = addDays(today, 15);

// Which games need weather? Completed games: once, from archive. Upcoming/recent: refresh every run.
const need = {};
for (const g of games) {
  if (!STADIUMS[g.stadium_id]) continue;
  const done = cache[g.game_id] && cache[g.game_id].source === 'archive';
  if (done) continue;
  if (g.gameday > forecastMax) continue;
  (need[g.stadium_id] ??= []).push(g);
}

const HOURLY = 'temperature_2m,relative_humidity_2m,precipitation,snowfall,wind_speed_10m,wind_gusts_10m';
async function pull(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (r.status === 429) { await new Promise(res => setTimeout(res, 15000 * (attempt + 1))); continue; }
    throw new Error(`HTTP ${r.status} ${await r.text()}`);
  }
  throw new Error('rate limited');
}

function summarize(h, gameday, gametime) {
  // Average over the ~3.5h game window starting at kickoff (times are in America/New_York, same as nflverse gametime).
  const hr = Math.floor(Number((gametime || '13:00').split(':')[0]));
  const idx = [];
  for (let k = 0; k < 4; k++) {
    let d = gameday, hh = hr + k;
    if (hh >= 24) { d = addDays(gameday, 1); hh -= 24; }
    const i = h.time.indexOf(`${d}T${String(hh).padStart(2, '0')}:00`);
    if (i >= 0) idx.push(i);
  }
  if (!idx.length) return null;
  const avg = k => { const v = idx.map(i => h[k][i]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const sum = k => idx.map(i => h[k][i] ?? 0).reduce((a, b) => a + b, 0);
  const max = k => Math.max(...idx.map(i => h[k][i] ?? 0));
  return {
    temp_f: round(avg('temperature_2m')), humidity: round(avg('relative_humidity_2m')),
    wind_mph: round(avg('wind_speed_10m')), gust_mph: round(max('wind_gusts_10m')),
    precip_in: round(sum('precipitation'), 2), snow_in: round(sum('snowfall') / 2.54, 2),
  };
}
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

const UNITS = '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FNew_York';
let n = 0;
for (const [sid, list] of Object.entries(need)) {
  const [lat, lon] = STADIUMS[sid];
  const past = list.filter(g => g.gameday <= archiveCutoff);
  const recent = list.filter(g => g.gameday > archiveCutoff);
  try {
    if (past.length) {
      const start = past.reduce((m, g) => (g.gameday < m ? g.gameday : m), '9999');
      const end = addDays(past.reduce((m, g) => (g.gameday > m ? g.gameday : m), '0000'), 1);
      const j = await pull(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&hourly=${HOURLY}${UNITS}`);
      for (const g of past) { const s = summarize(j.hourly, g.gameday, g.gametime); if (s) { cache[g.game_id] = { ...s, source: 'archive' }; n++; } }
    }
    if (recent.length) {
      const j = await pull(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&past_days=7&forecast_days=16&hourly=${HOURLY}${UNITS}`);
      for (const g of recent) {
        const s = summarize(j.hourly, g.gameday, g.gametime);
        if (s) { cache[g.game_id] = { ...s, source: g.gameday < today ? 'observed' : 'forecast', fetched: today }; n++; }
      }
    }
    process.stdout.write(`${sid}:${list.length} `);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); // checkpoint so a rate-limit stall never loses progress
  } catch (e) {
    console.warn(`\n${sid} failed: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 300));
}
fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
console.log(`\nweather updated for ${n} games (${Object.keys(cache).length} total cached)`);
const missing = [...new Set(games.filter(g => !STADIUMS[g.stadium_id]).map(g => g.stadium_id + ' ' + g.stadium))];
if (missing.length) console.log('stadiums without coordinates:', missing.join('; '));
