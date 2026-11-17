// Feature engineering: joins schedule, play-by-play, player stats, snaps, injuries, Next Gen Stats,
// PFR advanced stats and weather into (a) team-game rows and (b) player-game rows.
// Every rolling feature uses ONLY games played before the row's kickoff (no leakage).
import fs from 'node:fs';
import path from 'node:path';
import { RAW, CACHE, SEASONS, FIRST_SEASON } from './lib/config.mjs';
import { readCsv, num } from './lib/csv.mjs';
import { stadiumInfo, haversineMiles } from './lib/stadiums.mjs';

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const exists = f => fs.existsSync(path.join(RAW, f));
const r1 = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// ---------------------------------------------------------------- schedule + context
const weather = fs.existsSync(path.join(CACHE, 'weather.json')) ? JSON.parse(fs.readFileSync(path.join(CACHE, 'weather.json'), 'utf8')) : {};
const gamesRaw = readCsv(path.join(RAW, 'games.csv'), { filter: g => +g.season >= FIRST_SEASON });
const NORM_TEAM = { OAK: 'LV', SD: 'LAC', STL: 'LA' }; // franchise continuity
const nt = t => NORM_TEAM[t] || t;

// team home stadium per season (most common home venue)
const homeVenue = {};
for (const g of gamesRaw) {
  if (g.location !== 'Home') continue;
  const k = `${g.season}|${nt(g.home_team)}`;
  (homeVenue[k] ??= {})[g.stadium_id] = (homeVenue[k][g.stadium_id] || 0) + 1;
}
const teamHome = (season, team) => {
  const m = homeVenue[`${season}|${team}`] || homeVenue[`${season - 1}|${team}`];
  if (!m) return null;
  return stadiumInfo(Object.entries(m).sort((a, b) => b[1] - a[1])[0][0]);
};

// surfaces are often blank for the current season: carry forward the stadium's last known surface
const lastSurface = {};
for (const g of [...gamesRaw].sort((a, b) => (a.gameday < b.gameday ? -1 : 1))) if (g.surface) lastSurface[g.stadium_id] = g.surface;
// roof is blank for future games: use the venue's most common roof state in recent seasons
const roofCount = {};
for (const g of gamesRaw) if (g.roof && +g.season >= FIRST_SEASON + 5) (roofCount[g.stadium_id] ??= {})[g.roof] = (roofCount[g.stadium_id][g.roof] || 0) + 1;
const usualRoof = id => (roofCount[id] ? Object.entries(roofCount[id]).sort((a, b) => b[1] - a[1])[0][0] : null);
const games = gamesRaw.map(g => {
  const roof = g.roof || usualRoof(g.stadium_id);
  const indoor = roof === 'dome' || roof === 'closed';
  const w = weather[g.game_id] || {};
  const venue = stadiumInfo(g.stadium_id) || teamHome(+g.season, nt(g.home_team));
  const [hh, mm] = (g.gametime || '13:00').split(':').map(Number);
  const done = g.home_score != null && g.away_score != null;
  return {
    game_id: g.game_id, season: +g.season, week: +g.week, game_type: g.game_type,
    gameday: g.gameday, weekday: g.weekday, gametime: g.gametime, kick_et: hh + mm / 60,
    home: nt(g.home_team), away: nt(g.away_team), neutral: g.location === 'Neutral' ? 1 : 0,
    home_score: num(g.home_score), away_score: num(g.away_score), done,
    spread_line: num(g.spread_line), total_line: num(g.total_line),
    home_ml: num(g.home_moneyline), away_ml: num(g.away_moneyline),
    home_rest: num(g.home_rest), away_rest: num(g.away_rest),
    div_game: num(g.div_game) || 0, roof, indoor: indoor ? 1 : 0,
    surface: g.surface || lastSurface[g.stadium_id] || null,
    turf: (g.surface || lastSurface[g.stadium_id]) ? (/grass/i.test(g.surface || lastSurface[g.stadium_id]) ? 0 : 1) : null,
    stadium: g.stadium, stadium_id: g.stadium_id, venue,
    // weather: nflverse temp/wind first (historical), Open-Meteo fills the rest; indoors normalized
    temp: indoor ? 70 : (num(g.temp) ?? w.temp_f ?? null),
    wind: indoor ? 0 : (num(g.wind) ?? w.wind_mph ?? null),
    gust: indoor ? 0 : (w.gust_mph ?? null),
    precip: indoor ? 0 : (w.precip_in ?? null),
    snow: indoor ? 0 : (w.snow_in ?? null),
    humidity: indoor ? null : (w.humidity ?? null),
    weather_src: indoor ? 'indoor' : (num(g.temp) != null ? 'nflverse' : (w.source || null)),
    home_qb: g.home_qb_name, away_qb: g.away_qb_name, home_qb_id: g.home_qb_id, away_qb_id: g.away_qb_id,
    home_coach: g.home_coach, away_coach: g.away_coach, referee: g.referee,
    order: `${g.gameday}T${(g.gametime || '13:00').padStart(5, '0')}|${g.game_id}`,
  };
}).sort((a, b) => (a.order < b.order ? -1 : 1));
const gameById = Object.fromEntries(games.map(g => [g.game_id, g]));
const gameBySWT = {}; // season|week|team -> game
for (const g of games) { gameBySWT[`${g.season}|${g.week}|${g.home}`] = g; gameBySWT[`${g.season}|${g.week}|${g.away}`] = g; }
log(`games: ${games.length} (${games.filter(g => !g.done).length} upcoming)`);

// ---------------------------------------------------------------- play-by-play → team-game aggregates
const PBP_COLS = ['game_id', 'posteam', 'defteam', 'play_type', 'epa', 'success', 'pass', 'rush', 'pass_oe', 'xpass',
  'score_differential', 'game_seconds_remaining', 'qtr', 'wp', 'yards_gained', 'interception', 'fumble_lost',
  'fixed_drive', 'fixed_drive_result', 'drive_inside20', 'qb_kneel', 'qb_spike', 'down', 'touchdown',
  'yardline_100', 'air_yards', 'receiver_player_id', 'rusher_player_id'];
