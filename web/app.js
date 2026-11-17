// Gridiron Lab front-end: hash-routed single page app over the JSON produced by the pipeline.
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const cache = {};
const getJSON = async url => (cache[url] ??= fetch(url).then(r => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }));

// ------------------------------------------------------------------ formatting helpers
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f1 = v => (v == null ? '–' : (+v).toFixed(1));
const f0 = v => (v == null ? '–' : Math.round(v).toString());
const f2 = v => (v == null ? '–' : (+v).toFixed(2));
const pct = (v, d = 0) => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);
const sgn = (v, d = 1) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);
const spreadTxt = v => (v == null ? '–' : v === 0 ? 'PK' : sgn(v, 1).replace('+', '+'));
const day = d => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
function kick(t) {
  if (!t) return 'TBD';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'} ET`;
}
const tip = (title, lines) => esc(JSON.stringify({ t: title, l: lines }));
const STAT_LABEL = {
  fantasy_points_ppr: 'PPR pts', attempts: 'Pass att', completions: 'Comp', passing_yards: 'Pass yds', passing_tds: 'Pass TD', passing_interceptions: 'INT',
  carries: 'Carries', rushing_yards: 'Rush yds', rushing_tds: 'Rush TD', targets: 'Targets', receptions: 'Rec', receiving_yards: 'Rec yds', receiving_tds: 'Rec TD',
};
const POS_STATS = {
  QB: ['attempts', 'completions', 'passing_yards', 'passing_tds', 'passing_interceptions', 'carries', 'rushing_yards', 'rushing_tds'],
  RB: ['carries', 'rushing_yards', 'rushing_tds', 'targets', 'receptions', 'receiving_yards', 'receiving_tds'],
  WR: ['targets', 'receptions', 'receiving_yards', 'receiving_tds', 'carries', 'rushing_yards'],
  TE: ['targets', 'receptions', 'receiving_yards', 'receiving_tds'],
};
const roofTxt = g => (g.indoor ? (g.roof === 'closed' ? 'Roof closed' : 'Dome') : g.roof === 'open' ? 'Roof open' : 'Outdoors');

// P(X > line) from the 21-point quantile vector (0%,5%,…,100%)
function probOver(q, line) {
  if (!q) return null;
  let F = 0;
  for (let i = 0; i < q.length; i++) {
    if (q[i] <= line) F = i / (q.length - 1);
    else {
      if (i > 0 && q[i] > q[i - 1] && q[i - 1] <= line) F = (i - 1 + (line - q[i - 1]) / (q[i] - q[i - 1])) / (q.length - 1);
      break;
    }
  }
  return Math.min(0.99, Math.max(0.01, 1 - F));
}

// ------------------------------------------------------------------ tooltips (event delegation)
const tipEl = $('#tip');
document.addEventListener('mousemove', e => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) { tipEl.hidden = true; return; }
  const { t: title, l } = JSON.parse(t.dataset.tip);
  tipEl.innerHTML = `<b>${esc(title)}</b>${l.map(x => `<div>${esc(x)}</div>`).join('')}`;
  tipEl.hidden = false;
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  tipEl.style.left = `${Math.min(window.innerWidth - w - 8, e.clientX + 14)}px`;
  tipEl.style.top = `${e.clientY + 14 + h > window.innerHeight ? e.clientY - h - 10 : e.clientY + 14}px`;
});

// ------------------------------------------------------------------ theme
const themeBtn = $('#theme');
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
themeBtn.onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
};

// ------------------------------------------------------------------ shared data
let META, GAMES, GBY;
async function base() {
  if (META) return;
  [META, GAMES] = await Promise.all([getJSON('/data/meta.json'), getJSON('/data/games.json')]);
  GBY = Object.fromEntries(GAMES.map(g => [g.game_id, g]));
  $('#foot').innerHTML = `Data: nflverse (play-by-play, player stats, PFR snap counts &amp; advanced stats, Next Gen Stats, injuries, schedules &amp; Vegas lines) · Weather: Open-Meteo · Updated ${new Date(META.updated).toLocaleString()} · For entertainment &amp; research only.`;
}
function record(team, season, beforeOrder) {
  let w = 0, l = 0, t = 0;
  for (const g of GAMES) {
    if (g.season !== season || g.game_type !== 'REG' || !g.done || g.gameday >= beforeOrder) continue;
    if (g.home !== team && g.away !== team) continue;
    const m = (g.home === team ? 1 : -1) * (g.home_score - g.away_score);
    if (m > 0) w++; else if (m < 0) l++; else t++;
  }
  return `${w}-${l}${t ? '-' + t : ''}`;
}

// ------------------------------------------------------------------ search
const searchEl = $('#search'), resEl = $('#search-results');
let PLAYERS = null, selIdx = -1;
searchEl.addEventListener('focus', async () => { PLAYERS ??= await getJSON('/data/players.json'); });
searchEl.addEventListener('input', async () => {
  PLAYERS ??= await getJSON('/data/players.json');
  const q = searchEl.value.trim().toLowerCase();
  if (q.length < 2) { resEl.hidden = true; return; }
  const hits = PLAYERS.filter(p => p.name?.toLowerCase().includes(q)).slice(0, 12);
  selIdx = -1;
  resEl.innerHTML = hits.map(p => `<a href="#/player/${p.gsis}">${p.headshot ? `<img class="avatar sm" src="${esc(p.headshot)}" alt="">` : '<span class="avatar sm"></span>'}
    <span><b>${esc(p.name)}</b> <span class="pos">${p.pos}</span><br><span class="muted">${p.team} · ${p.last_season}${p.season_fp != null ? ` · ${f1(p.season_fp)} PPR/g` : ''}</span></span></a>`).join('') || '<div class="muted" style="padding:10px">No players</div>';
  resEl.hidden = false;
});
searchEl.addEventListener('keydown', e => {
  const items = [...resEl.querySelectorAll('a')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    selIdx = Math.max(0, Math.min(items.length - 1, selIdx + (e.key === 'ArrowDown' ? 1 : -1)));
    items.forEach((a, i) => a.classList.toggle('sel', i === selIdx));
  } else if (e.key === 'Enter' && items.length) { location.hash = items[Math.max(0, selIdx)].getAttribute('href'); resEl.hidden = true; searchEl.blur(); }
  else if (e.key === 'Escape') { resEl.hidden = true; }
});
document.addEventListener('click', e => { if (!e.target.closest('.search')) resEl.hidden = true; else if (e.target.closest('a')) resEl.hidden = true; });

