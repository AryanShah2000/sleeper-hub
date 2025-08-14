// ===== App state FIRST =====
let g = { players: null, userId: null, leagues: {}, selected: null, mode: 'summary' };

// ===== Tiny DOM helpers & cache =====
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).filter(Boolean).forEach((k) => n.append(k));
  return n;
};
const TTL = 3 * 3600 * 1000;                 // 3 hours
const ck = (u) => 'cache:' + u;
async function fetchJSON(url) {
  const now = Date.now();
  try {
    const c = localStorage.getItem(ck(url));
    if (c) {
      const { ts, data } = JSON.parse(c);
      if (now - ts < TTL) return data;
    }
  } catch {}
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  const data = await r.json();
  try { localStorage.setItem(ck(url), JSON.stringify({ ts: now, data })); } catch {}
  return data;
}
function renderStatus(kind, msg) {
  const s = $('#status'); if (!s) return;
  s.className = 'status ' + (kind || '');
  s.innerHTML = msg;
}

// ===== Sleeper fetches =====
async function resolveUserId(usernameOrId) {
  try {
    if (/^\d+$/.test(usernameOrId)) return usernameOrId;
    const u = await fetchJSON(`https://api.sleeper.app/v1/user/${encodeURIComponent(usernameOrId)}`);
    return u?.user_id || null;
  } catch { return null; }
}
async function loadMyLeagues(userId, season) {
  return await fetchJSON(`https://api.sleeper.app/v1/user/${userId}/leagues/nfl/${season}`);
}
async function loadLeagueBundle(leagueId) {
  const league = await fetchJSON(`https://api.sleeper.app/v1/league/${leagueId}`);
  const users = await fetchJSON(`https://api.sleeper.app/v1/league/${leagueId}/users`);
  const rosters = await fetchJSON(`https://api.sleeper.app/v1/league/${leagueId}/rosters`);
  return { league, users, rosters };
}
async function loadPlayersMap() {
  return await fetchJSON(`https://api.sleeper.app/v1/players/nfl`);
}

// ===== Projections (Rotowire via Sleeper) =====
const PROVIDER = 'rotowire';
function feedPPR(it) {
  const ks = ['ppr', 'pts_ppr', 'fantasy_points_ppr'];
  for (const k of ks) if (it?.[k] != null) return +it[k] || 0;
  const s = it?.stats || {};
  for (const k of ks) if (s?.[k] != null) return +s[k] || 0;
  return 0;
}
async function providerRows(season, week, season_type) {
  const url = `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=${season_type}&position[]=QB&position[]=RB&position[]=WR&position[]=TE&order_by=ppr`;
  const raw = await fetchJSON(url);
  const rows = {};
  if (Array.isArray(raw)) {
    for (const it of raw) {
      if ((it.company || '').toLowerCase() !== PROVIDER) continue;
      const pid = String(it.player_id || it.player || '');
      if (!pid) continue;
      const best = rows[pid];
      if (!best || feedPPR(it) > feedPPR(best)) rows[pid] = it;
    }
  }
  return rows;
}
function rescored(pid, rowsByPid, players, scoring) {
  const meta = players[pid] || {};
  const pos = meta.position || 'UNK';
  const st = (rowsByPid[pid] || {}).stats || {};
  const v = (k) => +((st?.[k]) || 0);
  const sc = scoring || {};
  let pts = 0;
  pts += v('pass_yd') * (sc.pass_yd || 0) + v('pass_td') * (sc.pass_td || 0) + v('pass_int') * (sc.pass_int || 0) + v('pass_2pt') * (sc.pass_2pt || 0);
  pts += v('rush_yd') * (sc.rush_yd || 0) + v('rush_td') * (sc.rush_td || 0) + v('rush_2pt') * (sc.rush_2pt || 0);
  const rec = v('rec');
  pts += rec * (sc.rec || 0) + v('rec_yd') * (sc.rec_yd || 0) + v('rec_td') * (sc.rec_td || 0) + v('rec_2pt') * (sc.rec_2pt || 0);
  pts += v('fum_lost') * (sc.fum_lost || 0);
  if (pos === 'TE') pts += rec * (sc.bonus_rec_te || 0);
  return +pts.toFixed(2);
}
async function projByPid(season, week, season_type, players, scoring) {
  const rows = await providerRows(season, week, season_type);
  const out = {};
  Object.keys(rows).forEach((pid) => (out[pid] = rescored(pid, rows, players, scoring)));
  return out;
}