const tg = {}; // game|team -> agg
const popp = {}; // game|gsis -> red-zone / goal-line opportunity counts
const topp = {}; // game|team -> team totals of the same
for (const s of SEASONS) {
  const f = `play_by_play_${s}.csv.gz`;
  if (!exists(f)) continue;
  const plays = readCsv(path.join(RAW, f), { columns: PBP_COLS, filter: p => p.posteam && (p.play_type === 'pass' || p.play_type === 'run') });
  let prev = null;
  for (const p of plays) {
    const team = nt(p.posteam);
    const k = `${p.game_id}|${team}`;
    const a = (tg[k] ??= { plays: 0, pass: 0, epa: 0, pass_epa: 0, pass_n: 0, rush_epa: 0, rush_n: 0, succ: 0, expl: 0, pass_oe: 0, poe_n: 0,
      n_pass: 0, n_n: 0, pace: 0, pace_n: 0, sd: 0, trail8: 0, lead8: 0, to: 0, drives: new Set(), rz: new Set(), rztd: new Set() });
    const kneel = p.qb_kneel === '1' || p.qb_spike === '1';
    if (!kneel) {
      const isPass = p.pass === '1';
      const epa = num(p.epa) ?? 0, yds = num(p.yards_gained) ?? 0;
      a.plays++; a.epa += epa; a.succ += p.success === '1' ? 1 : 0;
      if (isPass) { a.pass++; a.pass_epa += epa; a.pass_n++; if (yds >= 20) a.expl++; }
      else { a.rush_epa += epa; a.rush_n++; if (yds >= 10) a.expl++; }
      const poe = num(p.pass_oe);
      if (poe != null) { a.pass_oe += poe; a.poe_n++; }
      const wp = num(p.wp), qtr = num(p.qtr), sd = num(p.score_differential) ?? 0;
      const neutral = wp != null && wp >= 0.2 && wp <= 0.8 && qtr <= 3;
      if (neutral) { a.n_n++; if (isPass) a.n_pass++; }
      a.sd += sd; if (sd <= -8) a.trail8++; if (sd >= 8) a.lead8++;
      if (p.interception === '1' || p.fumble_lost === '1') a.to++;
      if (neutral && prev && prev.game_id === p.game_id && prev.posteam === p.posteam && prev.fixed_drive === p.fixed_drive) {
        const dt = num(prev.game_seconds_remaining) - num(p.game_seconds_remaining);
        if (dt > 0 && dt < 60) { a.pace += dt; a.pace_n++; }
      }
    }
    if (!kneel) {
      const yl = num(p.yardline_100);
      const tt = (topp[k] ??= { rz_tgt: 0, ez_tgt: 0, rz_car: 0, gl_car: 0, deep_tgt: 0 });
      if (p.pass === '1' && p.receiver_player_id) {
        const o = (popp[`${p.game_id}|${p.receiver_player_id}`] ??= { rz_tgt: 0, ez_tgt: 0, rz_car: 0, gl_car: 0, deep_tgt: 0 });
        const ay = num(p.air_yards);
        if (yl != null && yl <= 20) { o.rz_tgt++; tt.rz_tgt++; }
        if (yl != null && ay != null && ay >= yl) { o.ez_tgt++; tt.ez_tgt++; }
        if (ay != null && ay >= 20) { o.deep_tgt++; tt.deep_tgt++; }
      } else if (p.rush === '1' && p.rusher_player_id) {
        const o = (popp[`${p.game_id}|${p.rusher_player_id}`] ??= { rz_tgt: 0, ez_tgt: 0, rz_car: 0, gl_car: 0, deep_tgt: 0 });
        if (yl != null && yl <= 20) { o.rz_car++; tt.rz_car++; }
        if (yl != null && yl <= 5) { o.gl_car++; tt.gl_car++; }
      }
    }
    a.drives.add(p.fixed_drive);
    if (p.drive_inside20 === '1') { a.rz.add(p.fixed_drive); if (p.fixed_drive_result === 'Touchdown') a.rztd.add(p.fixed_drive); }
    prev = p;
  }
  log(`pbp ${s}: ${plays.length} plays`);
}

// ---------------------------------------------------------------- players, snaps, injuries, NGS, PFR
const playersRaw = readCsv(path.join(RAW, 'players.csv'));
const players = {}; const pfr2gsis = {};
for (const p of playersRaw) {
  if (!p.gsis_id) continue;
  players[p.gsis_id] = { name: p.display_name, pos: p.position, headshot: p.headshot, birth: p.birth_date,
    draft_round: num(p.draft_round), draft_pick: num(p.draft_pick), rookie_season: num(p.rookie_season),
    height: num(p.height), weight: num(p.weight), college: p.college_name, team: p.latest_team, status: p.status, pfr: p.pfr_id };
  if (p.pfr_id) pfr2gsis[p.pfr_id] = p.gsis_id;
}
log(`players: ${Object.keys(players).length}`);

const SKILL = new Set(['QB', 'RB', 'FB', 'WR', 'TE', 'HB']);
const posNorm = p => (p === 'FB' || p === 'HB' ? 'RB' : p);

const snaps = {}; // game|gsis -> {snaps, pct}
for (const s of SEASONS) {
  const f = `snap_counts_${s}.csv`;
  if (!exists(f)) continue;
  for (const r of readCsv(path.join(RAW, f))) {
    const g = pfr2gsis[r.pfr_player_id];
    if (!g || !(num(r.offense_snaps) > 0)) continue;
    snaps[`${r.game_id}|${g}`] = { snaps: num(r.offense_snaps), pct: num(r.offense_pct), pos: r.position, team: nt(r.team) };
  }
}
log(`snap rows: ${Object.keys(snaps).length}`);

const injuries = {}; // season|week|gsis -> status
const INJ_RANK = { Out: 3, Doubtful: 2, Questionable: 1 };
const reported = new Set(); // season|week|team that have an official injury report
for (const s of SEASONS) {
  const f = `injuries_${s}.csv`;
  if (!exists(f)) continue;
  for (const r of readCsv(path.join(RAW, f))) {
    if (!r.gsis_id) continue;
    injuries[`${r.season}|${r.week}|${r.gsis_id}`] = { status: r.report_status || null, injury: r.report_primary_injury || r.practice_primary_injury || null, practice: r.practice_status || null };
    reported.add(`${r.season}|${r.week}|${nt(r.team)}`);
  }
}

