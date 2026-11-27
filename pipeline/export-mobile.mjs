// Builds a single self-contained, phone-friendly HTML page with every week of the season: game environments and
// player projections (data/out/mobile/week.html), with week tabs. It opens on the current week, the week of the
// next game not yet played, so the same link rolls forward on its own. Published as a private page for the Claude app.
// Usage: node pipeline/export-mobile.mjs [season]
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './lib/config.mjs';
import { loadPlayers, calibRows, buildCalib, buildPicks, valueLines, normName, STATS, MIN_EDGE, MAX_EDGE, betInfo, BET_EV, LEAN_EV } from './lib/picks.mjs';
import { CACHE, isTdGame, TD_EXTRA_GAMES } from './lib/config.mjs';

const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8'));
const season = +(process.argv[2] || meta.next_week.season);
const allGames = JSON.parse(fs.readFileSync(path.join(OUT, 'games.json'), 'utf8'))
  .filter(g => g.season === season)
  .sort((a, b) => (a.gameday + a.gametime < b.gameday + b.gametime ? -1 : a.gameday + a.gametime > b.gameday + b.gametime ? 1 : a.game_id < b.game_id ? -1 : 1));

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const f0 = v => (v == null ? '–' : Math.round(v).toString());
const f1 = v => (v == null ? '–' : (Math.round(v * 10) / 10).toFixed(1));
const f1x = f1;
const pct = v => (v == null ? '–' : `${Math.round(v * 100)}%`);
const sgn = v => (v > 0 ? `+${v}` : `${v}`);
const slug = g => `w${g.week}-${g.away}-${g.home}`.toLowerCase();
const weeks = [...new Set(allGames.map(g => g.week))].sort((a, b) => a - b);
const upcoming = allGames.filter(g => !g.done);
const currentWeek = upcoming.length ? upcoming[0].week : weeks.at(-1);

// Confident calls: OVER/UNDER a player's season average where the model is most sure (see pipeline/lib/picks.mjs).
// PICK_SCOPE 'next' shows them only on the next game day's games; 'all' shows every upcoming game.
const PICK_SCOPE = process.env.PICK_SCOPE || 'next';
const nextDay = upcoming.length ? upcoming[0].gameday : null;
const players = loadPlayers(path.join(OUT, 'players'));
const liveCalib = buildCalib(calibRows(players, meta.test_from));
// A player whose role is uncertain (missed his team's last game) gets no call or value play.
const byGsis = Object.fromEntries(players.map(p => [p.gsis, p]));
const lastDone = (team, before) => allGames.filter(x => x.done && (x.home === team || x.away === team) && x.gameday < before).sort((a, b) => (a.gameday < b.gameday ? 1 : -1))[0]?.game_id;
const playedLast = (gsis, team, gameday) => { const id = lastDone(team, gameday); return !id || !!byGsis[gsis]?.log.some(x => x.game_id === id && x.stats); };
const picks = buildPicks(players, liveCalib, season, g => !g.stats && (PICK_SCOPE === 'all' || g.gameday === nextDay), (p, g) => playedLast(p.gsis, g.team, g.gameday));