// ===== Helpers: rosters, ages, byes =====
function rosterPids(roster) {
  const s = new Set([...(roster.players || []), ...(roster.starters || []), ...(roster.taxi || [])]);
  s.delete('0');
  return [...s];
}
function rosterRows(roster, players, projFn) {
  return rosterPids(roster).map((pid) => {
    const m = players[pid] || {};
    const name = m.full_name || (m.first_name && m.last_name ? `${m.first_name} ${m.last_name}` : (m.last_name || 'Unknown'));
    return { pid, name, pos: (m.position || 'UNK').toUpperCase(), team: m.team || 'FA', proj: projFn ? +projFn(pid) || 0 : null, bye: m.bye_week };
  });
}
function selectBest(rows, set, k) {
  const pool = rows.filter((r) => set.has(r.pos)).sort((a, b) => b.proj - a.proj);
  const picks = pool.slice(0, k);
  const ids = new Set(picks.map((p) => p.pid));
  return { picks, remaining: rows.filter((r) => !ids.has(r.pid)) };
}
function teamPosValues(league, rows) {
  const rp = (league.roster_positions || []).map((x) => String(x).toUpperCase());
  const PURE = { QB: rp.filter((x) => x === 'QB').length, RB: rp.filter((x) => x === 'RB').length, WR: rp.filter((x) => x === 'WR').length, TE: rp.filter((x) => x === 'TE').length };
  const FLEX = rp.filter((x) => x === 'FLEX').length, SFLEX = rp.filter((x) => x === 'SUPER_FLEX').length;
  let remaining = rows.slice(), values = {};
  for (const [pos, k] of Object.entries(PURE)) {
    const { picks, remaining: rem } = selectBest(remaining, new Set([pos]), k);
    remaining = rem;
    values[pos] = picks.reduce((s, p) => s + p.proj, 0);
  }
  if (FLEX) {
    const { picks, remaining: rem } = selectBest(remaining, new Set(['RB', 'WR', 'TE']), FLEX);
    remaining = rem;
    values.FLEX = picks.reduce((s, p) => s + p.proj, 0);
  } else values.FLEX = 0;
  if (SFLEX) {
    const { picks, remaining: rem } = selectBest(remaining, new Set(['QB', 'RB', 'WR', 'TE']), SFLEX);
    remaining = rem;
    values.SUPER_FLEX = picks.reduce((s, p) => s + p.proj, 0);
  } else values.SUPER_FLEX = 0;
  return values;
}
function rankPct(vals, mine) {
  const sv = [...vals].sort((a, b) => b - a);
  const rank = sv.indexOf(mine) + 1;
  const n = sv.length;
  const below = sv.filter((v) => v < mine).length;
  return { rank, out_of: n, pct: Math.round((1000 * below) / n) / 10 };
}
function parseBD(meta) {
  for (const k of ['birth_date', 'birthdate', 'birthDate']) {
    const raw = meta?.[k];
    if (!raw) continue;
    const d = new Date(String(raw).slice(0, 10));
    if (!isNaN(d)) return d;
  }
  return null;
}
function ageFrom(d) {
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a;
}
function age(meta) {
  if (meta?.age != null) {
    const n = +meta.age;
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const bd = parseBD(meta);
  return bd ? ageFrom(bd) : null;
}
const BYE_2025 = { ATL:5,CHI:5,GB:5,PIT:5,HOU:6,MIN:6,BAL:7,BUF:7,ARI:8,DET:8,JAX:8,LV:8,LAR:8,SEA:8,CLE:9,NYJ:9,PHI:9,TB:9,CIN:10,DAL:10,KC:10,TEN:10,IND:11,NO:11,DEN:12,LAC:12,MIA:12,WAS:12,CAR:14,NE:14,NYG:14,SF:14 };
function teamBye(team, season) { return season == 2025 ? BYE_2025[team] : null; }

// ===== Render helpers =====
function renderTable(container, headers, rows) {
  const table = el('table'), thead = el('thead'), tbody = el('tbody');
  thead.append(el('tr', {}, headers.map((h) => el('th', { html: h }))));
  rows.forEach((r) => tbody.append(el('tr', {}, r.map((c) => el('td', { html: String(c) })))));
  table.append(thead, tbody);
  container.innerHTML = '';
  container.append(table);
}
function renderSortableTable(container, headers, rows, types) {
  const table = el('table'), thead = el('thead'), tbody = el('tbody');
  let sortCol = -1, sortDir = 'desc';
  const parse = (v, t) => (t === 'num' ? (Number.isNaN(+v) ? null : +v) : t === 'bye' ? (v && String(v).startsWith('W') ? +String(v).slice(1) : Number.isNaN(+v) ? null : +v) : String(v || ''));
  const cmp = (a, b, t, d) => { const mul = d === 'asc' ? 1 : -1; if (t === 'str') return mul * String(a).localeCompare(String(b)); if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1; return mul * (a - b); };
  function head() {
    const tr = el('tr');
    headers.forEach((h, i) => {
      const th = el('th');
      th.classList.add('sortable');
      th.append(el('span', { html: h }), el('span', { class: 'arrow', html: '' }));
      th.addEventListener('click', () => { if (sortCol === i) sortDir = sortDir === 'asc' ? 'desc' : 'asc'; else { sortCol = i; sortDir = 'desc'; } body(); arrows(); });
      tr.append(th);
    });
    thead.innerHTML = '';
    thead.append(tr);
  }
  function arrows() {
    thead.querySelectorAll('th').forEach((th, i) => {
      th.classList.remove('sorted-asc', 'sorted-desc');
      const a = th.querySelector('.arrow');
      if (!a) return;
      if (i === sortCol) { th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc'); a.textContent = sortDir === 'asc' ? '▲' : '▼'; }
      else a.textContent = '';
    });
  }
  function body() {
    const t = rows.map((r) => ({ raw: r, key: r.map((c, idx) => parse(c, types[idx])) }));
    if (sortCol >= 0) t.sort((ra, rb) => cmp(ra.key[sortCol], rb.key[sortCol], types[sortCol], sortDir));
    tbody.innerHTML = '';
    t.forEach((r) => tbody.append(el('tr', {}, r.raw.map((c) => el('td', { html: String(c) })))));
  }
  head(); body(); arrows(); table.append(thead, tbody);
  container.innerHTML = '';
  container.append(table);
}

// ===== League/summary renders =====
function renderRoster(container, roster, players, season) {
  const rows = rosterRows(roster, players).map((r) => {
    const m = players[r.pid] || {};
    const a = age(m);
    const ageDisp = Number.isInteger(a) ? a : '—';
    let bye = teamBye(r.team, season);
    if (!(Number.isInteger(bye) && bye >= 1 && bye <= 18)) bye = Number.isInteger(r.bye) ? r.bye : null;
    const byeDisp = Number.isInteger(bye) ? 'W' + bye : '—';
    return [r.name, r.pos, r.team, ageDisp, byeDisp];
  });
  renderSortableTable(container, ['Player', 'Pos', 'Team', 'Age', 'Bye'], rows, ['str', 'str', 'str', 'num', 'bye']);
}
function renderPos(container, posStats) {
  const order = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPER_FLEX'];
  const rows = [];
  for (const pos of order) {
    const s = posStats[pos]; if (!s) continue;
    rows.push([pos, s.my_value.toFixed(2), `${s.rank} / ${s.out_of}`, `${s.percentile}%`]);
  }
  renderTable(container, ['Pos', 'Points', 'Rank', 'Percentile'], rows);
}
function renderMatchup(sumDiv, myDiv, oppDiv, p) {
  renderTable(sumDiv, ['Team', 'Projected Total'], [[p.me.team_name || 'Me', p.me.projected_total], [p.opponent.team_name || 'Opponent', p.opponent.projected_total]]);
  renderTable(myDiv, ['My Starters', 'Pos', 'Team', 'Proj'], p.myStart.map((x) => [x.name, x.pos, x.team, x.proj.toFixed(2)]));
  renderTable(oppDiv, ['Opponent Starters', 'Pos', 'Team', 'Proj'], p.oppStart.map((x) => [x.name, x.pos, x.team, x.proj.toFixed(2)]));
}
async function matchupPreview(leagueId, week, league, users, rosters, players, projFn, myRid, myTeam) {
  let matchups = [];
  try { matchups = await fetchJSON(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`); } catch {}
  const byRid = new Map(matchups.filter((m) => m && typeof m === 'object').map((m) => [m.roster_id, m]));
  const myM = byRid.get(myRid);
  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map((r) => [r.roster_id, r]));
  const teamName = (rid) => { const r = rosterById[rid] || {}; const u = userById[r.owner_id] || {}; return (u.metadata?.team_name) || u.display_name || (rid ? `Team ${rid}` : null); };
  const starters = (rid) => { const m = byRid.get(rid) || {}; const r = rosterById[rid] || {}; return (m.starters || r.starters || []).filter((pid) => pid !== '0'); };
  const startersProj = (rid) => starters(rid).map((pid) => {
    const m = players[pid] || {};
    const name = m.full_name || (m.first_name && m.last_name ? `${m.first_name} ${m.last_name}` : (m.last_name || 'Unknown'));
    return { pid, name, pos: (m.position || 'UNK').toUpperCase(), team: m.team || 'FA', proj: +projFn(pid) || 0 };
  });
  let oppRid = null;
  if (myM) { const mid = myM.matchup_id; const opp = matchups.find((m) => m.matchup_id === mid && m.roster_id !== myRid); oppRid = opp?.roster_id ?? null; }
  const myStart = startersProj(myRid);
  const oppStart = oppRid ? startersProj(oppRid) : [];
  return { week, me: { team_name: myTeam, projected_total: +myStart.reduce((s, p) => s + p.proj, 0).toFixed(2) }, opponent: { team_name: teamName(oppRid), projected_total: +oppStart.reduce((s, p) => s + p.proj, 0).toFixed(2) }, myStart, oppStart };
}
function byeMatrix(roster, players, season, weeks = [5,6,7,8,9,10,11,12,13,14]) {
  const pids = rosterPids(roster);
  const set = new Set(), m = {};
  for (const pid of pids) {
    const pl = players[pid] || {};
    const pos = (pl.position || 'UNK').toUpperCase(); set.add(pos);
    let b = teamBye(pl.team, season); if (!(Number.isInteger(b) && b >= 1 && b <= 18)) b = Number.isInteger(pl.bye_week) ? pl.bye_week : null;
    if (!m[pos]) m[pos] = Object.fromEntries(weeks.map((w) => [w, 0]));
    if (Number.isInteger(b) && weeks.includes(b)) m[pos][b]++;
  }
  const order = ['QB', 'RB', 'WR', 'TE', ...[...set].filter((p) => !['QB','RB','WR','TE'].includes(p)).sort()];
  return { order, weeks, matrix: m };
}
function renderBye(container, { order, weeks, matrix }) {
  const headers = ['Pos', ...weeks.map((w) => 'W' + w), 'Total'];
  const rows = [];
  let col = Array(weeks.length).fill(0);
  for (const pos of order) {
    const counts = weeks.map((w, i) => { const v = (matrix[pos] || {})[w] || 0; col[i] += v; return v; });
    rows.push([pos, ...counts, counts.reduce((s, c) => s + c, 0)]);
  }
  rows.push(['TOTAL', ...col, col.reduce((s, c) => s + c, 0)]);
  renderTable(container, headers, rows);
}

// ===== User summary =====
function exposuresAcrossLeagues(leagues, userId, players) {
  const counter = new Map();
  for (const { rosters } of Object.values(leagues)) {
    const my = rosters.find((r) => r.owner_id === userId);
    if (!my) continue;
    for (const pid of rosterPids(my)) counter.set(pid, (counter.get(pid) || 0) + 1);
  }
  const rows = [];
  for (const [pid, count] of counter.entries()) {
    if (count < 2) continue;
    const m = players[pid] || {};
    const name = m.full_name || (m.first_name && m.last_name ? `${m.first_name} ${m.last_name}` : (m.last_name || 'Unknown'));
    rows.push({ pid, name, pos: (m.position || 'UNK').toUpperCase(), team: m.team || 'FA', count });
  }
  return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
async function userSummaryProjections(leagues, players, week) {
  const rows = [];
  await Promise.all(Object.values(leagues).map(async (entry) => {
    const { league, users, rosters } = entry;
    const season = +league.season;
    const scoring = league.scoring_settings || {};
    const myRoster = rosters.find((r) => r.owner_id === g.userId);
    if (!myRoster) return;
    const myUser = users.find((u) => u.user_id === myRoster.owner_id) || {};
    const myTeamName = (myUser.metadata?.team_name) || myUser.display_name || `Team ${myRoster.roster_id}`;
    const proj = await projByPid(season, week, 'regular', players, scoring);
    const projFn = (pid) => proj[String(pid)] || 0;
    const prev = await matchupPreview(league.league_id, week, league, users, rosters, players, projFn, myRoster.roster_id, myTeamName);
    rows.push([league.name, prev.me.projected_total.toFixed(2), prev.opponent.team_name || '—', prev.opponent.projected_total.toFixed(2)]);
  }));
  rows.sort((a, b) => parseFloat(b[1]) - parseFloat(a[1]));
  return rows;
}
function userSummaryByeCount(leagues, players, season, week) {
  const rows = [];
  for (const { league, rosters } of Object.values(leagues)) {
    const my = rosters.find((r) => r.owner_id === g.userId);
    if (!my) continue;
    let total = 0;
    for (const pid of rosterPids(my)) {
      const m = players[pid] || {};
      let b = teamBye(m.team, season);
      if (!(Number.isInteger(b) && b >= 1 && b <= 18)) b = Number.isInteger(m.bye_week) ? m.bye_week : null;
      if (b === week) total++;
    }
    rows.push([league.name, total]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  return rows;
}
async function renderUserSummary() {
  $('#leagueViews').classList.add('hidden');
  $('#userSummary').classList.remove('hidden');
  $('#contextNote').textContent = '';

  const week = +($('#weekSelect').value || 1);
  const seasonSel = +($('#seasonMain').value || 2025);

  const ex = exposuresAcrossLeagues(g.leagues, g.userId, g.players);
  const rootRows = ex.map((r) => [r.name, r.pos, r.team, r.count]);
  renderSortableTable($('#usRootTable'), ['Player', 'Pos', 'Team', 'Leagues'], rootRows, ['str', 'str', 'str', 'num']);

  $('#usProjTable').innerHTML = '<div class="note">Calculating projections…</div>';
  const projRows = await userSummaryProjections(g.leagues, g.players, week);
  renderTable($('#usProjTable'), ['League', 'My Proj', 'Opponent', 'Opp Proj'], projRows);

  const byeRows = userSummaryByeCount(g.leagues, g.players, seasonSel, week).map((r) => [r[0], r[1]]);
  renderTable($('#usByeTable'), ['League', 'Players on Bye (W' + week + ')'], byeRows);
}

// ===== UI utilities =====
function setWeekOptions() {
  const wk = $('#weekSelect'); if (!wk) return;
  wk.innerHTML = '';
  for (let w = 1; w <= 18; w++) {
    const o = el('option', { value: String(w), html: 'Week ' + w }); if (w === 1) o.selected = true;
    wk.append(o);
  }
}
function showControls() { $('#seasonGroup').classList.remove('hidden'); $('#weekGroup').classList.remove('hidden'); }
function resetMain() {
  $('#leagueViews').classList.add('hidden'); $('#userSummary').classList.add('hidden');
  $('#contextNote').textContent = '';
  ['#rosterTable','#posTable','#matchupSummary','#myStarters','#oppStarters','#byeMatrix','#usRootTable','#usProjTable','#usByeTable'].forEach(s=>{ const n=$(s); if(n) n.innerHTML=''; });
}
function renderLeagueList(active = null) {
  const list = $('#leagueList'); if (!list) return;
  list.innerHTML = '';
  const ids = Object.keys(g.leagues);
  if (ids.length === 0) { list.append(el('div', { class: 'li-sub', html: 'No leagues loaded yet.' })); return; }
  ids.forEach((id) => {
    const { league, users, rosters } = g.leagues[id];
    const myRoster = rosters?.find?.((r) => r.owner_id === g.userId);
    const myUser = users?.find?.((u) => u.user_id === myRoster?.owner_id) || {};
    const myTeamName = (myUser.metadata?.team_name) || myUser.display_name || `Team ${myRoster?.roster_id ?? ''}`;
    const item = el('div', { class: 'league-item' + (id === active ? ' active' : ''), 'data-id': id }, [
      el('div', {}, [
        el('div', { class: 'li-title', html: league?.name || `League ${id}` }),
        el('div', { class: 'li-sub', html: myTeamName || '' })
      ])
    ]);
    item.addEventListener('click', async () => {
      g.mode = 'league'; g.selected = id;
      document.querySelectorAll('.league-item').forEach((n) => n.classList.remove('active'));
      item.classList.add('active'); $('#summaryItem').classList.remove('active');
      await renderSelectedLeague();
    });
    list.append(item);
  });
}
async function renderSelectedLeague() {
  const id = g.selected; if (!id) return;
  const { league, users, rosters } = g.leagues[id];
  const season = +league.season;
  const week = +($('#weekSelect').value || 1);
  const myRoster = rosters.find((r) => r.owner_id === g.userId) || rosters[0];
  const myUser = users.find((u) => u.user_id === myRoster.owner_id) || {};
  const myTeamName = (myUser.metadata?.team_name) || myUser.display_name || `Team ${myRoster.roster_id}`;

  renderRoster($('#rosterTable'), myRoster, g.players, season);

  const scoring = league.scoring_settings || {};
  const proj = await projByPid(season, week, 'regular', g.players, scoring);
  const projFn = (pid) => proj[String(pid)] || 0;
  const vals = rosters.reduce((acc, r) => { acc[r.roster_id] = teamPosValues(league, rosterRows(r, g.players, projFn)); return acc; }, {});
  const mine = vals[myRoster.roster_id];
  const posStats = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPER_FLEX']) {
    const list = rosters.map((r) => vals[r.roster_id][pos] || 0);
    const my = list[rosters.findIndex((r) => r.roster_id === myRoster.roster_id)];
    const { rank, out_of, pct } = rankPct(list, my);
    posStats[pos] = { my_value: +my.toFixed(2), rank, out_of, percentile: pct };
  }
  renderPos($('#posTable'), posStats);

  const prev = await matchupPreview(league.league_id, week, league, users, rosters, g.players, projFn, myRoster.roster_id, myTeamName);
  renderMatchup($('#matchupSummary'), $('#myStarters'), $('#oppStarters'), prev);

  renderBye($('#byeMatrix'), byeMatrix(myRoster, g.players, season));

  $('#userSummary').classList.add('hidden');
  $('#leagueViews').classList.remove('hidden');
  $('#contextNote').textContent = `${league.name} • ${league.season}`;
}

// ===== Shared loader used by landing + sidebar button =====
async function loadForUsername(uname) {
  console.log('[MFA] loadForUsername', uname);
  resetMain();
  renderStatus('', 'Looking up your leagues…');
  try {
    if (!g.players) g.players = await loadPlayersMap();
    const uid = await resolveUserId(uname);
    if (!uid) { renderStatus('err', `Couldn’t find a Sleeper account for “${uname}”.`); return; }
    g.userId = uid;

    const season = $('#seasonMain').value || '2025';
    const leagues = await loadMyLeagues(uid, season);
    if (!Array.isArray(leagues) || leagues.length === 0) {
      renderStatus('err', `No leagues found in ${season}.`);
      $('#leagueList').innerHTML = '';
      return;
    }
    g.leagues = {};
    await Promise.all(leagues.map(async (L) => { g.leagues[L.league_id] = await loadLeagueBundle(L.league_id); }));
    setWeekOptions(); showControls();

    const sm = $('#summaryItem');
    sm.classList.remove('hidden'); sm.classList.add('active');
    sm.onclick = async () => {
      g.mode = 'summary'; g.selected = null;
      document.querySelectorAll('.league-item').forEach((n) => n.classList.remove('active'));
      sm.classList.add('active'); await renderUserSummary();
    };

    renderLeagueList();
    g.mode = 'summary';
    await renderUserSummary();
    $('#contextNote').textContent = '';
    renderStatus('ok', `Loaded ${leagues.length} league(s).`);
  } catch (err) {
    console.error('[MFA] loadForUsername error', err);
    renderStatus('err', 'Failed to load leagues.');
  }
}

// ===== Events & init =====
function wireEvents() {
  $('#weekSelect').addEventListener('change', async () => { if (g.mode === 'summary') await renderUserSummary(); else await renderSelectedLeague(); });
  $('#seasonMain').addEventListener('change', async () => {
    if (!g.userId) return;
    renderStatus('', 'Reloading leagues for selected season…');
    try {
      const season = $('#seasonMain').value;
      const leagues = await loadMyLeagues(g.userId, season);
      g.leagues = {};
      await Promise.all(leagues.map(async (L) => { g.leagues[L.league_id] = await loadLeagueBundle(L.league_id); }));
      renderStatus('ok', `Loaded ${leagues.length} league(s).`);
      renderLeagueList();
      g.mode = 'summary'; $('#summaryItem').classList.add('active'); await renderUserSummary();
    } catch (e) { console.error(e); renderStatus('err', 'Failed to reload for that season.'); }
  });

  $('#viewLeaguesBtn').addEventListener('click', async () => {
    const uname = $('#username').value.trim();
    if (!uname) { renderStatus('err', 'Please enter a username.'); return; }
    await loadForUsername(uname);
  });

  $('#username').addEventListener('input', () => { $('#viewLeaguesBtn').disabled = !$('#username').value.trim(); });
  $('#manualLeagueId').addEventListener('input', () => { $('#addLeagueBtn').disabled = !$('#manualLeagueId').value.trim(); });
  $('#addLeagueBtn').addEventListener('click', async () => {
    const id = $('#manualLeagueId').value.trim(); if (!id) return;
    try {
      const b = await loadLeagueBundle(id); g.leagues[id] = b; renderLeagueList(g.selected);
      $('#manualLeagueId').value = ''; $('#addLeagueBtn').disabled = true; renderStatus('ok', 'League added. Click it in the list.');
    } catch (e) { console.error(e); renderStatus('err', 'Could not add that League ID.'); }
  });

  document.addEventListener('click', (e) => {
    const btn1 = e.target.closest('#leagueTabs .tab-btn');
    if (btn1) {
      document.querySelectorAll('#leagueTabs .tab-btn').forEach((x) => x.classList.remove('active'));
      btn1.classList.add('active');
      const id = btn1.dataset.tab;
      document.querySelectorAll('#leagueSections > section').forEach((s) => s.classList.toggle('active', s.id === id));
      return;
    }
    const btn2 = e.target.closest('#usTabs .tab-btn');
    if (btn2) {
      document.querySelectorAll('#usTabs .tab-btn').forEach((x) => x.classList.remove('active'));
      btn2.classList.add('active');
      const id = btn2.dataset.tab;
      document.querySelectorAll('#userSummary .sections > section').forEach((s) => s.classList.toggle('active', s.id === id));
      return;
    }
  });

  // Landing
  const landingInput = $('#landingUsername');
  const landingGo = $('#landingGo');
  landingInput.addEventListener('input', () => { landingGo.disabled = !landingInput.value.trim(); });
  landingInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !landingGo.disabled) landingGo.click(); });
  landingGo.addEventListener('click', async () => {
    const uname = landingInput.value.trim(); if (!uname) return;
    $('#landing').classList.add('hidden');
    $('#appLayout').classList.remove('hidden');
    $('#username').value = uname;
    $('#viewLeaguesBtn').disabled = false;
    await loadForUsername(uname);
  });
}

// -- Safety net: build required markup if HTML is missing pieces
function ensureScaffold() {
  const once = (parent, selector, builder) => {
    if (!parent.querySelector(selector)) parent.append(builder());
  };

  const app = document.getElementById('appLayout');
  const aside = app?.querySelector('aside');
  if (aside && !aside.children.length) {
    const status = el('div', { id: 'status', class: 'status', html: 'Enter your Sleeper username, choose a season (center), and click <b>View Leagues</b>.' });
    const inputs = el('div', { class: 'inputs' }, [
      el('div', {}, [ el('label', { for: 'username', html: 'Sleeper Username' }), el('input', { id: 'username', placeholder: '' }) ]),
      el('div', { style: 'align-self:end; display:flex; gap:8px; justify-content:flex-end' }, [ el('button', { id: 'viewLeaguesBtn', disabled: 'true', html: 'View Leagues' }) ])
    ]);
    const row2 = el('div', { class: 'row-2' }, [ el('input', { id: 'manualLeagueId', placeholder: 'League ID (optional)' }), el('button', { id: 'addLeagueBtn', disabled: 'true', html: 'Add' }) ]);
    const head1 = el('div', { class: 'nav-head', html: 'Overview' });
    const summaryItem = el('div', { id: 'summaryItem', class: 'summary-item hidden' }, [ el('div', {}, [ el('div', { class: 'li-title', html: 'User Summary' }), el('div', { class: 'li-sub', html: 'Cross-league view' }) ]) ]);
    const head2 = el('div', { class: 'nav-head', html: 'Your Leagues' });
    const leagueList = el('div', { id: 'leagueList', class: 'league-list' });
    aside.append(status, inputs, row2, head1, summaryItem, head2, leagueList);
  }

  const controls = app?.querySelector('.main .controls');
  if (controls && !controls.children.length) {
    const g1 = el('div', { class: 'group', style: 'min-width:260px' }, [ el('div', { class: 'note', id: 'contextNote' }) ]);
    const g2 = el('div', { class: 'group hidden', id: 'seasonGroup' }, [
      el('label', { for: 'seasonMain', html: 'Season' }),
      (() => { const s = el('select', { id: 'seasonMain' }); s.append(el('option', { value: '2025', html: '2025' }), el('option', { value: '2024', html: '2024' })); s.value = '2025'; return s; })()
    ]);
    const g3 = el('div', { class: 'group hidden', id: 'weekGroup' }, [ el('label', { for: 'weekSelect', html: 'Week' }), el('select', { id: 'weekSelect' }) ]);
    controls.append(g1, g2, g3);
  }

  const us = document.getElementById('userSummary');
  if (us && !us.children.length) {
    const tabs = el('div', { class: 'tabs', id: 'usTabs' }, [
      el('button', { class: 'tab-btn active', 'data-tab': 'us-root', html: 'Who to Root For' }),
      el('button', { class: 'tab-btn', 'data-tab': 'us-proj', html: 'Projections' }),
      el('button', { class: 'tab-btn', 'data-tab': 'us-byes', html: 'Bye Count' })
    ]);
    const sections = el('div', { class: 'sections' }, [
      el('section', { id: 'us-root', class: 'active' }, el('div', { id: 'usRootTable' })),
      el('section', { id: 'us-proj' }, el('div', { id: 'usProjTable' })),
      el('section', { id: 'us-byes' }, el('div', { id: 'usByeTable' }))
    ]);
    us.append(tabs, sections);
  }

  const lv = document.getElementById('leagueViews');
  if (lv && !lv.children.length) {
    const tabs2 = el('div', { class: 'tabs', id: 'leagueTabs' }, [
      el('button', { class: 'tab-btn active', 'data-tab': 'tab-roster', html: 'My Roster' }),
      el('button', { class: 'tab-btn', 'data-tab': 'tab-pos', html: 'Team Projections' }),
      el('button', { class: 'tab-btn', 'data-tab': 'tab-matchup', html: 'Opponent Projections' }),
      el('button', { class: 'tab-btn', 'data-tab': 'tab-byes', html: 'Bye Week Matrix' })
    ]);
    const sections2 = el('div', { class: 'sections', id: 'leagueSections' }, [
      el('section', { id: 'tab-roster', class: 'active' }, el('div', { id: 'rosterTable' })),
      el('section', { id: 'tab-pos' }, el('div', { id: 'posTable' })),
      el('section', { id: 'tab-matchup' }, [ el('div', { id: 'matchupSummary' }), el('div', { class: 'row', style: 'margin-top:8px' }, [ el('div', { id: 'myStarters' }), el('div', { id: 'oppStarters' }) ]) ]),
      el('section', { id: 'tab-byes' }, el('div', { id: 'byeMatrix' }))
    ]);
    lv.append(tabs2, sections2);
  }

  console.log('[MFA] scaffold ensured (children)', {
    asideKids: aside?.children.length || 0,
    controlsKids: controls?.children.length || 0,
    userSummaryKids: us?.children.length || 0,
    leagueViewsKids: lv?.children.length || 0
  });
}

function init() {
  ensureScaffold();
  // start on landing; app hidden
  $('#appLayout').classList.add('hidden');
  $('#landing').classList.remove('hidden');
  // week options
  setWeekOptions();
  wireEvents();
  console.log('[MFA] ready');
}

window.addEventListener('DOMContentLoaded', init);