// ---------------------------------------------------------------- current availability (upcoming games only)
// Weekly rosters give IR / released / practice-squad status; the daily ESPN depth chart gives today's pecking order
// (new signings, trades, demotions). Neither touches completed games, so the back-test stays leak-free.
const CUR = Math.max(...SEASONS);
const rosterNow = {}; // gsis -> {team, status, week}
if (exists(`roster_weekly_${CUR}.csv`)) {
  for (const r of readCsv(path.join(RAW, `roster_weekly_${CUR}.csv`), { columns: ['gsis_id', 'team', 'status', 'week'] })) {
    if (!r.gsis_id) continue;
    const w = +r.week, prev = rosterNow[r.gsis_id];
    if (prev && (prev.week > w || (prev.week === w && r.status === 'CUT'))) continue;
    rosterNow[r.gsis_id] = { team: nt(r.team), status: r.status, week: w };
  }
}
const ROSTER_OUT = { RES: 'Injured reserve', CUT: 'Released', DEV: 'Practice squad', RET: 'Retired', EXE: 'Exempt' };
const depth = {}; // team -> {QB: [gsis by rank], RB, WR, TE}
const depthOf = {}; // gsis -> {team, pos, rank}
let depthAsOf = null;
if (exists(`depth_charts_${CUR}.csv`)) {
  const POS = new Set(['QB', 'RB', 'WR', 'TE']);
  const rows = readCsv(path.join(RAW, `depth_charts_${CUR}.csv`), { columns: ['dt', 'team', 'gsis_id', 'pos_abb', 'pos_rank'], filter: r => POS.has(r.pos_abb) && r.gsis_id });
  const lastDt = {};
  for (const r of rows) { const t = nt(r.team); if (!lastDt[t] || r.dt > lastDt[t]) lastDt[t] = r.dt; }
  for (const r of rows) {
    const t = nt(r.team);
    if (r.dt !== lastDt[t]) continue;
    const prev = depthOf[r.gsis_id];
    if (prev && prev.rank <= +r.pos_rank) continue;
    depthOf[r.gsis_id] = { team: t, pos: r.pos_abb, rank: +r.pos_rank };
  }
  for (const [g, d] of Object.entries(depthOf)) ((depth[d.team] ??= {})[d.pos] ??= []).push(g);
  for (const t of Object.values(depth)) for (const l of Object.values(t)) l.sort((a, b) => depthOf[a].rank - depthOf[b].rank);
  depthAsOf = Object.values(lastDt).sort().at(-1) || null;
}
// team a player belongs to right now (null when unknown)
const currentTeam = gsis => depthOf[gsis]?.team || (rosterNow[gsis] && rosterNow[gsis].status !== 'CUT' ? rosterNow[gsis].team : null);
// Before the week's official report is out, fill it in: roster IR/releases count as Out, and anyone
// Out or Doubtful on the team's last report is carried forward as Questionable.
let synthesized = 0;
for (const g of games) {
  if (g.done || g.season !== CUR) continue;
  for (const team of [g.home, g.away]) {
    if (reported.has(`${g.season}|${g.week}|${team}`)) continue;
    let lastWk = 0;
    for (let w = g.week - 1; w >= 1; w--) if (reported.has(`${g.season}|${w}|${team}`)) { lastWk = w; break; }
    for (const [gsis, r] of Object.entries(rosterNow)) {
      if (r.team !== team) continue;
      const key = `${g.season}|${g.week}|${gsis}`;
      if (ROSTER_OUT[r.status] && !(depthOf[gsis]?.team === team && r.status === 'DEV')) {
        injuries[key] = { status: 'Out', injury: ROSTER_OUT[r.status], practice: null, synthetic: true }; synthesized++;
        continue;
      }
      const prev = lastWk ? injuries[`${g.season}|${lastWk}|${gsis}`] : null;
      if (prev && (prev.status === 'Out' || prev.status === 'Doubtful')) {
        injuries[key] = { status: 'Questionable', injury: `${prev.injury || 'injury'}; ${prev.status} Wk ${lastWk}`, practice: null, synthetic: true }; synthesized++;
      }
    }
  }
}

const ngs = {}; // season|week|gsis -> fields
const addNgs = (file, map) => {
  if (!exists(file)) return;
  for (const r of readCsv(path.join(RAW, file))) {
    if (r.week === '0' || !r.player_gsis_id) continue;
    const k = `${r.season}|${r.week}|${r.player_gsis_id}`;
    const o = (ngs[k] ??= {});
    for (const [src, dst] of Object.entries(map)) o[dst] = num(r[src]);
  }
};
addNgs('ngs_receiving.csv.gz', { avg_separation: 'ngs_sep', avg_cushion: 'ngs_cushion', avg_intended_air_yards: 'ngs_iay', avg_yac_above_expectation: 'ngs_yacoe' });
addNgs('ngs_rushing.csv.gz', { rush_yards_over_expected_per_att: 'ngs_ryoe', percent_attempts_gte_eight_defenders: 'ngs_8box', efficiency: 'ngs_rush_eff' });
addNgs('ngs_passing.csv.gz', { avg_time_to_throw: 'ngs_ttt', aggressiveness: 'ngs_aggr', completion_percentage_above_expectation: 'ngs_cpoe' });

const pfr = {}; // game|gsis -> fields
for (const s of SEASONS) {
  for (const [kind, map] of [
    ['pass', { times_pressured_pct: 'pfr_press', passing_bad_throw_pct: 'pfr_bad' }],
    ['rush', { rushing_yards_after_contact_avg: 'pfr_yaco', rushing_broken_tackles: 'pfr_btk_rush' }],
    ['rec', { receiving_drop_pct: 'pfr_drop', receiving_broken_tackles: 'pfr_btk_rec' }],
  ]) {
    const f = `advstats_week_${kind}_${s}.csv`;
    if (!exists(f)) continue;
    for (const r of readCsv(path.join(RAW, f))) {
      const g = pfr2gsis[r.pfr_player_id];
      if (!g) continue;
      const o = (pfr[`${r.game_id}|${g}`] ??= {});
      for (const [src, dst] of Object.entries(map)) o[dst] = num(r[src]);
    }
  }
}
log(`ngs keys ${Object.keys(ngs).length}, pfr keys ${Object.keys(pfr).length}`);

// ---------------------------------------------------------------- player-game box scores
const STAT = ['completions', 'attempts', 'passing_yards', 'passing_tds', 'passing_interceptions', 'sacks_suffered', 'passing_air_yards', 'passing_epa',
  'carries', 'rushing_yards', 'rushing_tds', 'rushing_epa', 'rushing_fumbles_lost',
  'targets', 'receptions', 'receiving_yards', 'receiving_tds', 'receiving_air_yards', 'receiving_yards_after_catch', 'receiving_epa',
  'target_share', 'air_yards_share', 'wopr', 'fantasy_points', 'fantasy_points_ppr', 'receiving_fumbles_lost', 'sack_fumbles_lost',
  'passing_2pt_conversions', 'rushing_2pt_conversions', 'receiving_2pt_conversions'];
