// Builds a single self-contained, phone-friendly HTML page with every week of the season: game environments and
// player projections (data/out/mobile/week.html), with week tabs. It opens on the current week, the week of the
// next game not yet played, so the same link rolls forward on its own. Published as a private page for the Claude app.
// Usage: node pipeline/export-mobile.mjs [season]
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './lib/config.mjs';

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
  </summary>
  <div class="body">${qbs}${teamBlock(g, 'home')}${teamBlock(g, 'away')}</div>
</details>`;
}

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
@media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
</style>
<div class="wrap">
<header>
  <h1>Gridiron <span>Lab</span></h1>
  <p>${season} season · updated ${esc(stamp)} ET · tap a game for player projections</p>
</header>
<nav class="weeks" aria-label="Choose week">${weeks.map(w => `<a href="#w${w}" data-w="${w}" class="${w === currentWeek ? 'cur' : ''}">${w}</a>`).join('')}</nav>
${weeks.map(w => {
  const games = allGames.filter(g => g.week === w);
  const nDone = games.filter(g => g.done).length;
  const status = nDone === games.length ? 'Final results vs projections' : nDone ? `${nDone} of ${games.length} games final` : `${games.length} games`;
  let lastDay = '', cards = '';
  for (const g of games) {
    const { day } = kick(g);
    if (day !== lastDay) { cards += `<h3 class="day">${day}</h3>`; lastDay = day; }
    cards += gameCard(g);
  }
  return `<section class="week" id="w${w}" data-w="${w}"${w === currentWeek ? '' : ' hidden'}>
  <div class="wk-head"><h2>Week ${w}${w === currentWeek ? ' <span>this week</span>' : ''}</h2><p>${status}</p></div>
  <nav class="jump" aria-label="Jump to game">${games.map(g => `<a href="#${slug(g)}">${g.away}@${g.home}</a>`).join('')}</nav>
  ${cards}
</section>`;
}).join('')}
<footer>Model scores never see the betting line. PPR projections show the median with an 80% range (10th–90th percentile). Injury tags come from the latest official report. Before Wednesday's report, players who missed last week show as Questionable.</footer>
</div>
<script>
// Week tabs: #w12 shows week 12, #w12-kc-buf shows week 12 and opens that game; no hash shows the current week.
const CURRENT = ${currentWeek};
function showWeek(w) {
  document.querySelectorAll('section.week').forEach(s => { s.hidden = +s.dataset.w !== w; });
  document.querySelectorAll('.weeks a').forEach(a => {
    const on = +a.dataset.w === w;
    a.classList.toggle('on', on);
    if (on) { a.setAttribute('aria-current', 'page'); a.scrollIntoView({ block: 'nearest', inline: 'center' }); } else a.removeAttribute('aria-current');
  });
}
function route() {
  const id = decodeURIComponent(location.hash.slice(1));
  const m = /^w([0-9]+)/.exec(id);
  const el = id && document.getElementById(id);
  showWeek(m && document.getElementById('w' + m[1]) ? +m[1] : CURRENT);
  if (el && el.tagName === 'DETAILS') { el.open = true; el.scrollIntoView({ block: 'start' }); }
  else if (m) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();
</script>
`;
const dir = path.join(OUT, 'mobile');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'week.html'), html);
console.log(`wrote data/out/mobile/week.html (${allGames.length} games, weeks ${weeks[0]}-${weeks.at(-1)}, opens on week ${currentWeek}, ${(html.length / 1024).toFixed(0)} KB)`);
