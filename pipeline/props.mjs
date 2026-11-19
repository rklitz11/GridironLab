// Hard Rock Bet player-prop lines from The Odds API, sized for the free tier (500 credits a month).
// Each game is pulled once, by the first refresh inside the PROPS_WINDOW_HOURS before its kickoff, and saved to
// data/cache/props/<game_id>.json (committed, so a game is never paid for twice). One pull = 1 credit per market.
// Needs ODDS_API_KEY in the environment or in a .env file at the repo root; without it this step is skipped.
// Usage: node pipeline/props.mjs [--game 2026_11_IND_HOU]   (--game pulls that game now, ignoring the window)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CACHE } from './lib/config.mjs';

// In priority order: each pull takes as many as the month's credit budget allows (1 credit per market per game).
export const MARKETS = {
  player_pass_yds: 'passing_yards',
  player_rush_yds: 'rushing_yards',
  player_reception_yds: 'receiving_yards',
  player_receptions: 'receptions',
  player_anytime_td: 'anytime_td', // Sunday and Monday games only (feeds the weekly Best TD chances list)
  player_rush_attempts: 'carries',
  player_pass_completions: 'completions',
  player_pass_attempts: 'attempts',
};
const MIN_MARKETS = 3;
const BOOK = 'hardrockbet';
const WINDOW_H = +(process.env.PROPS_WINDOW_HOURS || 3);
const RESERVE = 25; // stop pulling when this few credits remain

const TEAMS = {
  'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL', 'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR',
  'Chicago Bears': 'CHI', 'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL', 'Denver Broncos': 'DEN',
  'Detroit Lions': 'DET', 'Green Bay Packers': 'GB', 'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAX',
  'Kansas City Chiefs': 'KC', 'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC', 'Los Angeles Rams': 'LA', 'Miami Dolphins': 'MIA',
  'Minnesota Vikings': 'MIN', 'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG', 'New York Jets': 'NYJ',
  'Philadelphia Eagles': 'PHI', 'Pittsburgh Steelers': 'PIT', 'San Francisco 49ers': 'SF', 'Seattle Seahawks': 'SEA',
  'Tampa Bay Buccaneers': 'TB', 'Tennessee Titans': 'TEN', 'Washington Commanders': 'WAS',
};

function apiKey() {
  if (process.env.ODDS_API_KEY) return process.env.ODDS_API_KEY;
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return null;
  const m = fs.readFileSync(f, 'utf8').match(/^ODDS_API_KEY=(.+)$/m);
  return m ? m[1].trim() : null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const key = apiKey();
  if (!key) { console.log('props: no ODDS_API_KEY, skipping'); process.exit(0); }
  const dir = path.join(CACHE, 'props');
  fs.mkdirSync(dir, { recursive: true });
  const only = process.argv.includes('--game') ? process.argv[process.argv.indexOf('--game') + 1] : null;
  const games = JSON.parse(fs.readFileSync(path.join(CACHE, 'games.json'), 'utf8'));
  // kickoff as a UTC instant: gameday + gametime are US Eastern
  const kickoff = g => {
    const probe = new Date(`${g.gameday}T12:00:00Z`);
    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(probe).find(p => p.type === 'timeZoneName').value;
    const off = +(et.match(/GMT([+-]\d+)/)?.[1] ?? -5);
    return Date.parse(`${g.gameday}T${g.gametime || '13:00'}:00Z`) - off * 3600e3;
  };
  const now = Date.now();
  const due = games.filter(g => {
    if (fs.existsSync(path.join(dir, `${g.game_id}.json`))) return false;
    if (only) return g.game_id === only;
    const t = kickoff(g);
    return !g.done && t > now && t - now <= WINDOW_H * 3600e3;
  });
  if (!due.length) { console.log(`props: no games kicking off in the next ${WINDOW_H}h without saved lines`); process.exit(0); }

  const base = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl';
  const res = await fetch(`${base}/events?apiKey=${key}`); // free: does not use credits
  if (!res.ok) { console.log(`props: events request failed (HTTP ${res.status}), skipping`); process.exit(0); }
  let remaining = +(res.headers.get('x-requests-remaining') ?? NaN);
  const events = await res.json();
  // Spread this month's credits over the games still to come this month (credits reset monthly), so the plan uses
  // the whole allowance instead of a fixed number of markets. The reserve is never touched.
  const ym = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).format(t);
  const thisMonth = ym(now);
  const gamesLeft = games.filter(g => !g.done && kickoff(g) > now && ym(kickoff(g)) === thisMonth && !fs.existsSync(path.join(dir, `${g.game_id}.json`))).length || due.length;
  const perGame = Number.isFinite(remaining) ? Math.floor((remaining - RESERVE) / gamesLeft) : MIN_MARKETS;
  const nMarkets = Math.max(MIN_MARKETS, Math.min(Object.keys(MARKETS).length, perGame));
  const marketsFor = g => Object.keys(MARKETS).filter(m => m !== 'player_anytime_td' || ['Sunday', 'Monday'].includes(g.weekday)).slice(0, nMarkets);
  console.log(`props: ${remaining} credits left, ${gamesLeft} games left this month -> ${nMarkets} markets per game`);
  for (const g of due) {
    const markets = marketsFor(g), cost = markets.length;
    if (Number.isFinite(remaining) && remaining - cost < RESERVE) { console.log(`props: ${remaining} credits left, keeping ${RESERVE} in reserve; skipping ${g.game_id}`); break; }
    const ev = events.find(e => TEAMS[e.home_team] === g.home && TEAMS[e.away_team] === g.away);
    if (!ev) { console.log(`props: ${g.game_id} not listed by the API yet`); continue; }
    const r = await fetch(`${base}/events/${ev.id}/odds?apiKey=${key}&bookmakers=${BOOK}&markets=${markets.join(',')}&oddsFormat=american`);
    remaining = +(r.headers.get('x-requests-remaining') ?? remaining);
    if (!r.ok) { console.log(`props: ${g.game_id} odds request failed (HTTP ${r.status})`); continue; }
    const body = await r.json();
    const book = (body.bookmakers || []).find(b => b.key === BOOK);
    if (!book?.markets?.length) { console.log(`props: Hard Rock has no props posted for ${g.game_id} yet`); continue; }
    // one row per player line: over and under prices side by side
    const lines = {}, td = [];
    for (const m of book.markets) for (const o of m.outcomes) {
      if (m.key === 'player_anytime_td') { if (o.name === 'Yes' || o.name === 'Over') td.push({ player: o.description, price: o.price }); continue; }
      const id = `${m.key}|${o.description}|${o.point}`;
      const row = (lines[id] ??= { market: m.key, stat: MARKETS[m.key], player: o.description, line: o.point });
      row[o.name === 'Over' ? 'over' : 'under'] = o.price;
    }
    const out = { game_id: g.game_id, event_id: ev.id, book: BOOK, fetched_at: new Date().toISOString(), lines: Object.values(lines).filter(l => l.over != null && l.under != null), td };
    fs.writeFileSync(path.join(dir, `${g.game_id}.json`), JSON.stringify(out, null, 1));
    console.log(`props: saved ${out.lines.length} Hard Rock lines and ${td.length} anytime-TD prices for ${g.game_id} (${remaining} credits left this month)`);
  }
}