const box = {}; // game|gsis -> row
const statHeadshot = {};
for (const s of SEASONS) {
  const f = `stats_player_week_${s}.csv`;
  if (!exists(f)) continue;
  for (const r of readCsv(path.join(RAW, f))) {
    if (!SKILL.has(r.position) || !r.game_id || !gameById[r.game_id]) continue;
    const o = { gsis: r.player_id, game_id: r.game_id, team: nt(r.team), pos: posNorm(r.position), name: r.player_display_name, headshot: r.headshot_url };
    for (const k of STAT) o[k] = num(r[k]) ?? 0;
    box[`${r.game_id}|${r.player_id}`] = o;
    if (r.headshot_url) statHeadshot[r.player_id] = r.headshot_url;
  }
}
// players who took offensive snaps but recorded no stat still count (zero games matter for projections)
for (const [k, sn] of Object.entries(snaps)) {
  if (box[k]) continue;
  const [game_id, gsis] = k.split('|');
  const p = players[gsis];
  const pos = posNorm(p?.pos || sn.pos);
  if (!SKILL.has(pos) || !gameById[game_id]) continue;
  const o = { gsis, game_id, team: sn.team, pos, name: p?.name || gsis, headshot: p?.headshot };
  for (const s of STAT) o[s] = 0;
  box[k] = o;
}
log(`player-game box rows: ${Object.keys(box).length}`);

// ---------------------------------------------------------------- team-game rows
const teamGames = [];
const teamHist = {}; // team -> [row] in time order
const allowed = {}; // game|defteam -> {QB:{fp, yds}, ...}
for (const b of Object.values(box)) {
  const g = gameById[b.game_id];
  const def = b.team === g.home ? g.away : g.home;
  const a = ((allowed[`${b.game_id}|${def}`] ??= {})[b.pos] ??= { fp: 0, pass_yds: 0, rush_yds: 0, rec_yds: 0, tgt: 0 });
  a.fp += b.fantasy_points_ppr; a.pass_yds += b.passing_yards; a.rush_yds += b.rushing_yards; a.rec_yds += b.receiving_yards; a.tgt += b.targets;
}
const teamTotals = {}; // game|team -> {att, car, tgt}
for (const b of Object.values(box)) {
  const t = (teamTotals[`${b.game_id}|${b.team}`] ??= { att: 0, car: 0, tgt: 0, ay: 0 });
  t.att += b.attempts; t.car += b.carries; t.tgt += b.targets; t.ay += b.receiving_air_yards;
}

function teamGameRaw(g, team) {
  const home = team === g.home;
  const opp = home ? g.away : g.home;
  const a = tg[`${g.game_id}|${team}`];
  const pf = home ? g.home_score : g.away_score, pa = home ? g.away_score : g.home_score;
  const tt = teamTotals[`${g.game_id}|${team}`];
  const al = allowed[`${g.game_id}|${team}`] || {};
  const o = { pf, pa };
  if (a && a.plays) {
    Object.assign(o, {
      plays: a.plays, pass_rate: a.pass / a.plays, epa_play: a.epa / a.plays,
      pass_epa: a.pass_n ? a.pass_epa / a.pass_n : null, rush_epa: a.rush_n ? a.rush_epa / a.rush_n : null,
      success: a.succ / a.plays, explosive: a.expl / a.plays, proe: a.poe_n ? a.pass_oe / a.poe_n : null,
      neutral_pass: a.n_n >= 10 ? a.n_pass / a.n_n : null, sec_per_play: a.pace_n >= 10 ? a.pace / a.pace_n : null,
      script: a.sd / a.plays, trail8: a.trail8 / a.plays, lead8: a.lead8 / a.plays, to_rate: a.to / a.plays,
      drives: a.drives.size, pts_drive: pf != null && a.drives.size ? pf / a.drives.size : null,
      rz_trips: a.rz.size, rz_td: a.rz.size ? a.rztd.size / a.rz.size : null,
    });
  }
  if (tt) Object.assign(o, { team_att: tt.att, team_car: tt.car, team_tgt: tt.tgt });
  for (const pos of ['QB', 'RB', 'WR', 'TE']) o[`fpa_${pos}`] = al[pos]?.fp ?? (g.done ? 0 : null);
  o.pass_yds_allowed = al.QB?.pass_yds ?? null;
  o.rush_yds_allowed = (al.RB?.rush_yds ?? 0) + (al.QB?.rush_yds ?? 0) + (al.WR?.rush_yds ?? 0);
  return o;
}

// Exponentially-weighted history summary. Older seasons are discounted so offseason change is respected.
function ewma(hist, fields, { hl = 6, maxN = 32, season, prior = null, k = 0, decay = 0.55 } = {}) {
  const out = {};
  const n = Math.min(hist.length, maxN);
  for (const f of fields) {
    let sw = 0, sx = 0;
    for (let i = 0; i < n; i++) {
      const r = hist[hist.length - 1 - i];
      const v = r[f];
      if (v == null || !Number.isFinite(v)) continue;
      const w = 0.5 ** (i / hl) * decay ** (season - r.season);
      sw += w; sx += w * v;
    }
    if (prior && prior[f] != null && k > 0) { sx += k * prior[f]; sw += k; }
    out[f] = sw > 0 ? sx / sw : null;
  }
  return out;
}

const ADJ = ['adj_epa', 'adj_pass_epa', 'adj_rush_epa', 'adj_success'];
const TEAM_OFF = ['adj_pts', ...ADJ, 'pf', 'plays', 'pass_rate', 'epa_play', 'pass_epa', 'rush_epa', 'success', 'explosive', 'proe', 'neutral_pass', 'sec_per_play', 'to_rate', 'pts_drive', 'rz_td', 'team_att', 'team_car', 'drives'];
const TEAM_DEF = ['adj_pts', ...ADJ, 'pa', 'epa_play', 'pass_epa', 'rush_epa', 'success', 'explosive', 'to_rate', 'plays', 'fpa_QB', 'fpa_RB', 'fpa_WR', 'fpa_TE', 'pass_yds_allowed', 'rush_yds_allowed'];
// league priors (shrink early-season estimates toward league average)
const leaguePrior = {};