// Value vs Hard Rock: saved prop lines (pipeline/props.mjs) against the model, graded once games finish.
// Every line gets a tier (bet / lean / check / pass, see betInfo) and graded lines add to a season record in units.
const value = {}, record = { bet: { w: 0, l: 0, pl: 0 }, lean: { w: 0, l: 0, pl: 0 }, check: { w: 0, l: 0, pl: 0 } };
const TIER_ORDER = { bet: 0, lean: 1, check: 2 };
const PER_GAME = 3, CHECKS_PER_GAME = 2;
// Season-average trends: the back-test's top 4 per game hit about 73%; the rest add little.
const TREND_CALLS = 4;
for (const g of allGames) {
  const f = path.join(CACHE, 'props', `${g.game_id}.json`);
  if (!fs.existsSync(f)) continue;
  const props = JSON.parse(fs.readFileSync(f, 'utf8'));
  let sheet = [];
  try { sheet = JSON.parse(fs.readFileSync(path.join(OUT, 'games', `${g.game_id}.json`), 'utf8')); } catch {}
  const all = valueLines(props, sheet, liveCalib, r => playedLast(r.gsis, r.team, g.gameday)).map(x => ({ ...betInfo(x), gid: g.game_id }));
  // Props in one game move together (a low-scoring game sinks every over), so at most PER_GAME bets/leans per game
  // and CHECKS_PER_GAME checks are shown and counted in the record.
  const byEv = (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.ev - a.ev;
  const bets = [...all.filter(x => x.tier === 'bet' || x.tier === 'lean').sort(byEv).slice(0, PER_GAME), ...all.filter(x => x.tier === 'check').sort(byEv).slice(0, CHECKS_PER_GAME)];
  for (const x of bets) if (x.pl != null) { const r = record[x.tier]; if (x.hit != null) r[x.hit ? 'w' : 'l']++; r.pl += x.pl; }
  value[g.game_id] = { fetched: props.fetched_at, all, bets, game: g };
}
const kick = g => {
  const d = new Date(`${g.gameday}T12:00:00`);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const [h, m] = (g.gametime || '').split(':').map(Number);
  const t = Number.isFinite(h) ? `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'} ET` : 'TBD';
  return { day, t };
};

// one short line of the stats that matter for this position
function keyLine(p, actual = false) {
  const s = p.proj || {};
  const f1 = actual ? f0 : f1x;
  const parts = [];
  if (p.pos === 'QB') {
    if (s.attempts) parts.push(`${f1(s.attempts)} att`);
    if (s.passing_yards) parts.push(`${f0(s.passing_yards)} pass yds`);
    if (s.passing_tds) parts.push(`${f1(s.passing_tds)} TD`);
    if (s.passing_interceptions) parts.push(`${f1(s.passing_interceptions)} INT`);
    if (s.rushing_yards >= 5) parts.push(`${f0(s.rushing_yards)} rush yds`);
  } else {
    if (s.carries >= 0.5) parts.push(`${f1(s.carries)} car · ${f0(s.rushing_yards)} yds`);
    if (s.targets >= 0.5) parts.push(`${f1(s.targets)} tgt · ${f1(s.receptions)} rec · ${f0(s.receiving_yards)} yds`);
    const td = (s.rushing_tds || 0) + (s.receiving_tds || 0);
    if (td >= 0.05) parts.push(`${f1(td)} TD`);
  }
  return parts.join(' · ');
}

function teamBlock(g, side) {
  const team = g[side];
  let sheet = [];
  try { sheet = JSON.parse(fs.readFileSync(path.join(OUT, 'games', `${g.game_id}.json`), 'utf8')); } catch {}
  const done = g.done;
  const val = r => (done ? r.stats?.fantasy_points_ppr : r.proj?.fantasy_points_ppr) ?? 0;
  const rows = sheet.filter(r => r.team === team).sort((a, b) => val(b) - val(a));
  const active = rows.filter(r => (done ? Math.max(val(r), r.proj?.fantasy_points_ppr ?? 0) >= 1 && r.stats : (r.proj?.fantasy_points_ppr ?? 0) >= 1) && !/^Out/.test(r.injury || ''));
  const out = rows.filter(r => /^Out/.test(r.injury || ''));
  const max = Math.max(20, ...active.map(r => r.range?.fantasy_points_ppr?.[18] ?? 0));
  const pts = g.pred?.[`${side}_pts`];
  const body = active.map(r => {
    const ppr = r.proj?.fantasy_points_ppr, rg = r.range?.fantasy_points_ppr;
    const lo = rg ? rg[2] : null, hi = rg ? rg[18] : null;
    const tag = r.injury ? `<span class="tag ${/Doubtful/.test(r.injury) ? 'bad' : 'warn'}">${esc(r.injury.split(' ')[0])}</span>` : '';
    const bar = rg ? `<span class="rg" aria-hidden="true"><i style="left:${(lo / max) * 100}%;width:${((hi - lo) / max) * 100}%"></i><b style="left:${(ppr / max) * 100}%"></b></span>` : '';
    if (done) {
      const act = r.stats?.fantasy_points_ppr, diff = act != null && ppr != null ? act - ppr : null;
      return `<tr><td class="who"><span class="nm">${esc(r.name)}</span> <span class="pos">${r.pos}</span><div class="kl">${esc(keyLine({ pos: r.pos, proj: r.stats }, true))}</div></td>
      <td class="ppr">${f1(act)}<div class="rng">proj ${f1(ppr)}${diff != null && Math.abs(diff) >= 0.05 ? ` · <span class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : '−'}${f1(Math.abs(diff))}</span>` : ''}</div></td></tr>`;
    }
    return `<tr><td class="who"><span class="nm">${esc(r.name)}</span> <span class="pos">${r.pos}</span>${tag}<div class="kl">${esc(keyLine(r))}</div></td>
      <td class="ppr">${f1(ppr)}<div class="rng">${f1(lo)}–${f1(hi)}</div>${bar}</td></tr>`;
  }).join('');
  const outLine = !done && out.length ? `<p class="out">Out: ${out.map(r => `${esc(r.name)} <span class="muted">(${esc((r.injury.match(/\((.*)\)/) || [])[1] || 'Out')})</span>`).join(', ')}</p>` : '';
  return `<section class="team"><h3><span>${team}</span><span class="side">${side}</span><span class="tp">${done ? `${g[`${side}_score`]} pts · proj ${f1(pts)}` : `${f1(pts)} pts proj`}</span></h3>
    ${active.length ? `<div class="tw"><table><thead><tr><th>Player</th><th>${done ? 'PPR · vs projection' : 'PPR · 80% range'}</th></tr></thead><tbody>${body}</tbody></table></div>` : '<p class="muted">No projections yet.</p>'}
    ${outLine}</section>`;
}