// ------------------------------------------------------------------ router
const routes = [
  [/^#?\/?$/, () => slate()],
  [/^#\/week\/(\d+)\/(\d+)$/, (s, w) => slate(+s, +w)],
  [/^#\/game\/(.+)$/, id => gamePage(id)],
  [/^#\/projections(?:\/(\d+)\/(\d+))?$/, (s, w) => projectionsPage(s && +s, w && +w)],
  [/^#\/player\/(.+)$/, id => playerPage(id)],
  [/^#\/model$/, () => modelPage()],
];
async function route() {
  const h = location.hash || '#/';
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active',
    (a.dataset.nav === 'slate' && (/^#\/?$|#\/week|#\/game/.test(h) || h === '')) || (a.dataset.nav !== 'slate' && h.startsWith('#/' + a.dataset.nav))));
  app.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await base();
    for (const [re, fn] of routes) { const m = h.match(re); if (m) { await fn(...m.slice(1)); window.scrollTo(0, 0); return; } }
    app.innerHTML = '<div class="loading">Not found</div>';
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="card"><b>Couldn't load data.</b><p class="muted">${esc(e.message)}. Run <code>npm run update</code> to build the dataset.</p></div>`;
  }
}
window.addEventListener('hashchange', route);
route();

// ================================================================== SLATE
function weeksOf(season) { return [...new Set(GAMES.filter(g => g.season === season).map(g => g.week))].sort((a, b) => a - b); }
function weekLabel(season, w) {
  const g = GAMES.find(x => x.season === season && x.week === w);
  return g && g.game_type !== 'REG' ? ({ WC: 'Wild Card', DIV: 'Divisional', CON: 'Conference', SB: 'Super Bowl' }[g.game_type] || g.game_type) : `Week ${w}`;
}

function gameChips(g) {
  const c = [];
  if (!g.indoor && g.temp != null) {
    const cold = g.temp <= 32, windy = g.wind >= 15, wet = g.precip >= 0.1, snow = g.snow >= 0.2;
    c.push(`<span class="chip ${cold || windy || wet ? 'warn' : ''}">${Math.round(g.temp)}°F · ${Math.round(g.wind ?? 0)} mph${g.gust >= 25 ? ` (gusts ${Math.round(g.gust)})` : ''}${snow ? ' · snow' : wet ? ' · rain' : ''}${g.weather_src === 'forecast' ? ' · fcst' : ''}</span>`);
  } else if (g.indoor) c.push(`<span class="chip">${roofTxt(g)}</span>`);
  if (g.div_game) c.push('<span class="chip">Division</span>');
  if (g.kick_et >= 19) c.push('<span class="chip">Primetime</span>');
  if (g.neutral) c.push(`<span class="chip">Neutral · ${esc(g.stadium)}</span>`);
  if (g.venue_elev >= 1500 || g.stadium_id === 'DEN00' || g.stadium_id === 'MEX00') c.push('<span class="chip">Altitude</span>');
  for (const side of ['home', 'away']) {
    const st = g[`${side}_qb_status`], qb = g[`${side}_usual_qb`];
    if (st && qb) c.push(`<span class="chip ${st === 'Out' || st === 'Doubtful' ? 'bad' : 'warn'}">${g[side]} QB ${esc(qb.split(' ').slice(-1)[0])}: ${st}</span>`);
    else if (g.profile?.[side]?.qb_change && !g.done) c.push(`<span class="chip bad">${g[side]} QB change</span>`);
  }
  const p = g.profile;
  if (p && p.home.rest != null && p.away.rest != null && Math.abs(p.home.rest - p.away.rest) >= 3)
    c.push(`<span class="chip">Rest edge ${p.home.rest > p.away.rest ? g.home : g.away} (${Math.max(p.home.rest, p.away.rest)}d vs ${Math.min(p.home.rest, p.away.rest)}d)</span>`);
  if (p && Math.abs(p.away.tz_shift ?? 0) >= 2 && !g.neutral) c.push(`<span class="chip">${g.away} ${Math.abs(p.away.tz_shift)} time zones ${p.away.tz_shift > 0 ? 'east' : 'west'}</span>`);
  if (p && p.away.body_clock != null && p.away.body_clock <= 10.5) c.push(`<span class="chip warn">${g.away} body-clock ${kick(`${Math.floor(p.away.body_clock)}:${String(Math.round((p.away.body_clock % 1) * 60)).padStart(2, '0')}`).replace(' ET', '')} kick</span>`);
  return c.join('');
}

function leanText(g) {
  const p = g.pred;
  if (!p) return '';
  const out = [];
  if (g.spread_line != null) {
    const edge = p.margin - g.spread_line; // + → home better than market
    if (Math.abs(edge) >= 1.5) {
      const team = edge > 0 ? g.home : g.away;
      const line = edge > 0 ? -g.spread_line : g.spread_line;
      out.push({ txt: `${team} ${spreadTxt(line)}`, edge: Math.abs(edge), kind: 'ats', hit: g.done ? Math.sign(g.home_score - g.away_score - g.spread_line) === Math.sign(edge) : null, push: g.done && g.home_score - g.away_score === g.spread_line });
    }
  }
  if (g.total_line != null) {
    const edge = p.total - g.total_line;
    if (Math.abs(edge) >= 1.5) out.push({ txt: `${edge > 0 ? 'Over' : 'Under'} ${g.total_line}`, edge: Math.abs(edge), kind: 'ou', hit: g.done ? Math.sign(g.home_score + g.away_score - g.total_line) === Math.sign(edge) : null, push: g.done && g.home_score + g.away_score === g.total_line });
  }
  return out;
}

function gameCard(g) {
  const p = g.pred;
  const hw = p?.home_wp ?? null;
  const winner = g.done ? (g.home_score > g.away_score ? 'home' : g.home_score < g.away_score ? 'away' : null) : null;
  const teamRow = side => `
    <div class="team-name">${g[side]} <span class="rec">${record(g[side], g.season, g.gameday)}</span></div>
    <div class="proj num" data-tip="${tip('Model projection', [`${g[side]} ${f1(p?.[`${side}_pts`])} pts`, `${f0(p?.[`${side}_plays`])} plays · ${pct(p?.[`${side}_pass_rate`])} pass rate`])}">${p ? f1(p[`${side}_pts`]) : ''}</div>
    <div class="score num ${winner && winner !== side ? 'lose' : ''}">${g.done ? g[`${side}_score`] : ''}</div>`;
  const vegasHome = g.spread_line != null ? -g.spread_line : null;
  const modelHome = p ? -p.margin : null;
  const leans = leanText(g);
  return `<a class="card game" href="#/game/${g.game_id}">
    <div class="meta"><span>${day(g.gameday)} · ${kick(g.gametime)}</span><span>${esc(g.stadium || '')}</span></div>
    <div class="teams">
      <div class="muted" style="font-size:11px">${g.neutral ? 'TEAM' : 'AWAY / HOME'}</div><div class="muted" style="font-size:11px;text-align:right">MODEL</div><div class="muted" style="font-size:11px;text-align:right">${g.done ? 'FINAL' : ''}</div>
      ${teamRow('away')}${teamRow('home')}
    </div>
    ${hw != null ? `<div class="wpbar" data-tip="${tip('Win probability (model)', [`${g.away} ${pct(1 - hw)}`, `${g.home} ${pct(hw)}`])}"><span style="width:${(1 - hw) * 100}%;background:var(--series-2)"></span><span style="flex:1;background:var(--series-1)"></span></div>` : ''}
    <div class="lines">
      <div><span class="lbl">Spread (${g.home})</span><b class="num">${spreadTxt(vegasHome)}</b><span class="muted">model ${spreadTxt(modelHome)}</span></div>
      <div><span class="lbl">Total</span><b class="num">${g.total_line ?? '–'}</b><span class="muted">model ${f1(p?.total)}</span></div>
      <div><span class="lbl">Win prob</span><b class="num">${hw != null ? `${hw >= 0.5 ? g.home : g.away} ${pct(Math.max(hw, 1 - hw))}` : '–'}</b><span class="muted">${g.home_ml != null ? `ML ${g.home_ml > 0 ? '+' : ''}${g.home_ml} / ${g.away_ml > 0 ? '+' : ''}${g.away_ml}` : ''}</span></div>
    </div>
    <div class="chips">${gameChips(g)}${leans.map(l => `<span class="chip ${l.hit == null ? '' : l.push ? '' : l.hit ? 'good' : 'bad'}">Lean ${esc(l.txt)} (${f1(l.edge)})${l.hit == null ? '' : l.push ? ' · push' : l.hit ? ' ✓' : ' ✗'}</span>`).join('')}</div>
  </a>`;
}

async function slate(season, week) {
  season ??= META.next_week?.season ?? META.current_season;
  week ??= META.next_week?.week ?? Math.max(...weeksOf(season));
  const seasons = [...new Set(GAMES.map(g => g.season))].sort((a, b) => b - a);
  const list = GAMES.filter(g => g.season === season && g.week === week);
  const weeks = weeksOf(season);
  const leans = list.flatMap(leanText).filter(l => l.hit != null && !l.push);
  const ats = leans.filter(l => l.kind === 'ats'), ou = leans.filter(l => l.kind === 'ou');
  const done = list.filter(g => g.done && g.pred);
  const su = done.filter(g => g.home_score !== g.away_score);
  const suHits = su.filter(g => (g.pred.margin > 0) === (g.home_score > g.away_score)).length;
  app.innerHTML = `
    <div class="row" style="margin-bottom:6px"><h1>${weekLabel(season, week)} · ${season}</h1><span class="spacer"></span>
      <div class="controls" style="margin:0">
        <select id="season">${seasons.map(s => `<option ${s === season ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="week">${weeks.map(w => `<option value="${w}" ${w === week ? 'selected' : ''}>${weekLabel(season, w)}</option>`).join('')}</select>
        <button class="btn" id="prev">‹</button><button class="btn" id="next">›</button>
        <a class="btn" href="#/projections/${season}/${week}">Player projections →</a>
      </div></div>
    <p class="sub">${list.some(g => !g.done) ? 'Projected scores come from a model that never sees the betting line, so you can compare it against Vegas. "Lean" shows up when the model and the market disagree by 1.5+ points.' : done.length && done[0].pred ? `Back-test week: these predictions were made by a model trained only on seasons before ${META.test_from}. Straight-up ${suHits}-${su.length - suHits}${ats.length ? ` · ATS leans ${ats.filter(l => l.hit).length}-${ats.filter(l => !l.hit).length}` : ''}${ou.length ? ` · O/U leans ${ou.filter(l => l.hit).length}-${ou.filter(l => !l.hit).length}` : ''}.` : 'Historical week (results only; out-of-sample predictions exist from ' + META.test_from + ' on).'}</p>
    <div class="grid games">${list.map(gameCard).join('') || '<p class="muted">No games.</p>'}</div>`;
  $('#season').onchange = e => { const s = +e.target.value; const ws = weeksOf(s); location.hash = `#/week/${s}/${ws.includes(week) ? week : ws[0]}`; };
  $('#week').onchange = e => (location.hash = `#/week/${season}/${e.target.value}`);
  const i = weeks.indexOf(week);
  $('#prev').onclick = () => { if (i > 0) location.hash = `#/week/${season}/${weeks[i - 1]}`; else if (seasons.includes(season - 1)) location.hash = `#/week/${season - 1}/${Math.max(...weeksOf(season - 1))}`; };
  $('#next').onclick = () => { if (i < weeks.length - 1) location.hash = `#/week/${season}/${weeks[i + 1]}`; else if (seasons.includes(season + 1)) location.hash = `#/week/${season + 1}/1`; };
}

// ================================================================== GAME PAGE
const PROFILE_ROWS = [
  ['Points / game', 'off_pf', 'def_pa', 1, true], ['EPA / play', 'off_epa_play', 'def_epa_play', 3, true], ['Pass EPA / dropback', 'off_pass_epa', 'def_pass_epa', 3, true],
  ['Rush EPA / carry', 'off_rush_epa', 'def_rush_epa', 3, true], ['Success rate', 'off_success', 'def_success', 'pct', true], ['Explosive play rate', 'off_explosive', 'def_explosive', 'pct', true],
  ['Turnover rate / play', 'off_to_rate', 'def_to_rate', 'pct1', false], ['Plays / game', 'off_plays', null, 1, null], ['Sec / play (neutral pace)', 'off_sec_per_play', null, 1, null],
  ['Pass rate over expected', 'off_proe', null, 1, null], ['Neutral-script pass rate', 'off_neutral_pass', null, 'pct', null], ['Points / drive', 'off_pts_drive', null, 2, true],
  ['Red-zone TD rate', 'off_rz_td', null, 'pct', true],
];
const fmtBy = (v, f) => (f === 'pct' ? pct(v) : f === 'pct1' ? pct(v, 1) : v == null ? '–' : (+v).toFixed(f));

async function gamePage(id) {
  const g = GBY[id];
  if (!g) { app.innerHTML = '<div class="loading">Game not found</div>'; return; }
  const p = g.pred, pr = g.profile;
  let sheet = [];
  try { sheet = await getJSON(`/data/games/${id}.json`); } catch {}
  const cmpRow = ([label, ok, dk, f, higherBetter]) => {
    const a = pr?.away?.[ok], h = pr?.home?.[ok];
    const ad = dk ? pr?.away?.[dk] : null, hd = dk ? pr?.home?.[dk] : null;
    const better = (x, y) => (higherBetter == null || x == null || y == null ? '' : (higherBetter ? x > y : x < y) ? 'better' : '');
    return `<tr><td>${label}</td><td class="num ${better(a, h)}">${fmtBy(a, f)}</td><td class="num ${better(h, a)}">${fmtBy(h, f)}</td>
      <td class="num muted">${dk ? fmtBy(ad, f) : ''}</td><td class="num muted">${dk ? fmtBy(hd, f) : ''}</td></tr>`;
  };
  // matchup lens: each offense vs the opposing defense
  const matchup = (off, def) => pr ? [
    ['EPA/play', pr[off].off_epa_play, pr[def].def_epa_play, 3], ['Pass EPA', pr[off].off_pass_epa, pr[def].def_pass_epa, 3], ['Rush EPA', pr[off].off_rush_epa, pr[def].def_rush_epa, 3],
    ['Success', pr[off].off_success, pr[def].def_success, 'pct'], ['Explosive', pr[off].off_explosive, pr[def].def_explosive, 'pct'],
  ] : [];
  const mTbl = (off, def) => `<table class="cmp"><thead><tr><th class="l">${g[off]} offense vs ${g[def]} defense</th><th>Off</th><th>Def allows</th></tr></thead><tbody>
    ${matchup(off, def).map(([l, a, b, f]) => `<tr><td>${l}</td><td class="num">${fmtBy(a, f)}</td><td class="num">${fmtBy(b, f)}</td></tr>`).join('')}
    ${['QB', 'RB', 'WR', 'TE'].map(ps => `<tr><td>PPR pts allowed to ${ps}</td><td></td><td class="num">${f1(pr?.[def]?.[`def_fpa_${ps}`])}</td></tr>`).join('')}</tbody></table>`;

  const playerTable = team => {
    const rows = sheet.filter(r => r.team === team).sort((a, b) => ((b.proj?.fantasy_points_ppr ?? b.stats?.fantasy_points_ppr ?? 0) - (a.proj?.fantasy_points_ppr ?? a.stats?.fantasy_points_ppr ?? 0)));
    if (!rows.length) return '<p class="muted">No player data for this game.</p>';
    return `<div class="tbl-wrap"><table><thead><tr><th class="l">Player</th><th>Proj PPR</th>${g.done ? '<th>Actual</th>' : '<th>10–90%</th>'}<th>Pass att</th><th>Pass yds</th><th>Pass TD</th><th>Car</th><th>Rush yds</th><th>Tgt</th><th>Rec</th><th>Rec yds</th><th>Rush/Rec TD</th></tr></thead><tbody>
      ${rows.slice(0, 18).map(r => {
        const s = g.done ? r.stats : r.proj; const pj = r.proj || {};
        const td = s ? (s.rushing_tds ?? 0) + (s.receiving_tds ?? 0) : null;
        const c = (v, d = f1) => (v != null && Math.abs(v) >= 0.05 ? d(v) : '–');
        return `<tr><td class="l"><a class="link" href="#/player/${r.gsis}">${esc(r.name)}</a> <span class="pos">${r.pos}</span>${r.injury ? ` <span class="chip ${/Out|Doubtful/.test(r.injury) ? 'bad' : 'warn'}">${esc(r.injury.split(' ')[0])}</span>` : ''}</td>
          <td class="num">${f1(pj.fantasy_points_ppr)}</td>
          ${g.done ? `<td class="num"><b>${f1(r.stats?.fantasy_points_ppr)}</b></td>` : `<td class="num muted">${r.range?.fantasy_points_ppr ? `${f1(r.range.fantasy_points_ppr[2])}–${f1(r.range.fantasy_points_ppr[18])}` : '–'}</td>`}
          <td class="num">${c(s?.attempts)}</td><td class="num">${c(s?.passing_yards, f0)}</td><td class="num">${c(s?.passing_tds)}</td>
          <td class="num">${c(s?.carries)}</td><td class="num">${c(s?.rushing_yards, f0)}</td>
          <td class="num">${c(s?.targets)}</td><td class="num">${c(s?.receptions)}</td><td class="num">${c(s?.receiving_yards, f0)}</td><td class="num">${c(td)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  };
  const script = side => {
    if (!p) return '';
    const other = side === 'home' ? 'away' : 'home';
    const lead = p[`${side}_pts`] - p[`${other}_pts`];
    const pr8 = p[`${side}_pass_rate`];
    return `${g[side]} projected ${f0(p[`${side}_plays`])} plays at a ${pct(pr8)} pass rate${lead >= 6 ? ' — favored script, expect more run volume late' : lead <= -6 ? ' — likely trailing, expect elevated pass volume' : ''}.`;
  };
  const wx = g.indoor ? `${roofTxt(g)} — weather neutralized` : g.temp != null ? `${Math.round(g.temp)}°F, wind ${Math.round(g.wind ?? 0)} mph${g.gust ? ` (gusts ${Math.round(g.gust)})` : ''}, precip ${f2(g.precip)} in${g.snow ? `, snow ${f2(g.snow)} in` : ''}${g.humidity != null ? `, ${Math.round(g.humidity)}% humidity` : ''} <span class="muted">(${esc(g.weather_src || '')})</span>` : 'Weather not yet available (forecast opens ~16 days out)';

  app.innerHTML = `
    <div class="row"><a class="link" href="#/week/${g.season}/${g.week}">← ${weekLabel(g.season, g.week)} ${g.season}</a></div>
    <h1 style="margin-top:8px">${g.away} ${g.done ? g.away_score : ''} @ ${g.home} ${g.done ? g.home_score : ''}</h1>
    <p class="sub">${day(g.gameday)} · ${kick(g.gametime)} · ${esc(g.stadium)} · ${roofTxt(g)}${g.surface ? ` · ${esc(g.surface)}` : ''}${g.referee ? ` · Ref ${esc(g.referee)}` : ''}</p>
    <div class="grid g4">
      <div class="card stat"><span class="k">Model score</span><span class="v num">${p ? `${f1(p.away_pts)}–${f1(p.home_pts)}` : '–'}</span><span class="s">${g.away}–${g.home}${g.done ? ` · actual ${g.away_score}–${g.home_score}` : ''}</span></div>
      <div class="card stat"><span class="k">Spread (${g.home})</span><span class="v num">${spreadTxt(p ? -p.margin : null)}</span><span class="s">Vegas ${spreadTxt(g.spread_line != null ? -g.spread_line : null)}${p?.home_cover != null ? ` · ${g.home} cover ${pct(p.home_cover)}` : ''}</span></div>
      <div class="card stat"><span class="k">Total</span><span class="v num">${f1(p?.total)}</span><span class="s">Vegas ${g.total_line ?? '–'}${p?.over != null ? ` · over ${pct(p.over)}` : ''}</span></div>
      <div class="card stat"><span class="k">Win probability</span><span class="v num">${p ? `${g.home} ${pct(p.home_wp)}` : '–'}</span><span class="s">${g.away} ${p ? pct(1 - p.home_wp) : '–'}${g.home_ml != null ? ` · ML ${g.away_ml > 0 ? '+' : ''}${g.away_ml}/${g.home_ml > 0 ? '+' : ''}${g.home_ml}` : ''}</span></div>
    </div>
    <div class="chips" style="margin:12px 0">${gameChips(g)}</div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h3>Game environment</h3>
        <div class="kv">
          <span class="k">Weather</span><span style="grid-column: span 3">${wx}</span>
          <span class="k">Kickoff</span><span>${kick(g.gametime)} ${g.weekday}</span><span class="k">Division game</span><span>${g.div_game ? 'Yes' : 'No'}</span>
          <span class="k">${g.away} rest</span><span>${pr?.away?.rest ?? '–'} days</span><span class="k">${g.home} rest</span><span>${pr?.home?.rest ?? '–'} days</span>
          <span class="k">${g.away} travel</span><span>${f0(pr?.away?.travel_mi)} mi · ${sgn(pr?.away?.tz_shift ?? 0, 0)} tz</span><span class="k">${g.home} travel</span><span>${f0(pr?.home?.travel_mi)} mi</span>
          <span class="k">Coaches</span><span>${esc(g.away_coach || '–')}</span><span class="k"></span><span>${esc(g.home_coach || '–')}</span>
          <span class="k">QBs</span><span>${esc(g.away_qb || g.away_usual_qb || '–')}${g.away_qb_status ? ` (${g.away_qb_status})` : ''}</span><span class="k"></span><span>${esc(g.home_qb || g.home_usual_qb || '–')}${g.home_qb_status ? ` (${g.home_qb_status})` : ''}</span>
        </div>
        ${p ? `<p class="note" style="margin-top:12px">Projected script: ${script('away')} ${script('home')}</p>` : ''}
        ${g.box ? `<h3 style="margin-top:14px">How it actually played</h3><table class="cmp"><thead><tr><th class="l"></th><th>${g.away}</th><th>${g.home}</th></tr></thead><tbody>
          ${[['Plays', 'plays', 0], ['Pass rate', 'pass_rate', 'pct'], ['EPA / play', 'epa_play', 3], ['Avg score margin (script)', 'script', 1], ['% plays trailing 8+', 'trail8', 'pct'], ['% plays leading 8+', 'lead8', 'pct'], ['Sec / play', 'sec_per_play', 1], ['PROE', 'proe', 1], ['Turnovers', 'to', 0]]
            .map(([l, k, f]) => `<tr><td>${l}</td><td class="num">${fmtBy(g.box.away[k], f)}</td><td class="num">${fmtBy(g.box.home[k], f)}</td></tr>`).join('')}</tbody></table>` : ''}
      </div>
      <div class="card"><h3>Team profiles (entering the game, recency-weighted)</h3>
        ${pr ? `<table class="cmp"><thead><tr><th class="l">Offense / Defense</th><th>${g.away} off</th><th>${g.home} off</th><th>${g.away} def</th><th>${g.home} def</th></tr></thead><tbody>${PROFILE_ROWS.map(cmpRow).join('')}</tbody></table>` : '<p class="muted">Team profiles are kept for the last three seasons.</p>'}
      </div>
    </div>
    ${pr ? `<div class="grid g2" style="margin-top:14px"><div class="card">${mTbl('away', 'home')}</div><div class="card">${mTbl('home', 'away')}</div></div>` : ''}
    <h2>Players</h2>
    <div class="grid"><div><h3>${g.home} <span class="muted">· home</span></h3>${playerTable(g.home)}</div><div><h3>${g.away} <span class="muted">· away</span></h3>${playerTable(g.away)}</div></div>`;
}

// ================================================================== PROJECTIONS
async function projectionsPage(season, week) {
  const all = await getJSON('/data/projections.json');
  const wks = [...new Set(all.map(p => `${p.season}|${p.week}`))].sort((a, b) => { const [s1, w1] = a.split('|').map(Number), [s2, w2] = b.split('|').map(Number); return s1 - s2 || w1 - w2; });
  if (!season || !wks.includes(`${season}|${week}`)) {
    if (season && week) { // a completed week: show the back-test via the slate instead
      app.innerHTML = `<div class="card"><b>${weekLabel(season, week)} ${season} has been played.</b><p class="muted">Projections are published for upcoming games. See the <a class="link" href="#/week/${season}/${week}">slate</a> for results and the out-of-sample predictions, or open a player to compare projected vs actual.</p></div>`;
      return;
    }
    const nk = META.next_week && `${META.next_week.season}|${META.next_week.week}`;
    [season, week] = (wks.includes(nk) ? nk : wks[0] || `${META.current_season}|1`).split('|').map(Number);
  }
  const state = { pos: 'ALL', team: 'ALL', q: '', sort: 'fantasy_points_ppr', dir: -1 };
  try { Object.assign(state, JSON.parse(sessionStorage.getItem('projState') || '{}')); } catch {}
  const rows = all.filter(p => p.season === season && p.week === week);
  const teams = [...new Set(rows.map(r => r.team))].sort();
  const cols = [
    ['fantasy_points_ppr', 'PPR', 1], ['passing_yards', 'Pass yds', 0], ['passing_tds', 'Pass TD', 2], ['passing_interceptions', 'INT', 2],
    ['carries', 'Car', 1], ['rushing_yards', 'Rush yds', 0], ['rushing_tds', 'Rush TD', 2],
    ['targets', 'Tgt', 1], ['receptions', 'Rec', 1], ['receiving_yards', 'Rec yds', 0], ['receiving_tds', 'Rec TD', 2],
  ];
  const draw = () => {
    try { sessionStorage.setItem('projState', JSON.stringify({ pos: state.pos, sort: state.sort, dir: state.dir })); } catch {}
    let list = rows.filter(r => (state.pos === 'ALL' || r.pos === state.pos) && (state.team === 'ALL' || r.team === state.team) && (!state.q || r.name.toLowerCase().includes(state.q)));
    const val = r => (state.sort === 'name' ? r.name : state.sort === 'implied' ? r.ctx.implied : state.sort === 'snap' ? r.key.p_snap_pct : r.proj[state.sort] ?? -1);
    list.sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'string' ? x.localeCompare(y) : x - y) * state.dir; });
    list = list.filter(r => r.proj.fantasy_points_ppr >= 1 || state.q).slice(0, 300);
    const maxFp = Math.max(...list.map(r => r.range?.fantasy_points_ppr?.[18] ?? 0), 1);
    $('#ptable').innerHTML = `<table><thead><tr><th class="l" data-s="name">Player</th><th class="l">Game</th><th data-s="implied">Team total</th><th data-s="snap">Snap%</th>
      ${cols.map(([k, l]) => `<th data-s="${k}">${l}${state.sort === k ? (state.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('')}<th class="l" style="min-width:160px">PPR range (10/25/50/75/90%)</th></tr></thead><tbody>
      ${list.map(r => {
        const q = r.range?.fantasy_points_ppr;
        const x = v => `${(v / maxFp) * 100}%`;
        return `<tr><td class="l"><a class="link" href="#/player/${r.gsis}">${esc(r.name)}</a> <span class="pos">${r.pos}</span>${r.injury ? ` <span class="chip ${/Out|Doubtful/.test(r.injury) ? 'bad' : 'warn'}" title="${esc(r.injury)}">${esc(r.injury.split(' ')[0])}</span>` : ''}</td>
        <td class="l"><a class="link" href="#/game/${r.game_id}">${r.team} ${r.ctx.is_home ? 'vs' : '@'} ${r.opp}</a></td>
        <td class="num" title="${r.line_source === 'model' ? 'No Vegas line yet — model total' : 'Vegas implied total'}">${f1(r.ctx.implied)}${r.line_source === 'model' ? '*' : ''}</td>
        <td class="num">${pct(r.key.p_snap_pct)}</td>
        ${cols.map(([k, , d]) => `<td class="num">${r.proj[k] == null ? '<span class="muted">–</span>' : k === 'fantasy_points_ppr' ? `<b>${(+r.proj[k]).toFixed(d)}</b>` : (+r.proj[k]).toFixed(d)}</td>`).join('')}
        <td class="l">${q ? `<div class="range" data-tip="${tip(`${r.name} PPR outcome range`, [`10%: ${q[2]}`, `25%: ${q[5]}`, `Median: ${q[10]}`, `75%: ${q[15]}`, `90%: ${q[18]}`])}"><div class="track"></div><div class="p80" style="left:${x(q[2])};width:calc(${x(q[18])} - ${x(q[2])})"></div><div class="iqr" style="left:${x(q[5])};width:calc(${x(q[15])} - ${x(q[5])})"></div><div class="med" style="left:${x(q[10])}"></div></div>` : ''}</td></tr>`;
      }).join('')}</tbody></table>`;
    $('#ptable').querySelectorAll('th[data-s]').forEach(th => th.onclick = () => { const s = th.dataset.s; state.dir = state.sort === s ? -state.dir : (s === 'name' ? 1 : -1); state.sort = s; draw(); });
  };
  app.innerHTML = `
    <h1>Player projections</h1>
    <p class="sub">Each projection is the model's average outcome. The bar shows the realistic range, calibrated on how well past predictions held up (dark band = middle 50%, light band = 80%). An * on the team total means no Vegas line has been posted yet, so the model's own projected score is used.</p>
    <div class="controls">
      <select id="wk">${wks.map(k => { const [s, w] = k.split('|').map(Number); return `<option value="${k}" ${s === season && w === week ? 'selected' : ''}>${weekLabel(s, w)} ${s}</option>`; }).join('')}</select>
      <div class="seg" id="pos">${['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => `<button data-p="${p}" class="${state.pos === p ? 'on' : ''}">${p}</button>`).join('')}</div>
      <select id="team"><option value="ALL">All teams</option>${teams.map(t => `<option>${t}</option>`).join('')}</select>
      <input id="pq" type="search" placeholder="Filter by name">
    </div>
    <div class="tbl-wrap" id="ptable"></div>`;
  $('#wk').onchange = e => { const [s, w] = e.target.value.split('|'); location.hash = `#/projections/${s}/${w}`; };
  $('#pos').onclick = e => { const b = e.target.closest('button'); if (!b) return; state.pos = b.dataset.p; $('#pos').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); draw(); };
  $('#team').onchange = e => { state.team = e.target.value; draw(); };
  $('#pq').oninput = e => { state.q = e.target.value.trim().toLowerCase(); draw(); };
  draw();
}

// ================================================================== PLAYER PAGE
function fpChart(rows) {
  // rows: [{label, actual, proj, tipLines}]
  const W = 900, H = 220, L = 34, R = 8, T = 10, B = 26;
  const max = Math.max(10, ...rows.map(r => Math.max(r.actual ?? 0, r.proj ?? 0))) * 1.08;
  const n = rows.length, bw = (W - L - R) / Math.max(n, 1);
  const y = v => T + (H - T - B) * (1 - v / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(max * f / 5) * 5).filter((v, i, a) => a.indexOf(v) === i && v <= max);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fantasy points by game"><g class="grid">${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}</g>`;
  const pts = [];
  rows.forEach((r, i) => {
    const x = L + i * bw, cx = x + bw / 2, w = Math.max(2, Math.min(26, bw - 2));
    if (r.actual != null) {
      const h = Math.max(0, y(0) - y(r.actual));
      s += `<path d="M${cx - w / 2},${y(0)} v${-Math.max(0, h - 4)} q0,-4 4,-4 h${w - 8} q4,0 4,4 v${Math.max(0, h - 4)} z" fill="var(--series-1)" opacity="${r.upcoming ? 0.4 : 0.85}"/>`;
    }
    if (r.proj != null) pts.push([cx, y(r.proj)]);
    s += `<rect x="${x}" y="${T}" width="${bw}" height="${H - T - B}" fill="transparent" data-tip="${tip(r.label, r.tipLines)}"/>`;
    if (n <= 24 || i % Math.ceil(n / 24) === 0) s += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(r.tick)}</text>`;
  });
  if (pts.length) {
    s += `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="var(--series-2)" stroke-width="2" pointer-events="none"/>`;
    s += pts.map(([x, yy]) => `<circle cx="${x}" cy="${yy}" r="4" fill="var(--series-2)" stroke="var(--surface)" stroke-width="2" pointer-events="none"/>`).join('');
  }
  return s + '</svg>';
}

function splits(log, pos) {
  const done = log.filter(r => r.stats);
  const key = pos === 'QB' ? 'passing_yards' : pos === 'RB' ? 'rushing_yards' : 'receiving_yards';
  const groups = [
    ['Location', [['Home', r => r.loc === 'H'], ['Away', r => r.loc === 'A'], ['Neutral', r => r.loc === 'N']]],
    ['Venue', [['Dome / closed roof', r => r.ctx.indoor === 1], ['Outdoors', r => r.ctx.indoor === 0], ['Turf', r => r.ctx.turf === 1], ['Grass', r => r.ctx.turf === 0]]],
    ['Temperature (outdoors)', [['Below 40°F', r => !r.ctx.indoor && r.ctx.temp != null && r.ctx.temp < 40], ['40–69°F', r => !r.ctx.indoor && r.ctx.temp >= 40 && r.ctx.temp < 70], ['70°F+', r => !r.ctx.indoor && r.ctx.temp >= 70]]],
    ['Wind / precip', [['Wind 15+ mph', r => r.ctx.wind >= 15], ['Wind under 15', r => r.ctx.wind != null && r.ctx.wind < 15], ['Rain/snow (0.1"+)', r => r.ctx.precip >= 0.1]]],
    ['Kickoff', [['Early (before 4 PM ET)', r => r.ctx.kick_et < 16], ['Late afternoon', r => r.ctx.kick_et >= 16 && r.ctx.kick_et < 19], ['Primetime', r => r.ctx.kick_et >= 19]]],
    ['Betting line', [['Favored by 7+', r => r.ctx.spread <= -7], ['Favored by 0.5–6.5', r => r.ctx.spread < 0 && r.ctx.spread > -7], ['Underdog', r => r.ctx.spread > 0], ['Team total 24+', r => r.ctx.implied >= 24], ['Team total < 20', r => r.ctx.implied != null && r.ctx.implied < 20]]],
    ['Game script (actual)', [['Won', r => r.team_pts > r.opp_pts], ['Lost', r => r.team_pts < r.opp_pts], ['Mostly leading (avg +7)', r => r.script >= 7], ['Mostly trailing (avg −7)', r => r.script <= -7], ['Shootout (50+ total)', r => r.team_pts + r.opp_pts >= 50]]],
    ['Rest & travel', [['Short week (≤5 days)', r => r.ctx.rest != null && r.ctx.rest <= 5], ['Normal (6–8)', r => r.ctx.rest >= 6 && r.ctx.rest <= 8], ['Extra rest (9+)', r => r.ctx.rest >= 9], ['Traveled 1,500+ mi', r => r.ctx.travel_mi >= 1500], ['Division game', r => r.ctx.div_game === 1]]],
  ];
  const allAvg = done.length ? done.reduce((a, r) => a + r.stats.fantasy_points_ppr, 0) / done.length : 0;
  return `<p class="muted" style="margin-top:0">${done.length} games · ${f1(allAvg)} PPR/g overall. Splits with fewer than 4 games are dimmed: small samples are noisy.</p><div class="grid g2">${groups.map(([title, items]) => `<div class="card"><h3>${title}</h3><table class="cmp"><thead><tr><th class="l"></th><th>G</th><th>PPR/g</th><th>vs avg</th><th>${STAT_LABEL[key]}/g</th></tr></thead><tbody>
    ${items.map(([lbl, fn]) => {
      const s = done.filter(fn);
      const fp = s.length ? s.reduce((a, r) => a + r.stats.fantasy_points_ppr, 0) / s.length : null;
      const st = s.length ? s.reduce((a, r) => a + (r.stats[key] || 0), 0) / s.length : null;
      const d = fp != null ? fp - allAvg : null;
      return `<tr style="${s.length < 4 ? 'opacity:.45' : ''}"><td>${lbl}</td><td class="num">${s.length}</td><td class="num">${f1(fp)}</td><td class="num edge ${d > 0.5 ? 'up' : d < -0.5 ? 'down' : ''}">${d == null ? '–' : sgn(d)}</td><td class="num">${f1(st)}</td></tr>`;
    }).join('')}</tbody></table></div>`).join('')}</div>`;
}

async function playerPage(id) {
  const P = await getJSON(`/data/players/${id}.json`);
  const log = P.log;
  const pos = log[log.length - 1]?.team ? (log.find(r => r.stats)?.stats && P.pos) : P.pos;
  const statKeys = POS_STATS[P.pos] || POS_STATS.WR;
  const upcoming = log.filter(r => !r.stats && r.proj);
  const next = upcoming[0];
  const seasons = [...new Set(log.map(r => r.season))].sort((a, b) => b - a);
  const age = P.birth ? ((Date.now() - Date.parse(P.birth)) / 3.156e10).toFixed(1) : null;
  const lastTeam = log[log.length - 1]?.team;

  const nextCard = () => {
    if (!next) return '<div class="card"><h3>Next game</h3><p class="muted">No upcoming game projected (season over, bye, or not on a current depth chart).</p></div>';
    const g = GBY[next.game_id];
    const q = next.range?.fantasy_points_ppr;
    const keys = ['fantasy_points_ppr', ...statKeys];
    return `<div class="card">
      <div class="row"><h3 style="margin:0">Next game · ${weekLabel(next.season, next.week)}</h3><span class="spacer"></span><a class="link" href="#/game/${next.game_id}">${next.team} ${next.loc === 'H' ? 'vs' : next.loc === 'N' ? 'vs' : '@'} ${next.opp} · ${day(next.gameday)} ${kick(g?.gametime)}</a></div>
      ${next.injury ? `<div class="chips"><span class="chip ${/Out|Doubtful/.test(next.injury) ? 'bad' : 'warn'}">Injury: ${esc(next.injury)}</span></div>` : ''}
      <div class="grid g4" style="margin-top:12px">
        <div class="stat"><span class="k">Projected PPR</span><span class="v num">${f1(next.proj.fantasy_points_ppr)}</span><span class="s">${q ? `80% range ${f1(q[2])}–${f1(q[18])}` : ''}</span></div>
        <div class="stat"><span class="k">Team implied total</span><span class="v num">${f1(next.ctx.implied)}</span><span class="s">${next.line_source === 'model' ? 'model (no line yet)' : `spread ${spreadTxt(next.ctx.spread)} · O/U ${next.ctx.total ?? '–'}`}</span></div>
        <div class="stat"><span class="k">Usage (recency-weighted)</span><span class="v num">${pct(next.key?.p_snap_pct)}</span><span class="s">snaps · ${P.pos === 'QB' ? `${f1(next.key?.ypa)} yds/att` : `tgt share ${pct(next.key?.p_target_share)} · carry share ${pct(next.key?.p_carry_share)}`}</span></div>
        <div class="stat"><span class="k">Opp PPR allowed to ${P.pos}</span><span class="v num">${f1(next.ctx.oppdef_fpa_pos)}</span><span class="s">${g ? (g.indoor ? roofTxt(g) : g.temp != null ? `${Math.round(g.temp)}°F · ${Math.round(g.wind ?? 0)} mph wind` : 'forecast pending') : ''}</span></div>
      </div>
      <table class="cmp" style="margin-top:14px"><thead><tr><th class="l">Stat</th><th>Proj</th><th>10%</th><th>25%</th><th>Median</th><th>75%</th><th>90%</th><th>Prop line</th><th>P(over)</th></tr></thead><tbody>
      ${keys.filter(k => next.proj[k] != null).map(k => { const r = next.range?.[k]; return `<tr data-k="${k}"><td>${STAT_LABEL[k]}</td><td class="num"><b>${f2(next.proj[k])}</b></td>${[2, 5, 10, 15, 18].map(i => `<td class="num muted">${r ? f1(r[i]) : '–'}</td>`).join('')}
        <td><input class="line num" type="number" step="0.5" style="width:70px" value="${Math.max(0.5, Math.round(next.proj[k] * 2) / 2 - (next.proj[k] < 1 ? 0 : 0.5) )}"></td><td class="num prob"></td></tr>`; }).join('')}
      </tbody></table>
      <p class="muted" style="font-size:12px;margin-bottom:0">Type a sportsbook prop line to see the model's chance of the over. Probabilities come from out-of-sample results of past players with similar projections.</p>
    </div>`;
  };

  app.innerHTML = `
    <div class="player-head">${P.headshot ? `<img src="${esc(P.headshot)}" alt="">` : '<div class="avatar"></div>'}
      <div><h1>${esc(P.name)} <span class="pos">${P.pos}</span></h1>
      <p class="sub" style="margin:0">${lastTeam || ''}${age ? ` · Age ${age}` : ''}${P.height ? ` · ${Math.floor(P.height / 12)}'${P.height % 12}" ${P.weight || ''} lb` : ''}${P.college ? ` · ${esc(P.college)}` : ''}${P.draft_round ? ` · Draft R${P.draft_round} #${P.draft_pick} (${P.rookie_season})` : P.rookie_season ? ` · Undrafted (${P.rookie_season})` : ''}</p></div></div>
    ${nextCard()}
    <div class="tabs" id="tabs"><button data-t="log" class="on">Game log</button><button data-t="splits">Splits</button></div>
    <div class="controls"><select id="seasonSel"><option value="last3">Last 3 seasons</option>${seasons.map(s => `<option value="${s}">${s}</option>`).join('')}<option value="all">All</option></select></div>
    <div id="pbody"></div>`;

  // prop calculator
  const recalc = () => app.querySelectorAll('tr[data-k]').forEach(tr => {
    const k = tr.dataset.k, line = parseFloat(tr.querySelector('input').value);
    const p = probOver(next.range?.[k], line);
    tr.querySelector('.prob').innerHTML = p == null ? '–' : `<span class="edge ${p >= 0.55 ? 'up' : p <= 0.45 ? 'down' : ''}">${pct(p)}</span>`;
  });
  if (next) { app.querySelectorAll('tr[data-k] input').forEach(i => (i.oninput = recalc)); recalc(); }

  let tab = 'log', sel = seasons[0] === META.current_season && log.filter(r => r.season === seasons[0] && r.stats).length < 4 ? 'last3' : String(seasons[0]);
  $('#seasonSel').value = sel;
  const draw = () => {
    const rows = log.filter(r => sel === 'all' || (sel === 'last3' ? r.season >= seasons[0] - 2 : r.season === +sel));
    if (tab === 'splits') { $('#pbody').innerHTML = splits(rows, P.pos); return; }
    const chartRows = rows.map(r => ({
      label: `${r.season} ${weekLabel(r.season, r.week)} · ${r.team} ${r.loc === 'A' ? '@' : 'vs'} ${r.opp}`, tick: `${r.week}`,
      actual: r.stats?.fantasy_points_ppr ?? null, proj: r.proj?.fantasy_points_ppr ?? null, upcoming: !r.stats,
      tipLines: [r.stats ? `Actual: ${f1(r.stats.fantasy_points_ppr)} PPR` : 'Upcoming', r.proj ? `Projected: ${f1(r.proj.fantasy_points_ppr)}` : 'No out-of-sample projection', r.team_pts != null ? `Final ${r.team_pts}-${r.opp_pts}` : '', r.ctx.spread != null ? `Spread ${spreadTxt(r.ctx.spread)} · O/U ${r.ctx.total}` : ''].filter(Boolean),
    }));
    const thStats = statKeys.map(k => `<th>${STAT_LABEL[k]}</th>`).join('');
    $('#pbody').innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="legend"><span><i style="background:var(--series-1)"></i>Actual PPR</span><span><i style="background:var(--series-2);border-radius:50%"></i>Model projection (out-of-sample)</span></div>${fpChart(chartRows)}</div>
      <div class="tbl-wrap"><table><thead><tr><th class="l">Season</th><th>Wk</th><th class="l">Date</th><th class="l">Opp</th><th class="l">Result</th><th class="l">Kick</th><th class="l">Venue</th><th>Temp</th><th>Wind</th>
        <th>Spread</th><th>O/U</th><th>Impl</th><th>Script</th><th>Team pass%</th><th>Snap%</th>${thStats}<th>PPR</th><th>Proj</th></tr></thead><tbody>
      ${rows.slice().reverse().map((r, i, arr) => {
        const res = r.team_pts == null ? '' : `${r.team_pts > r.opp_pts ? 'W' : r.team_pts < r.opp_pts ? 'L' : 'T'} ${r.team_pts}-${r.opp_pts}`;
        const sep = i > 0 && arr[i - 1].season !== r.season ? 'sep' : '';
        const s = r.stats || r.proj || {};
        return `<tr class="${r.stats ? '' : 'upcoming'} ${sep}"><td class="l">${r.season}</td><td>${r.game_type === 'REG' ? r.week : r.game_type}</td><td class="l">${day(r.gameday)}</td>
          <td class="l"><a class="link" href="#/game/${r.game_id}">${r.loc === 'A' ? '@' : r.loc === 'N' ? 'vs' : 'vs'} ${r.opp}</a>${r.team !== lastTeam ? ` <span class="muted">(${r.team})</span>` : ''}</td>
          <td class="l">${res || '<span class="muted">upcoming</span>'}</td><td class="l">${kick(r.gametime).replace(' ET', '')}</td>
          <td class="l" title="${esc(r.stadium)}">${r.ctx.indoor ? 'Indoor' : 'Outdoor'}${r.surface ? ` · ${/grass/i.test(r.surface) ? 'grass' : 'turf'}` : ''}</td>
          <td class="num">${r.ctx.indoor ? '–' : f0(r.ctx.temp)}</td><td class="num">${r.ctx.indoor ? '–' : f0(r.ctx.wind)}</td>
          <td class="num">${spreadTxt(r.ctx.spread)}</td><td class="num">${r.ctx.total ?? '–'}</td><td class="num">${f1(r.ctx.implied)}</td>
          <td class="num" title="Average score margin while on offense">${r.script == null ? '–' : sgn(r.script)}</td><td class="num">${pct(r.team_pass_rate)}</td>
          <td class="num">${r.stats ? pct(r.stats.snap_pct) : '–'}</td>
          ${statKeys.map(k => `<td class="num ${r.stats ? '' : 'muted'}">${s[k] == null ? '–' : r.stats ? f0(s[k]) : f1(s[k])}</td>`).join('')}
          <td class="num"><b>${r.stats ? f1(r.stats.fantasy_points_ppr) : ''}</b></td><td class="num muted">${f1(r.proj?.fantasy_points_ppr)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  };
  $('#seasonSel').onchange = e => { sel = e.target.value; draw(); };
  $('#tabs').onclick = e => { const b = e.target.closest('button'); if (!b) return; tab = b.dataset.t; $('#tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); draw(); };
  draw();
}

// ================================================================== MODEL PAGE
const FEATURE_NAMES = {
  p_fantasy_points_ppr: 'Player PPR (recency-weighted)', p_season_fp: 'Player PPR this season', l3_fantasy_points_ppr: 'Player PPR last 3 games', p_snap_pct: 'Snap share',
  l3_snap_pct: 'Snap share last 3', implied: 'Vegas implied team total', total: 'Vegas game total', spread: 'Vegas spread', draft_pick: 'Draft pick', p_target_share: 'Target share',
  p_carry_share: 'Carry share', off_epa_play: 'Team offensive EPA/play', off_pf: 'Team points/game', off_pts_drive: 'Team points/drive', oppdef_pa: 'Opponent points allowed',
  qb_change: 'Starting QB change', wind: 'Wind speed', gust: 'Wind gusts', temp: 'Temperature', travel_mi: 'Travel distance', body_clock: 'Body-clock kickoff hour',
  oppdef_fpa_pos: 'Opp PPR allowed to position', vac_tgt: 'Vacated targets (injured teammates)', vac_car: 'Vacated carries', days_since_last: 'Days since last game',
};
const fname = k => FEATURE_NAMES[k] || k.replace(/^p_/, 'player ').replace(/^l3_/, 'last-3 ').replace(/^off_/, 'team off ').replace(/^def_/, 'team def ').replace(/^oppdef_/, 'opp def ').replace(/^oppoff_/, 'opp off ').replace(/_/g, ' ');

async function modelPage() {
  const gm = META.game_metrics, o = gm.overall;
  const seasons = Object.keys(gm.by_season);
  const impSel = Object.keys(META.importance);
  const cmpCell = (m, v, lowerBetter = true) => `<td class="num ${(lowerBetter ? m < v : m > v) ? 'edge up' : ''}">${f2(m)}</td><td class="num">${f2(v)}</td>`;
  app.innerHTML = `
    <h1>Model report card</h1>
    <p class="sub">Every number here is out-of-sample: models were trained only on ${2016}–${META.test_from - 1} and then scored on ${META.test_from}–${META.current_season} games they had never seen.</p>
    <div class="grid g4">
      <div class="card stat"><span class="k">Margin error (MAE)</span><span class="v num">${f2(o.margin_mae)}</span><span class="s">Vegas closing spread: ${f2(o.vegas_margin_mae)}</span></div>
      <div class="card stat"><span class="k">Total error (MAE)</span><span class="v num">${f2(o.total_mae)}</span><span class="s">Vegas closing total: ${f2(o.vegas_total_mae)}</span></div>
      <div class="card stat"><span class="k">Winner picked</span><span class="v num">${pct(o.winner_acc, 1)}</span><span class="s">Vegas favorite: ${pct(o.vegas_winner_acc, 1)}</span></div>
      <div class="card stat"><span class="k">PPR projection MAE</span><span class="v num">${f2(META.player_metrics.fantasy_points_ppr.mae)}</span><span class="s">rolling-average baseline: ${f2(META.player_metrics.fantasy_points_ppr.baseline_mae)}</span></div>
    </div>
    <p class="note" style="margin-top:14px">Being honest about it: Vegas closing lines are very efficient. Team points come from a blend of a ridge regression (70%) and shallow boosted trees (30%). Inputs are opponent-adjusted efficiency, a starting-QB rating, pace, rest, travel and weather. It lands within about ${f1(o.margin_mae - o.vegas_margin_mae)} points of the market on margins and ${f1(o.total_mae - o.vegas_total_mae)} on totals. Blending it with the closing line doesn't improve on the line, so it isn't finding information the market lacks. Use it to see <i>why</i> a game projects the way it does and to build realistic environments for player projections. Treat "leans" as a second opinion, not a betting system.</p>
    <h2>Game model vs Vegas, by season</h2>
    <div class="tbl-wrap"><table><thead><tr><th class="l">Season</th><th>Games</th><th>Model margin MAE</th><th>Vegas</th><th>Model total MAE</th><th>Vegas</th><th>Winner %</th><th>Vegas fav %</th><th>Brier</th></tr></thead><tbody>
      ${seasons.map(s => { const m = gm.by_season[s]; return `<tr><td class="l">${s}</td><td class="num">${m.n}</td>${cmpCell(m.margin_mae, m.vegas_margin_mae)}${cmpCell(m.total_mae, m.vegas_total_mae)}<td class="num">${pct(m.winner_acc, 1)}</td><td class="num">${pct(m.vegas_winner_acc, 1)}</td><td class="num">${f2(m.brier)}</td></tr>`; }).join('')}
    </tbody></table></div>
    <h2>When the model disagrees with the market</h2>
    <div class="tbl-wrap"><table><thead><tr><th class="l">Disagreement</th><th>ATS bets</th><th>ATS hit rate</th><th>O/U bets</th><th>O/U hit rate</th></tr></thead><tbody>
      ${['0', '1.5', '3'].map(t => `<tr><td class="l">≥ ${t} pts</td><td class="num">${o[`ats_${t}`].n}</td><td class="num">${pct(o[`ats_${t}`].win, 1)}</td><td class="num">${o[`ou_${t}`].n}</td><td class="num">${pct(o[`ou_${t}`].win, 1)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted">Break-even at standard −110 juice is 52.4%.</p>
    <h2>Player stat models</h2>
    <div class="tbl-wrap"><table><thead><tr><th class="l">Stat</th><th>Player-games</th><th>Model MAE</th><th>Baseline MAE*</th><th>Improvement</th><th>R²</th><th class="l">By position (model / baseline)</th></tr></thead><tbody>
      ${Object.entries(META.player_metrics).map(([k, m]) => `<tr><td class="l">${STAT_LABEL[k]}</td><td class="num">${m.n}</td><td class="num">${f2(m.model_mae_same_rows)}</td><td class="num">${f2(m.baseline_mae)}</td>
        <td class="num edge ${m.baseline_mae > m.model_mae_same_rows ? 'up' : 'down'}">${pct((m.baseline_mae - m.model_mae_same_rows) / m.baseline_mae, 1)}</td><td class="num">${f2(m.r2)}</td>
        <td class="l muted">${Object.entries(m.by_pos).map(([p, x]) => `${p} ${f2(x.mae)}/${f2(x.baseline_mae)}`).join(' · ')}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted">*Baseline = the player's own recency-weighted average (half-life 4 games), compared on the same players. That's a tough baseline to beat; the model adds role, matchup, game environment, weather, injuries and team context on top.</p>
    <h2>What drives each model</h2>
    <div class="controls"><select id="impSel">${impSel.map(k => `<option value="${k}">${k === 'team_points' ? 'Team points (game model)' : STAT_LABEL[k]}</option>`).join('')}</select></div>
    <div class="card" id="imp"></div>
    <h2>Data sources</h2>
    <div class="card"><ul style="margin:0;padding-left:18px;line-height:1.8">
      <li><b>nflverse play-by-play</b> (2016–present): EPA, success rate, pass rate over expected, neutral-script pace, game script, red-zone and turnover rates</li>
      <li><b>nflverse weekly player stats</b>: box scores, target and air-yard share, WOPR, EPA by play type</li>
      <li><b>Pro-Football-Reference</b> (via nflverse): snap counts, pressure rate, bad throws, drops, broken tackles, yards after contact</li>
      <li><b>NFL Next Gen Stats</b>: separation, cushion, YAC over expected, rush yards over expected, 8+ man boxes, time to throw, CPOE, aggressiveness</li>
      <li><b>Official injury reports</b>: game status, practice participation, vacated targets and carries</li>
      <li><b>Schedules &amp; Vegas lines</b>: spread, total, moneylines, rest, roof, surface, coaches, referees</li>
      <li><b>Open-Meteo</b>: hourly temperature, wind, gusts, precipitation and snow at each stadium during the game window (archive + 16-day forecast)</li>
      <li><b>Derived</b>: travel distance, time-zone shift, body-clock kickoff hour, altitude, division games, primetime, QB changes</li>
    </ul></div>`;
  const drawImp = k => {
    const list = META.importance[k];
    const max = list[0]?.[1] || 1;
    $('#imp').innerHTML = list.map(([f, v]) => `<div class="row" style="gap:10px;margin:3px 0"><span style="width:280px" class="muted">${esc(fname(f))}</span><span style="flex:1"><span style="display:block;height:10px;border-radius:0 4px 4px 0;background:var(--series-1);width:${(v / max) * 100}%" data-tip="${tip(fname(f), [`${pct(v, 1)} of total split gain`])}"></span></span><span class="num" style="width:50px;text-align:right">${pct(v, 1)}</span></div>`).join('');
  };
  $('#impSel').onchange = e => drawImp(e.target.value);
  drawImp(impSel[0]);
}