// build raw rows first
const rawTG = {};
for (const g of games) for (const team of [g.home, g.away]) {
  const r = { season: g.season, game_id: g.game_id, team, ...(g.done ? teamGameRaw(g, team) : {}) };
  rawTG[`${g.game_id}|${team}`] = r;
}
{
  const done = Object.values(rawTG).filter(r => r.plays);
  for (const f of new Set([...TEAM_OFF, ...TEAM_DEF])) leaguePrior[f] = mean(done.map(r => r[f]).filter(v => v != null));
  Object.assign(leaguePrior, { adj_epa: leaguePrior.epa_play, adj_pass_epa: leaguePrior.pass_epa, adj_rush_epa: leaguePrior.rush_epa, adj_success: leaguePrior.success, adj_pts: leaguePrior.pf });
}
// strip schedule strength: a result is credited relative to how good the opponent was going in
function adjust(row, oppState, kind) {
  const P = leaguePrior, o = oppState;
  const d = (v, base, lg) => (v == null || base == null ? null : v - (base - lg));
  return kind === 'off'
    ? { adj_pts: d(row.pf, o.def.pa, P.pf), adj_epa: d(row.epa_play, o.def.epa_play, P.epa_play), adj_pass_epa: d(row.pass_epa, o.def.pass_epa, P.pass_epa),
        adj_rush_epa: d(row.rush_epa, o.def.rush_epa, P.rush_epa), adj_success: d(row.success, o.def.success, P.success) }
    : { adj_pts: d(row.pa, o.off.pf, P.pf), adj_epa: d(row.epa_play, o.off.epa_play, P.epa_play), adj_pass_epa: d(row.pass_epa, o.off.pass_epa, P.pass_epa),
        adj_rush_epa: d(row.rush_epa, o.off.rush_epa, P.rush_epa), adj_success: d(row.success, o.off.success, P.success) };
}

// defensive view of a game = opponent's offensive numbers
const defView = (g, team) => {
  const opp = team === g.home ? g.away : g.home;
  const o = rawTG[`${g.game_id}|${opp}`], me = rawTG[`${g.game_id}|${team}`];
  return { season: g.season, pa: o.pf, epa_play: o.epa_play, pass_epa: o.pass_epa, rush_epa: o.rush_epa, success: o.success, explosive: o.explosive,
    to_rate: o.to_rate, plays: o.plays, fpa_QB: me.fpa_QB, fpa_RB: me.fpa_RB, fpa_WR: me.fpa_WR, fpa_TE: me.fpa_TE,
    pass_yds_allowed: me.pass_yds_allowed, rush_yds_allowed: me.rush_yds_allowed };
};
const defHist = {};
const teamState = {}; // game|team -> {off, def} computed BEFORE the game
for (const g of games) {
  for (const team of [g.home, g.away]) {
    const hist = teamHist[team] || [];
    const dh = defHist[team] || [];
    teamState[`${g.game_id}|${team}`] = {
      off: ewma(hist, TEAM_OFF, { season: g.season, prior: leaguePrior, k: 1.5 }),
      def: ewma(dh, TEAM_DEF, { season: g.season, prior: leaguePrior, k: 1.5 }),
      lt_off: ewma(hist, ['adj_pts', ...ADJ], { season: g.season, prior: leaguePrior, k: 3, hl: 16, maxN: 60, decay: 0.8 }),
      lt_def: ewma(dh, ['adj_pts', ...ADJ], { season: g.season, prior: leaguePrior, k: 3, hl: 16, maxN: 60, decay: 0.8 }),
      n: hist.filter(h => h.season === g.season).length,
      last_game: hist.length ? hist[hist.length - 1].gameday : null,
    };
  }
  if (g.done) for (const team of [g.home, g.away]) {
    const r = rawTG[`${g.game_id}|${team}`];
    if (r.plays == null) continue;
    const oppState = teamState[`${g.game_id}|${team === g.home ? g.away : g.home}`];
    (teamHist[team] ??= []).push({ ...r, ...adjust(r, oppState, 'off'), gameday: g.gameday });
    const dv = defView(g, team);
    (defHist[team] ??= []).push({ ...dv, ...adjust(dv, oppState, 'def') });
  }
}
log('team rolling states built');

function context(g, team) {
  const home = team === g.home;
  const opp = home ? g.away : g.home;
  const isHome = home && !g.neutral ? 1 : 0;
  const hv = teamHome(g.season, team);
  const travel = hv && g.venue ? haversineMiles(hv, g.venue) : null;
  const tz = hv && g.venue ? g.venue.utc - hv.utc : null;
  const body = hv ? g.kick_et + (hv.utc + 5) : null; // kickoff on the team's home body clock
  const sp = g.spread_line == null ? null : (home ? -g.spread_line : g.spread_line); // team spread (neg = favored)
  const tot = g.total_line;
  return {
    is_home: isHome, is_away: !home && !g.neutral ? 1 : 0, neutral: g.neutral, div_game: g.div_game,
    playoff: g.game_type === 'REG' ? 0 : 1, week: g.week,
    indoor: g.indoor, turf: g.turf, temp: g.temp, wind: g.wind, gust: g.gust, precip: g.precip, snow: g.snow,
    kick_et: g.kick_et, body_clock: body, primetime: g.kick_et >= 19 ? 1 : 0,
    weekday: ({ Thursday: 4, Friday: 5, Saturday: 6, Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3 })[g.weekday] ?? null,
    rest: home ? g.home_rest : g.away_rest, opp_rest: home ? g.away_rest : g.home_rest,
    rest_diff: g.home_rest != null && g.away_rest != null ? (home ? g.home_rest - g.away_rest : g.away_rest - g.home_rest) : null,
    travel_mi: travel, tz_shift: tz, elev: g.venue?.elev ?? null,
    spread: sp, total: tot, implied: sp != null && tot != null ? tot / 2 - sp / 2 : null,
    opp_implied: sp != null && tot != null ? tot / 2 + sp / 2 : null,
    opp,
  };
}