function picksBlock(list, g) {
  if (!list?.length) return '';
  const fmt = (k, v) => (k === 'fantasy_points_ppr' || k === 'receptions' || k === 'carries' || k === 'completions' ? f1(v) : f0(v));
  // Hard Rock's line on the same player and stat, when it was pulled: the model's chance at the book's number,
  // the book's fair chance (vig removed) and the gap. The side is whichever the model prefers at that number.
  const note = `<p class="vnote">Against the player's season average, not Hard Rock's line. Not a bet on its own.</p>`;
  return `<div class="picks"><h4>Season-average trends</h4><ul>${list.map(c => `<li>
    <span class="dir ${c.over ? 'over' : 'under'}">${c.over ? 'Over' : 'Under'}</span>
    <span class="what"><b>${esc(c.name)}</b> <span class="pos">${c.pos}</span> ${c.line} ${c.label}
      <span class="why">avg ${fmt(c.k, c.avg)} in ${c.games} games · proj ${fmt(c.k, c.proj)}</span></span>
    <span class="conf">${Math.round(c.conf * 100)}%</span></li>`).join('')}</ul>${note}</div>`;
}

// One line of the bet list: what to bet at Hard Rock, the tier and stake, and why.
const TIER_LABEL = { bet: 'Bet', lean: 'Lean', check: 'Check' };
const fmtPrice = p => (p > 0 ? `+${p}` : `${p}`);
const fmtU = u => `${u > 0 ? '+' : u < 0 ? '−' : ''}${(Math.round(Math.abs(u) * 100) / 100).toFixed(2).replace(/\.?0+$/, '') || '0'}u`;
function betRow(x, showGame) {
  const g = value[x.gid]?.game;
  const stat = STATS[x.stat]?.label || x.stat;
  const pr = ['receptions', 'carries', 'completions', 'attempts'].includes(x.stat) ? f1(x.proj) : f0(x.proj);
  const where = showGame && g ? `${g.away}@${g.home} ${g.done ? 'final' : kick(g).t.replace(' ET', '')} · ` : '';
  const right = x.act == null ? `<span class="ev">+${Math.round(x.ev * 100)}%</span><span class="evl">exp. return</span>`
    : x.hit == null ? '<span>Push</span>' : `<span class="${x.hit ? 'up' : 'down'}">${x.hit ? 'Hit' : 'Miss'}</span><span class="evl">${x.tier === 'check' ? 'if bet ' : ''}${fmtU(x.pl)}</span>`;
  return `<li class="bet ${x.tier}">
    <span class="tier">${TIER_LABEL[x.tier]}${x.tier === 'check' ? '' : `<small>${x.units === 1 ? '1u' : '½u'}</small>`}</span>
    <span class="what"><b>${esc(x.name)}</b> <span class="pos">${x.pos}</span><span class="slip">${x.over ? 'Over' : 'Under'} ${x.line} ${stat} <span class="px">${fmtPrice(x.price)}</span></span>
      <span class="why">${where}model ${Math.round(x.model * 100)}% · need ${Math.round(x.breakeven * 100)}% · proj ${pr}${x.act != null ? ` · actual ${x.act}` : ''}${x.tier === 'check' ? ' · confirm role/injury news first' : ''}</span></span>
    <span class="conf">${right}</span></li>`;
}
const linesAt = v => new Date(v.fetched).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
function valueBlock(g) {
  const v = value[g.game_id];
  if (!v) return g.done ? '' : `<div class="picks value"><h4>Hard Rock bets</h4><p class="vnote">Lines are added about 3 hours before kickoff.</p></div>`;
  return `<div class="picks value"><h4>Hard Rock bets</h4>
  ${v.bets.length ? `<ul>${v.bets.map(x => betRow(x, false)).join('')}</ul>` : `<p class="vnote">Nothing worth betting: no line clears the price.</p>`}
  <p class="vnote">Hard Rock lines from ${linesAt(v)} ET · ${v.all.length} lines checked.</p></div>`;
}