// starting-QB continuity: usual QB = most attempts over the team's last 3 games
const qbUsage = {}; // team -> [{game_id, season, week, qb:{gsis:att}}]
for (const b of Object.values(box)) if (b.attempts > 0) {
  const g = gameById[b.game_id];
  ((qbUsage[b.team] ??= {})[b.game_id] ??= { order: g.order, att: {} }).att[b.gsis] = b.attempts;
}
const qbList = Object.fromEntries(Object.entries(qbUsage).map(([t, m]) => [t, Object.values(m).sort((a, b) => (a.order < b.order ? -1 : 1))]));
function usualQB(team, order) {
  const l = (qbList[team] || []).filter(x => x.order < order).slice(-3);
  const tot = {};
  for (const x of l) for (const [q, a] of Object.entries(x.att)) tot[q] = (tot[q] || 0) + a;
  const best = Object.entries(tot).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// QB quality: dropback-weighted EPA/dropback and CPOE, shrunk toward replacement level
const qbGames = {}; // gsis -> [{order, season, db, epa, cpoe, att}]
for (const b of Object.values(box)) if (b.attempts > 0) {
  const g = gameById[b.game_id];
  (qbGames[b.gsis] ??= []).push({ order: g.order, season: g.season, db: b.attempts + b.sacks_suffered, epa: b.passing_epa, att: b.attempts,
    cpoe: ngs[`${g.season}|${g.week}|${b.gsis}`]?.ngs_cpoe ?? null, team: b.team, game_id: b.game_id });
}
for (const l of Object.values(qbGames)) l.sort((a, b) => (a.order < b.order ? -1 : 1));
const REPLACEMENT_EPA = -0.08;
function qbRating(gsis, order, season) {
  if (!gsis) return { qb_epa: null, qb_cpoe: null, qb_db: null };
  const l = (qbGames[gsis] || []).filter(x => x.order < order);
  let sw = 0, sx = 0, cw = 0, cx = 0, tot = 0;
  for (let i = l.length - 1, n = 0; i >= 0 && n < 40; i--, n++) {
    const x = l[i], w = 0.5 ** (n / 10) * 0.7 ** (season - x.season);
    sw += w * x.db; sx += w * x.epa; tot += x.db;
    if (x.cpoe != null) { cw += w * x.db; cx += w * x.db * x.cpoe; }
  }
  const K = 120;
  return { qb_epa: (sx + K * REPLACEMENT_EPA) / (sw + K), qb_cpoe: cw > 0 ? cx / (cw + K / 4) : null, qb_db: tot };
}
// who starts: the listed starter for played games; for upcoming games the usual QB unless ruled out
function projectedStarter(team, g, home) {
  if (!g.done && g.season === CUR) {
    const dq = (depth[team]?.QB || []).find(q => !['Out', 'Doubtful'].includes(injuries[`${g.season}|${g.week}|${q}`]?.status));
    if (dq) return dq;
  }
  const listed = home ? g.home_qb_id : g.away_qb_id;
  if (listed) return listed;
  if (g.done) { const x = (qbList[team] || []).find(q => q.order === g.order); return x ? Object.entries(x.att).sort((a, b) => b[1] - a[1])[0][0] : null; }
  const recent = (qbList[team] || []).filter(x => x.order < g.order).slice(-4);
  const tot = {};
  recent.forEach((x, i) => { for (const [q, a] of Object.entries(x.att)) tot[q] = (tot[q] || 0) + a * (i + 1); });
  const ranked = Object.entries(tot).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  return ranked.find(q => !['Out', 'Doubtful'].includes(injuries[`${g.season}|${g.week}|${q}`]?.status)) || null;
}

for (const g of games) {
  for (const team of [g.home, g.away]) {
    const home = team === g.home;
    const ctx = context(g, team);
    const st = teamState[`${g.game_id}|${team}`];
    const os = teamState[`${g.game_id}|${ctx.opp}`];
    const raw = rawTG[`${g.game_id}|${team}`];
    const usual = usualQB(team, g.order);
    const starter = g.done ? (home ? g.home_qb_id : g.away_qb_id) : projectedStarter(team, g, home);
    const inj = usual ? injuries[`${g.season}|${g.week}|${usual}`]?.status : null;
    const qbChange = starter && usual ? (starter !== usual ? 1 : 0) : (inj === 'Out' || inj === 'Doubtful' ? 1 : 0);
    const oppUsual = usualQB(ctx.opp, g.order);
    const oppStarter = g.done ? (home ? g.away_qb_id : g.home_qb_id) : projectedStarter(ctx.opp, g, !home);
    const oppInj = oppUsual ? injuries[`${g.season}|${g.week}|${oppUsual}`]?.status : null;
    const oppQbChange = oppStarter && oppUsual ? (oppStarter !== oppUsual ? 1 : 0) : (oppInj === 'Out' || oppInj === 'Doubtful' ? 1 : 0);
    const f = { ...ctx, qb_change: qbChange, opp_qb_change: oppQbChange, games_played: st.n, opp_games_played: os.n };
    const myQB = projectedStarter(team, g, home), oppQB = projectedStarter(ctx.opp, g, !home);
    Object.assign(f, qbRating(myQB, g.order, g.season));
    const oq = qbRating(oppQB, g.order, g.season);
    f.opp_qb_epa = oq.qb_epa; f.opp_qb_cpoe = oq.qb_cpoe;
    for (const [k, v] of Object.entries(st.off)) f[`off_${k}`] = v;
    for (const [k, v] of Object.entries(st.def)) f[`def_${k}`] = v;
    for (const [k, v] of Object.entries(os.off)) f[`oppoff_${k}`] = v;
    for (const [k, v] of Object.entries(os.def)) f[`oppdef_${k}`] = v;
    for (const [k, v] of Object.entries(st.lt_off)) f[`ltoff_${k}`] = v;
    for (const [k, v] of Object.entries(st.lt_def)) f[`ltdef_${k}`] = v;
    for (const [k, v] of Object.entries(os.lt_off)) f[`ltoppoff_${k}`] = v;
    for (const [k, v] of Object.entries(os.lt_def)) f[`ltoppdef_${k}`] = v;
    delete f.opp;
    teamGames.push({
      game_id: g.game_id, season: g.season, week: g.week, gameday: g.gameday, team, opp: ctx.opp, home: home ? 1 : 0, done: g.done,
      usual_qb: usual, usual_qb_status: inj || null, starter_qb: myQB,
      target: g.done ? raw.pf : null, actual: g.done ? raw : null, features: f,
    });
  }
}
log(`team-game rows: ${teamGames.length}`);

// ---------------------------------------------------------------- player-game rows
const pHist = {}; // gsis -> [row]
const byGame = {};
for (const b of Object.values(box)) (byGame[b.game_id] ??= []).push(b);

const P_FIELDS = ['snap_pct', 'target_share', 'air_yards_share', 'carry_share', 'att_share', 'targets', 'receptions', 'carries', 'attempts', 'completions',
  'passing_yards', 'passing_tds', 'passing_interceptions', 'rushing_yards', 'rushing_tds', 'receiving_yards', 'receiving_tds',
  'receiving_air_yards', 'receiving_yards_after_catch', 'fantasy_points_ppr', 'passing_epa', 'rushing_epa', 'receiving_epa', 'sacks_suffered',
  'ngs_sep', 'ngs_cushion', 'ngs_iay', 'ngs_yacoe', 'ngs_ryoe', 'ngs_8box', 'ngs_rush_eff', 'ngs_ttt', 'ngs_aggr', 'ngs_cpoe',
  'pfr_press', 'pfr_bad', 'pfr_yaco', 'pfr_btk_rush', 'pfr_drop', 'pfr_btk_rec',
  'rz_tgt', 'ez_tgt', 'rz_car', 'gl_car', 'deep_tgt', 'rz_tgt_share', 'rz_car_share', 'gl_car_share', 'ez_tgt_share'];
const P_RECENT = ['snap_pct', 'targets', 'carries', 'attempts', 'fantasy_points_ppr', 'target_share', 'carry_share', 'receiving_yards', 'rushing_yards', 'passing_yards'];

function enrich(b, g) {
  const tt = teamTotals[`${b.game_id}|${b.team}`] || {};
  const sn = snaps[`${b.game_id}|${b.gsis}`];
  const po = popp[`${b.game_id}|${b.gsis}`] || { rz_tgt: 0, ez_tgt: 0, rz_car: 0, gl_car: 0, deep_tgt: 0 };
  const to = topp[`${b.game_id}|${b.team}`] || {};
  const sh = (a, t) => (t ? a / t : 0);
  return {
    ...po, rz_tgt_share: sh(po.rz_tgt, to.rz_tgt), rz_car_share: sh(po.rz_car, to.rz_car), gl_car_share: sh(po.gl_car, to.gl_car), ez_tgt_share: sh(po.ez_tgt, to.ez_tgt),
    ...b, season: g.season, week: g.week, gameday: g.gameday,
    snap_pct: sn?.pct ?? null, snaps: sn?.snaps ?? null,
    carry_share: tt.car ? b.carries / tt.car : 0, att_share: tt.att ? b.attempts / tt.att : 0,
    ...(ngs[`${g.season}|${g.week}|${b.gsis}`] || {}), ...(pfr[`${b.game_id}|${b.gsis}`] || {}),
  };
}

function playerFeatures(gsis, pos, g, team, hist) {
  const p = players[gsis] || {};
  const f = {};
  const e = ewma(hist, P_FIELDS, { hl: 4, maxN: 24, season: g.season });
  for (const [k, v] of Object.entries(e)) f[`p_${k}`] = v;
  const last3 = hist.slice(-3);
  for (const k of P_RECENT) f[`l3_${k}`] = last3.length ? mean(last3.map(r => r[k]).filter(v => v != null)) : null;
  const thisSeason = hist.filter(r => r.season === g.season);
  f.p_games_season = thisSeason.length;
  f.p_games_total = hist.length;
  f.p_season_fp = thisSeason.length ? mean(thisSeason.map(r => r.fantasy_points_ppr)) : null;
  const last = hist[hist.length - 1];
  f.days_since_last = last ? (Date.parse(g.gameday) - Date.parse(last.gameday)) / 864e5 : null;
  f.new_team = last ? (last.team !== team ? 1 : 0) : null;
  f.ypc = e.carries > 0.5 ? e.rushing_yards / e.carries : null;
  f.ypt = e.targets > 0.5 ? e.receiving_yards / e.targets : null;
  f.ypa = e.attempts > 3 ? e.passing_yards / e.attempts : null;
  f.td_rate_rz = null;
  f.age = p.birth ? (Date.parse(g.gameday) - Date.parse(p.birth)) / 3.156e10 : null;
  f.exp = p.rookie_season ? g.season - p.rookie_season : null;
  f.draft_pick = p.draft_pick ?? 300;
  f.height = p.height; f.weight = p.weight;
  f.pos_QB = pos === 'QB' ? 1 : 0; f.pos_RB = pos === 'RB' ? 1 : 0; f.pos_WR = pos === 'WR' ? 1 : 0; f.pos_TE = pos === 'TE' ? 1 : 0;
  const inj = injuries[`${g.season}|${g.week}|${gsis}`];
  f.inj_status = inj ? (INJ_RANK[inj.status] ?? 0) : 0;
  f.inj_limited = inj && /Limited|Did Not/i.test(inj.practice || '') ? 1 : 0;
  return { f, inj };
}

// teammates' absences: vacated opportunity from players ruled Out/Doubtful this week
function vacated(team, g) {
  let tgt = 0, car = 0, ay = 0;
  const recentGames = (teamHist[team] || []).filter(h => h.gameday < g.gameday).slice(-3).map(h => h.game_id);
  const seen = new Set();
  for (const gid of recentGames) for (const b of byGame[gid] || []) {
    if (b.team !== team || seen.has(b.gsis)) continue;
    seen.add(b.gsis);
    const st = injuries[`${g.season}|${g.week}|${b.gsis}`]?.status;
    const left = !g.done && g.season === CUR && currentTeam(b.gsis) && currentTeam(b.gsis) !== team;
    if (st !== 'Out' && st !== 'Doubtful' && !left) continue;
    const h = (pHist[b.gsis] || []).filter(r => r.gameday < g.gameday);
    const e = ewma(h, ['target_share', 'carry_share', 'air_yards_share'], { hl: 4, maxN: 10, season: g.season });
    tgt += e.target_share || 0; car += e.carry_share || 0; ay += e.air_yards_share || 0;
  }
  return { vac_tgt: tgt, vac_car: car, vac_ay: ay };
}

const tgByKey = Object.fromEntries(teamGames.map(r => [`${r.game_id}|${r.team}`, r]));
const playerGames = [];
const lastTeamGame = {}; // team -> game_id of most recent completed game
const TARGETS = ['attempts', 'completions', 'passing_yards', 'passing_tds', 'passing_interceptions', 'carries', 'rushing_yards', 'rushing_tds',
  'targets', 'receptions', 'receiving_yards', 'receiving_tds', 'fantasy_points_ppr'];

function teamFeatsFor(gameId, team, pos) {
  const t = tgByKey[`${gameId}|${team}`].features;
  const keep = ['is_home', 'is_away', 'neutral', 'div_game', 'playoff', 'week', 'indoor', 'turf', 'temp', 'wind', 'gust', 'precip', 'snow',
    'kick_et', 'body_clock', 'primetime', 'rest', 'rest_diff', 'travel_mi', 'tz_shift', 'elev', 'spread', 'total', 'implied', 'opp_implied',
    'qb_change', 'qb_epa', 'qb_cpoe', 'qb_db', 'off_adj_pts', 'off_adj_epa', 'off_adj_pass_epa', 'off_adj_rush_epa', 'oppdef_adj_pts', 'oppdef_adj_epa', 'oppdef_adj_pass_epa', 'oppdef_adj_rush_epa', 'off_plays', 'off_pass_rate', 'off_epa_play', 'off_pass_epa', 'off_rush_epa', 'off_proe', 'off_neutral_pass', 'off_sec_per_play',
    'off_team_att', 'off_team_car', 'off_pf', 'off_rz_td', 'oppdef_epa_play', 'oppdef_pass_epa', 'oppdef_rush_epa', 'oppdef_success', 'oppdef_explosive',
    'oppdef_pa', 'oppdef_pass_yds_allowed', 'oppdef_rush_yds_allowed', 'oppoff_sec_per_play', 'oppoff_epa_play', 'opp_qb_change'];
  const f = {};
  for (const k of keep) f[k] = t[k];
  f.oppdef_fpa_pos = t[`oppdef_fpa_${pos}`];
  return f;
}

for (const g of games) {
  const rows = g.done ? (byGame[g.game_id] || []) : [];
  const seenTeams = [g.home, g.away];
  // candidates for upcoming games: anyone who appeared for the team in its last 3 completed games
  const candidates = [];
  if (!g.done) {
    for (const team of seenTeams) {
      const hist = (teamHist[team] || []).slice(-3).map(h => h.game_id);
      const seen = new Set();
      for (const gid of hist.reverse()) for (const b of byGame[gid] || []) {
        if (b.team !== team || seen.has(b.gsis)) continue;
        seen.add(b.gsis);
        const ph = pHist[b.gsis] || [];
        if (ph.length && ph[ph.length - 1].team !== team) continue; // moved on
        if (g.season === CUR && currentTeam(b.gsis) && currentTeam(b.gsis) !== team) continue; // traded / released
        candidates.push({ gsis: b.gsis, team, pos: b.pos, name: b.name, headshot: b.headshot });
      }
      if (g.season === CUR) {
        const TOP = { QB: 1, RB: 3, WR: 5, TE: 3 };
        for (const [pos, n] of Object.entries(TOP)) for (const gsis of (depth[team]?.[pos] || []).slice(0, n)) {
          if (seen.has(gsis) || !(pHist[gsis] || []).length) continue;
          seen.add(gsis);
          const p = players[gsis] || {}, last = pHist[gsis].at(-1);
          candidates.push({ gsis, team, pos, name: p.name || last.name, headshot: p.headshot || last.headshot });
        }
      }
    }
  }
  // one projected starting QB per team: healthiest QB with the most recent passing volume
  if (!g.done) {
    for (const team of seenTeams) {
      const qbs = candidates.filter(c => c.team === team && c.pos === 'QB');
      if (qbs.length < 2) continue;
      const score = c => {
        const st = injuries[`${g.season}|${g.week}|${c.gsis}`]?.status;
        if (st === 'Out' || st === 'Doubtful') return -1;
        return ewma(pHist[c.gsis] || [], ['attempts'], { hl: 2, maxN: 6, season: g.season }).attempts || 0;
      };
      const starter = projectedStarter(team, g, team === g.home);
      const best = qbs.find(q => q.gsis === starter) || qbs.reduce((a, b) => (score(b) > score(a) ? b : a));
      for (const q of qbs) if (q !== best) candidates.splice(candidates.indexOf(q), 1);
    }
  }
  const vac = { [g.home]: vacated(g.home, g), [g.away]: vacated(g.away, g) };
  for (const b of (g.done ? rows : candidates)) {
    const hist = pHist[b.gsis] || [];
    const { f, inj } = playerFeatures(b.gsis, b.pos, g, b.team, hist);
    Object.assign(f, teamFeatsFor(g.game_id, b.team, b.pos), vac[b.team]);
    // remove this player's own absence from the vacated pool
    if (inj && (inj.status === 'Out' || inj.status === 'Doubtful')) {
      f.vac_tgt = Math.max(0, f.vac_tgt - (f.p_target_share || 0));
      f.vac_car = Math.max(0, f.vac_car - (f.p_carry_share || 0));
    }
    const row = { gsis: b.gsis, name: b.name, pos: b.pos, team: b.team, opp: b.team === g.home ? g.away : g.home,
      game_id: g.game_id, season: g.season, week: g.week, gameday: g.gameday, done: g.done,
      injury: inj?.status ? `${inj.status}${inj.injury ? ' (' + inj.injury + ')' : ''}` : null,
      features: f };
    if (g.done) {
      const en = enrich(b, g);
      row.actual = {};
      for (const k of [...TARGETS, 'snap_pct', 'target_share', 'air_yards_share', 'receiving_air_yards', 'receiving_yards_after_catch', 'passing_epa',
        'rushing_epa', 'receiving_epa', 'sacks_suffered', 'carry_share', 'ngs_sep', 'ngs_ryoe', 'ngs_cpoe', 'pfr_press', 'pfr_yaco', 'pfr_drop']) row.actual[k] = r1(en[k]);
    }
    playerGames.push(row);
  }
  if (g.done) for (const b of rows) (pHist[b.gsis] ??= []).push(enrich(b, g));
}
log(`availability: depth chart as of ${depthAsOf}, ${Object.keys(rosterNow).length} roster entries, ${synthesized} pre-report statuses`);
log(`player-game rows: ${playerGames.length} (${playerGames.filter(r => !r.done).length} upcoming)`);

// ---------------------------------------------------------------- write
const roundFeat = rows => { for (const r of rows) for (const k in r.features) r.features[k] = r1(r.features[k], 4); };
roundFeat(teamGames); roundFeat(playerGames);
fs.mkdirSync(CACHE, { recursive: true });
// upcoming games show the projected starter (depth chart / injuries) rather than the schedule's guess
for (const g of games) {
  if (g.done) continue;
  for (const side of ['home', 'away']) {
    const q = tgByKey[`${g.game_id}|${g[side]}`]?.starter_qb;
    if (q && q !== g[`${side}_qb_id`]) { g[`${side}_qb_id`] = q; g[`${side}_qb`] = players[q]?.name || g[`${side}_qb`]; }
  }
}
const gamesOut = games.map(({ venue, order, ...g }) => ({ ...g, lat: venue?.lat ?? null, lon: venue?.lon ?? null }));
fs.writeFileSync(path.join(CACHE, 'games.json'), JSON.stringify(gamesOut));
fs.writeFileSync(path.join(CACHE, 'team_games.json'), JSON.stringify(teamGames));
fs.writeFileSync(path.join(CACHE, 'player_games.json'), JSON.stringify(playerGames));
const pmeta = {};
for (const r of playerGames) {
  const p = players[r.gsis] || {};
  pmeta[r.gsis] = { name: r.name, pos: r.pos, team: r.team, headshot: p.headshot || statHeadshot[r.gsis] || null, college: p.college || null,
    draft_round: p.draft_round, draft_pick: p.draft_pick, rookie_season: p.rookie_season, birth: p.birth, height: p.height, weight: p.weight };
}
fs.writeFileSync(path.join(CACHE, 'players_meta.json'), JSON.stringify(pmeta));
log('build complete');