// Bet board: every bet, lean and check across the week's games in one list, best first, with the week's graded result.
// Kickoff has passed but the result isn't in the data yet: no longer bettable, not yet graded.
const etOffset = d => (new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })) - new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }))) / 36e5;
const started = g => { if (g.done || !g.gametime) return !!g.done; const t = new Date(`${g.gameday}T${g.gametime}:00Z`); return Date.now() > t.getTime() - etOffset(t) * 36e5; };
function boardBlock(w) {
  const vs = Object.values(value).filter(v => v.game.week === w);
  if (!vs.length) return allGames.some(g => g.week === w && !g.done) ? `<section class="board"><h3>Bet board <span>Hard Rock</span></h3><p class="vnote">Bets show up here when each game's Hard Rock lines are pulled, about 3 hours before kickoff.</p></section>` : '';
  const live = vs.filter(v => !v.game.done && started(v.game)).length;
  const openAll = vs.filter(v => !started(v.game)).flatMap(v => v.bets).sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.ev - a.ev);
  const open = openAll.filter(x => x.tier !== 'check'), checks = openAll.filter(x => x.tier === 'check');
  const graded = vs.filter(v => v.game.done).flatMap(v => v.bets).filter(x => x.tier !== 'check');
  const w_ = graded.filter(x => x.hit === true).length, l_ = graded.filter(x => x.hit === false).length, pl = graded.reduce((a, x) => a + (x.pl || 0), 0);
  const pending = allGames.filter(g => g.week === w && !g.done && !value[g.game_id]).length;
  return `<section class="board"><h3>Bet board <span>Hard Rock · best first</span></h3>
  ${open.length ? `<ul>${open.map(x => betRow(x, true)).join('')}</ul>` : `<p class="vnote">${vs.some(v => !started(v.game)) ? 'No open line clears the price.' : 'No open games with lines yet.'}${live ? ` ${live} game${live > 1 ? 's' : ''} already kicked off, graded once the box score is in.` : ''}</p>`}
  ${checks.length ? `<details class="more"><summary>Check news first (${checks.length})</summary><ul>${checks.map(x => betRow(x, true)).join('')}</ul></details>` : ''}
  ${graded.length ? `<p class="wkres">This week so far (bets + leans): ${w_}–${l_} · <span class="${pl >= 0 ? 'up' : 'down'}">${fmtU(pl)}</span></p>` : ''}
  <p class="vnote"><b>Bet</b> = model's chance beats the break-even at Hard Rock's price by ${Math.round(BET_EV * 100)}%+ expected return and the projection agrees (1 unit). <b>Lean</b> = ${Math.round(LEAN_EV * 100)}%+ (½ unit). <b>Check</b> = gap so big it's often news the model missed; bet only after confirming the player's role. At most ${PER_GAME} bets/leans per game, since props in one game rise and fall together. "Need" is the break-even win rate at that price.${pending ? ` ${pending} more game${pending > 1 ? 's' : ''} get lines about 3 hours before kickoff.` : ''}</p></section>`;
}

// Best TD chances: the week's 10 players most likely to score a rushing or receiving TD in Sunday and Monday games.
// P(at least one) = 1 - exp(-(projected rush TDs + rec TDs)); back-tested in pipeline/experiments/td-exp.mjs.
const implied = a => (a < 0 ? -a / (-a + 100) : 100 / (a + 100));
function tdBlock(w) {
  const games = allGames.filter(g => g.week === w && isTdGame(g));
  const rows = [];
  for (const g of games) {
    let sheet = [];
    try { sheet = JSON.parse(fs.readFileSync(path.join(OUT, 'games', `${g.game_id}.json`), 'utf8')); } catch {}
    const f = path.join(CACHE, 'props', `${g.game_id}.json`);
    const td = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).td || [] : [];
    for (const r of sheet) {
      if (!r.proj || (!g.done && r.injury) || !playedLast(r.gsis, r.team, g.gameday)) continue;
      const rush = r.proj.rushing_tds || 0, rec = r.proj.receiving_tds || 0;
      const hr = td.find(t => normName(t.player) === normName(r.name));
      const scored = r.stats ? (r.stats.rushing_tds || 0) + (r.stats.receiving_tds || 0) : null;
      rows.push({ r, g, rush, rec, p: 1 - Math.exp(-(rush + rec)), hr: hr?.price, scored });
    }
  }
  if (!rows.length) return '';
  const top = rows.sort((a, b) => b.p - a.p).slice(0, 10);
  const graded = top.filter(x => x.scored != null);
  const tdLine = x => [x.rush >= 0.05 ? `${f1(x.rush)} rush` : '', x.rec >= 0.05 ? `${f1(x.rec)} rec` : ''].filter(Boolean).join(' + ');
  return `<section class="tdbox"><h3>Best TD chances <span>${games.some(g => TD_EXTRA_GAMES.has(g.game_id)) ? 'all games this week' : 'Sunday and Monday games'}</span></h3><ol>${top.map(x => {
    const opp = x.r.team === x.g.home ? `vs ${x.g.away}` : `@ ${x.g.home}`;
    const hr = x.hr != null ? ` · Hard Rock ${x.hr > 0 ? '+' : ''}${x.hr} (${Math.round(implied(x.hr) * 100)}%)` : '';
    const res = x.scored == null ? `${Math.round(x.p * 100)}%` : x.scored ? `<span class="up">${x.scored} TD</span>` : '<span class="down">No TD</span>';
    return `<li><span class="what"><b>${esc(x.r.name)}</b> <span class="pos">${x.r.pos}</span> ${x.r.team} ${opp}
      <span class="why">proj ${tdLine(x)} TD${hr}${x.scored != null ? ` · model ${Math.round(x.p * 100)}%` : ''}</span></span><span class="conf">${res}</span></li>`;
  }).join('')}</ol>
  <p class="vnote">${graded.length === top.length ? `${graded.filter(x => x.scored).length} of 10 scored. ` : ''}Chance of at least one rushing or receiving TD. In 2025–26 games the model hadn't seen, weekly top-10 lists were claimed at about 53% and scored 53–64% of the time.${top.some(x => x.hr != null) ? " Hard Rock's percentage includes its vig." : ''}</p></section>`;
}

function gameCard(g) {
  const p = g.pred || {};
  const { day, t } = kick(g);
  const fav = g.spread_line == null ? null : g.spread_line > 0 ? `${g.home} −${g.spread_line}` : g.spread_line < 0 ? `${g.away} −${-g.spread_line}` : 'PK';
  const mfav = p.margin == null ? '–' : p.margin >= 0 ? `${g.home} −${f1(p.margin)}` : `${g.away} −${f1(-p.margin)}`;
  const wx = g.indoor ? 'Indoors' : g.temp != null ? `${Math.round(g.temp)}°F · wind ${Math.round(g.wind ?? 0)} mph${g.precip > 0.02 ? ` · rain ${g.precip.toFixed(2)}"` : ''}` : 'Forecast pending';
  const wp = p.home_wp;
  const lean = p.total != null && g.total_line != null && Math.abs(p.total - g.total_line) >= 3 ? `<span class="lean">Model leans ${p.total > g.total_line ? 'over' : 'under'}</span>` : '';
  if (g.done) { // who actually took the snaps, from the box score
    let sheet = [];
    try { sheet = JSON.parse(fs.readFileSync(path.join(OUT, 'games', `${g.game_id}.json`), 'utf8')); } catch {}
    for (const side of ['home', 'away']) {
      const qb = sheet.filter(r => r.team === g[side] && r.pos === 'QB').sort((a, b) => (b.stats?.attempts ?? 0) - (a.stats?.attempts ?? 0))[0];
      if (qb?.stats?.attempts) g[`${side}_qb`] = qb.name;
    }
  }
  const qbs = [g.away_qb, g.home_qb].every(Boolean) ? `<p class="qbs">QBs: ${esc(g.away_qb)} vs ${esc(g.home_qb)}</p>` : '';
  return `<details class="game" id="${slug(g)}">
  <summary>
    <div class="when"><span>${day}</span><span>${g.done ? `<b class="final">Final</b> · proj ${f1(p.away_pts)}–${f1(p.home_pts)}` : t}</span></div>
    <div class="match"><span class="ab">${g.away}</span><span class="sc${g.done ? ' fin' : ''}">${g.done ? g.away_score : f1(p.away_pts)}</span><span class="at">@</span><span class="ab">${g.home}</span><span class="sc${g.done ? ' fin' : ''}">${g.done ? g.home_score : f1(p.home_pts)}</span></div>
    <div class="wp" role="img" aria-label="${g.home} win probability ${pct(wp)}"><i style="width:${wp != null ? (1 - wp) * 100 : 50}%"></i></div>
    <div class="lines">
      <div><em>Spread</em><b>${mfav}</b><span>Vegas ${fav ?? '–'}</span></div>
      <div><em>Total</em><b>${f1(p.total)}</b><span>Vegas ${g.total_line ?? '–'}</span></div>
      <div><em>Win</em><b>${wp == null ? '–' : wp >= 0.5 ? `${g.home} ${pct(wp)}` : `${g.away} ${pct(1 - wp)}`}</b><span>ML ${g.home_ml != null ? `${g.home} ${sgn(g.home_ml)}` : '–'}</span></div>
    </div>
    <div class="ctx"><span>${esc(wx)}</span>${lean}<span class="chev" aria-hidden="true"></span></div>
    ${valueBlock(g)}
    ${picksBlock(picks[g.game_id]?.slice(0, TREND_CALLS), g)}
  </summary>
  <div class="body">${qbs}${teamBlock(g, 'home')}${teamBlock(g, 'away')}</div>
</details>`;
}

// Each week's cards go in their own file (weeks/wN.html) that the page fetches when the week is opened. That keeps
// the page itself small, which the publish step needs: it has to read the live page in full before replacing it.
const fragments = {};
for (const w of weeks) {
  const games = allGames.filter(g => g.week === w);
  const nDone = games.filter(g => g.done).length;
  const status = nDone === games.length ? 'Final results vs projections' : nDone ? `${nDone} of ${games.length} games final` : `${games.length} games`;
  let lastDay = '', cards = '';
  for (const g of games) {
    const { day } = kick(g);
    if (day !== lastDay) { cards += `<h3 class="day">${day}</h3>`; lastDay = day; }
    cards += gameCard(g);
  }
  fragments[w] = `<div class="wk-head"><h2>Week ${w}${w === currentWeek ? ' <span>this week</span>' : ''}</h2><p>${status}</p></div>
<nav class="jump" aria-label="Jump to game">${games.map(g => `<a href="#${slug(g)}">${g.away}@${g.home}</a>`).join('')}</nav>
${boardBlock(w)}
${tdBlock(w)}
${cards}`;
}
const VERSION = Date.now().toString(36);

const stamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const html = `<title>Gridiron Lab Weekly</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Inter:wght@400;500;600&display=swap">
<style>
/* Layout: one column of kickoff-ordered game cards; tap a card to open its home/away projection sheets. */
:root {
  --bg: #f3f4f1; --card: #ffffff; --line: #dfe1db; --fg: #121411; --fg2: #50554c; --muted: #868b80;
  --turf: #2f7d4a; --turf-soft: #e1efe5; --chalk: #c9cdc3; --warn: #a86b00; --warn-bg: #f8edd6; --bad: #c23b33; --bad-bg: #f8e2e0;
  --display: 'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif; --body: Inter, system-ui, -apple-system, sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f120f; --card: #181c18; --line: #2a302a; --fg: #eef1ea; --fg2: #c0c6b9; --muted: #868d80;
  --turf: #5cc27f; --turf-soft: #1b3122; --chalk: #3a423a; --warn: #e6b04a; --warn-bg: #3a2e14; --bad: #f07b72; --bad-bg: #3d1d1b; color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #0f120f; --card: #181c18; --line: #2a302a; --fg: #eef1ea; --fg2: #c0c6b9; --muted: #868d80;
  --turf: #5cc27f; --turf-soft: #1b3122; --chalk: #3a423a; --warn: #e6b04a; --warn-bg: #3a2e14; --bad: #f07b72; --bad-bg: #3d1d1b; color-scheme: dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { background: var(--bg); color: var(--fg); font: 14px/1.4 var(--body); font-variant-numeric: tabular-nums; }
.wrap { max-width: 760px; margin: 0 auto; padding-block: 18px 40px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 12px; }
header h1 { font: 700 34px/1 var(--display); letter-spacing: .01em; text-transform: uppercase; margin: 0; text-wrap: balance; }
header h1 span { color: var(--turf); }
header p { margin: 6px 0 0; color: var(--fg2); font-size: 13px; }
.muted { color: var(--muted); }
.jump { display: flex; flex-wrap: wrap; gap: 6px; }
.jump a { font: 600 13px/1 var(--display); letter-spacing: .04em; color: var(--fg2); text-decoration: none; border: 1px solid var(--line); background: var(--card); border-radius: 6px; padding: 6px 8px; }
.day { margin: 10px 0 0 !important; font: 700 15px/1 var(--display); text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 10px 0 0; }
.game { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.game[open] { border-color: var(--turf); }
summary { list-style: none; cursor: pointer; padding: 12px 14px; display: grid; gap: 8px; }
summary::-webkit-details-marker { display: none; }
summary:focus-visible { outline: 2px solid var(--turf); outline-offset: -2px; }
.when { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }
.match { display: grid; grid-template-columns: auto auto 1fr auto auto; align-items: baseline; gap: 8px; font-family: var(--display); }
.match .ab { font-size: 28px; font-weight: 700; letter-spacing: .02em; }
.match .sc { font-size: 22px; font-weight: 600; color: var(--fg2); }
.match .at { text-align: center; color: var(--muted); font-size: 16px; }
.wp { height: 5px; border-radius: 3px; background: var(--turf); overflow: hidden; }
.wp i { display: block; height: 100%; background: var(--chalk); border-right: 2px solid var(--card); }
.lines { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.lines div { background: var(--bg); border-radius: 8px; padding: 6px 8px; display: grid; gap: 1px; min-width: 0; }
.lines em { font-style: normal; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.lines b { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lines span { font-size: 11px; color: var(--fg2); }
.ctx { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--fg2); }
.lean { background: var(--turf-soft); color: var(--turf); border-radius: 999px; padding: 1px 8px; font-weight: 600; }
.chev { margin-left: auto; width: 9px; height: 9px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(45deg); transition: transform .15s; }
.game[open] .chev { transform: rotate(-135deg); }
.body { border-top: 1px solid var(--line); padding: 4px 14px 14px; display: grid; gap: 14px; }
.qbs { margin: 8px 0 0; font-size: 12px; color: var(--fg2); }
.team h3 { display: flex; align-items: baseline; gap: 8px; margin: 6px 0 6px; font: 700 20px/1 var(--display); letter-spacing: .03em; }
.team h3 .side { font: 500 11px var(--body); text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.team h3 .tp { margin-left: auto; font: 500 12px var(--body); color: var(--fg2); }
.tw { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 600; padding: 4px 0; border-bottom: 1px solid var(--line); }
th:last-child, td.ppr { text-align: right; }
td { padding: 7px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.nm { font-weight: 600; }
.pos { font-size: 10px; font-weight: 700; color: var(--fg2); background: var(--bg); border-radius: 4px; padding: 1px 5px; margin-left: 2px; }
.tag { font-size: 10px; font-weight: 600; border-radius: 999px; padding: 1px 6px; margin-left: 4px; }
.tag.warn { background: var(--warn-bg); color: var(--warn); }
.tag.bad { background: var(--bad-bg); color: var(--bad); }
.kl { font-size: 12px; color: var(--fg2); margin-top: 2px; }
td.ppr { font: 600 18px/1.1 var(--display); width: 112px; padding-left: 10px; }
.rng { font: 400 11px var(--body); color: var(--muted); }
.rg { position: relative; display: block; height: 10px; margin-top: 3px; }
.rg i { position: absolute; top: 3px; height: 4px; border-radius: 2px; background: var(--turf-soft); }
.rg b { position: absolute; top: 0; width: 3px; height: 10px; margin-left: -1px; border-radius: 1px; background: var(--turf); }
.out { margin: 6px 0 0; font-size: 12px; color: var(--fg2); }
footer { font-size: 12px; color: var(--muted); }
.picks { border-top: 1px dashed var(--line); padding-top: 8px; }
.picks h4 { margin: 0 0 4px; font: 700 12px/1 var(--body); text-transform: uppercase; letter-spacing: .08em; color: var(--turf); }
.picks ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.picks li { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; gap: 8px; align-items: start; }
.picks .dir { font: 700 11px/1 var(--body); text-transform: uppercase; letter-spacing: .06em; text-align: center; border-radius: 5px; padding: 4px 0; }
.picks .dir.over { background: var(--turf); color: var(--card); }
.picks .dir.under { border: 1px solid var(--fg2); color: var(--fg); }
.picks .what { font-size: 13px; min-width: 0; }
.picks .why { display: block; font-size: 11px; color: var(--muted); }
.picks .conf { font: 700 18px/1 var(--display); }
.picks.value h4 { color: var(--fg2); }
.picks .hr { display: block; font-size: 11px; color: var(--fg2); margin-top: 2px; }
.picks .hr.good { color: var(--turf); font-weight: 700; }
.picks .hr.big { color: var(--muted); }
.vsub { margin: 8px 0 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--warn); }
.vnote { margin: 6px 0 0; font-size: 11px; color: var(--muted); }
.record { font-size: 12px; color: var(--fg2); }
.tdbox { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
.tdbox h3 { margin: 0 0 8px; font: 700 20px/1 var(--display); text-transform: uppercase; letter-spacing: .02em; display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.tdbox h3 span { font: 500 11px var(--body); text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.tdbox ol { margin: 0; padding-left: 22px; display: grid; gap: 7px; }
.tdbox li::marker { font: 700 14px var(--display); color: var(--turf); }
.tdbox li > span { display: inline; }
.tdbox li { font-size: 13px; }
.tdbox li .what { display: inline-block; width: calc(100% - 52px); vertical-align: top; min-width: 0; }
.tdbox li .conf { float: right; font: 700 18px/1 var(--display); }
.tdbox .why { display: block; font-size: 11px; color: var(--muted); }
.weeks { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
.weeks::-webkit-scrollbar { display: none; }
.weeks a { flex: none; min-width: 44px; text-align: center; font: 700 15px/1 var(--display); color: var(--fg2); text-decoration: none; border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 9px 10px; }
.weeks a.cur { border-color: var(--turf); color: var(--turf); }
.weeks a.on { background: var(--turf); border-color: var(--turf); color: var(--card); }
.weeks a:focus-visible, .jump a:focus-visible { outline: 2px solid var(--turf); outline-offset: 2px; }
.week { display: grid; gap: 12px; }
.wk-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.wk-head h2 { margin: 0; font: 700 30px/1 var(--display); text-transform: uppercase; letter-spacing: .01em; }
.wk-head h2 span { color: var(--turf); }
.wk-head p { margin: 0; font-size: 12px; color: var(--muted); }
.final { color: var(--fg); font-weight: 600; }
.sc.fin { color: var(--fg); font-weight: 700; }
.up { color: var(--turf); } .down { color: var(--bad); }
.board { background: var(--card); border: 2px solid var(--turf); border-radius: 12px; padding: 12px 14px; }
.board h3 { margin: 0 0 8px; font: 700 22px/1 var(--display); text-transform: uppercase; letter-spacing: .02em; display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.board h3 span { font: 500 11px var(--body); text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.board ul, .picks.value ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
li.bet { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 8px; align-items: start; }
li.bet .tier { font: 700 12px/1 var(--body); text-transform: uppercase; letter-spacing: .04em; text-align: center; border-radius: 6px; padding: 5px 0 4px; display: grid; gap: 2px; }
li.bet .tier small { font: 600 10px/1 var(--body); text-transform: none; letter-spacing: 0; opacity: .85; }
li.bet.bet .tier { background: var(--turf); color: var(--card); }
li.bet.lean .tier { background: var(--turf-soft); color: var(--turf); }
li.bet.check .tier { background: var(--warn-bg); color: var(--warn); }
li.bet .what { font-size: 13px; min-width: 0; }
li.bet .slip { display: block; font-weight: 600; margin-top: 1px; }
li.bet .px { color: var(--fg2); font-weight: 500; }
li.bet .why { display: block; font-size: 11px; color: var(--muted); }
li.bet .conf { display: grid; justify-items: end; gap: 1px; font: 700 18px/1 var(--display); }
li.bet .evl { font: 500 10px var(--body); color: var(--muted); }
.board details.more { margin-top: 10px; }
.board details.more summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--warn); padding: 4px 0 8px; }
.wkres { margin: 8px 0 0; font-size: 12px; font-weight: 600; color: var(--fg2); }
@media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
</style>
<div class="wrap">
<header>
  <h1>Gridiron <span>Lab</span></h1>
  <p>${season} season · updated ${esc(stamp)} ET · tap a game for player projections</p>
  ${['bet', 'lean', 'check'].some(k => record[k].w + record[k].l) ? `<p class="record">Season vs Hard Rock: Bets ${record.bet.w}–${record.bet.l} <span class="${record.bet.pl >= 0 ? 'up' : 'down'}">${fmtU(record.bet.pl)}</span> · Leans ${record.lean.w}–${record.lean.l} <span class="${record.lean.pl >= 0 ? 'up' : 'down'}">${fmtU(record.lean.pl)}</span> · Checks ${record.check.w}–${record.check.l} <span class="${record.check.pl >= 0 ? 'up' : 'down'}">${fmtU(record.check.pl)}</span></p>` : ''}
</header>
<nav class="weeks" aria-label="Choose week">${weeks.map(w => `<a href="#w${w}" data-w="${w}" class="${w === currentWeek ? 'cur' : ''}">${w}</a>`).join('')}</nav>
${weeks.map(w => `<section class="week" id="w${w}" data-w="${w}" hidden><p class="muted">Loading Week ${w}…</p></section>`).join('')}
<footer>Model scores never see the betting line. PPR projections show the median with an 80% range (10th–90th percentile). Injury tags come from the latest official report. Before Wednesday's report, players who missed last week show as Questionable. Season-average trends compare the projection with the player's season average (3+ games) on pass attempts, completions, pass yards, carries, rush yards, receptions and receiving yards; the percentage is the chance of the call hitting, from how projections like it played out in 2025–26 games the model had not seen. In that back-test the top 4 calls per game hit about 73%.</footer>
</div>
<script>
// Week tabs: #w12 shows week 12, #w12-kc-buf shows week 12 and opens that game; no hash shows the current week.
const CURRENT = ${currentWeek}, VERSION = '${VERSION}';
function load(s) {
  if (s.dataset.loaded) return Promise.resolve();
  s.dataset.loaded = '1';
  return fetch('weeks/w' + s.dataset.w + '.html?v=' + VERSION)
    .then(r => (r.ok ? r.text() : Promise.reject(r.status)))
    .then(t => { s.innerHTML = t; })
    .catch(() => { delete s.dataset.loaded; s.innerHTML = '<p class="muted">Week ' + s.dataset.w + ' didn\u2019t load. Check your connection and tap the week again.</p>'; });
}
function showWeek(w) {
  let shown = null;
  document.querySelectorAll('section.week').forEach(s => { s.hidden = +s.dataset.w !== w; if (!s.hidden) shown = s; });
  document.querySelectorAll('.weeks a').forEach(a => {
    const on = +a.dataset.w === w;
    a.classList.toggle('on', on);
    if (on) { a.setAttribute('aria-current', 'page'); a.scrollIntoView({ block: 'nearest', inline: 'center' }); } else a.removeAttribute('aria-current');
  });
  return shown ? load(shown) : Promise.resolve();
}
function route() {
  const id = decodeURIComponent(location.hash.slice(1));
  const m = /^w([0-9]+)/.exec(id);
  showWeek(m && document.getElementById('w' + m[1]) ? +m[1] : CURRENT).then(() => {
    const el = id && document.getElementById(id);
    if (el && el.tagName === 'DETAILS') { el.open = true; el.scrollIntoView({ block: 'start' }); }
    else if (m) window.scrollTo(0, 0);
  });
}
window.addEventListener('hashchange', route);
route();
</script>
`;
const dir = path.join(OUT, 'mobile');
fs.mkdirSync(dir, { recursive: true });
fs.rmSync(path.join(dir, 'weeks'), { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'weeks'), { recursive: true });
for (const [w, frag] of Object.entries(fragments)) fs.writeFileSync(path.join(dir, 'weeks', `w${w}.html`), frag);
fs.writeFileSync(path.join(dir, 'week.html'), html);
console.log(`wrote data/out/mobile/week.html (${allGames.length} games, weeks ${weeks[0]}-${weeks.at(-1)}, opens on week ${currentWeek}, page ${(html.length / 1024).toFixed(0)} KB + ${weeks.length} week files)`);
