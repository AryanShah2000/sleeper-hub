// ===== App state =====
let g = { players: null, userId: null, leagues: {}, selected: null, mode: 'summary' };

// ===== Tiny DOM helpers + cache =====
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

let statusHideTimer = null;
const TTL = 3 * 3600 * 1000;
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

function status(kind, msg) {
  const s = $('#status'); if (!s) return;
  if (statusHideTimer) clearTimeout(statusHideTimer);
  s.className = 'status ' + (kind || '');
  s.innerHTML = msg;
  s.classList.remove('hidden');
  if (kind === 'ok') {
    statusHideTimer = setTimeout(() => { s.classList.add('hidden'); }, 3000);
  }
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
  const ks = ['ppr','pts_ppr','fantasy_points_ppr'];
  for (const k of ks) if (it?.[k] != null) return +it[k] || 0;
  const s = it?.stats || {};
  for (const k of ks) if (s?.[k] != null) return +s[k] || 0;
  return 0;
}
async function providerRows(season, week, season_type) {
  const url = `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=${season_type}&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=ppr`;
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
  const pos = (meta.position || 'UNK').toUpperCase();
  const row = rowsByPid[pid];

  if (pos === 'K' || pos === 'DEF' || pos === 'DST' || pos === 'D/ST') {
    return row ? feedPPR(row) : 0;
  }

  const st = (row || {}).stats || {};
  const v = (k) => +((st?.[k]) || 0);
  const sc = scoring || {};
  let pts = 0;
  pts += v('pass_yd')*(sc.pass_yd||0) + v('pass_td')*(sc.pass_td||0) + v('pass_int')*(sc.pass_int||0) + v('pass_2pt')*(sc.pass_2pt||0);
  pts += v('rush_yd')*(sc.rush_yd||0) + v('rush_td')*(sc.rush_td||0) + v('rush_2pt')*(sc.rush_2pt||0);
  const rec = v('rec');
  pts += rec*(sc.rec||0) + v('rec_yd')*(sc.rec_yd||0) + v('rec_td')*(sc.rec_td||0) + v('rec_2pt')*(sc.rec_2pt||0);
  pts += v('fum_lost')*(sc.fum_lost||0);
  if (pos === 'TE') pts += rec*(sc.bonus_rec_te||0);
  return +pts.toFixed(2);
}
async function projByPid(season, week, season_type, players, scoring) {
  const rows = await providerRows(season, week, season_type);
  const out = {};
  Object.keys(rows).forEach((pid) => (out[pid] = rescored(pid, rows, players, scoring)));
  return out;
}

// ===== Helpers: rosters/ages/byes/record =====
function rosterPids(roster) {
  const s = new Set([...(roster.players||[]), ...(roster.starters||[]), ...(roster.taxi||[])]);
  s.delete('0'); return [...s];
}
function rosterRows(roster, players, projFn) {
  return rosterPids(roster).map((pid) => {
    const m = players[pid] || {};
    const name = m.full_name || (m.first_name && m.last_name ? `${m.first_name} ${m.last_name}` : (m.last_name || 'Unknown'));
    return { pid, name, pos: (m.position||'UNK').toUpperCase(), team: m.team||'FA', proj: projFn ? +projFn(pid)||0 : null, bye: m.bye_week };
  });
}
function selectBest(rows, set, k) {
  const pool = rows.filter((r)=>set.has(r.pos)).sort((a,b)=>b.proj-a.proj);
  const picks = pool.slice(0,k); const ids = new Set(picks.map((p)=>p.pid));
  return { picks, remaining: rows.filter((r)=>!ids.has(r.pid)) };
}
function teamPosValues(league, rows) {
  const rp = (league.roster_positions||[]).map((x)=>String(x).toUpperCase());
  const PURE = { QB: rp.filter(x=>x==='QB').length, RB: rp.filter(x=>x==='RB').length, WR: rp.filter(x=>x==='WR').length, TE: rp.filter(x=>x==='TE').length };
  const FLEX = rp.filter(x=>x==='FLEX').length, SFLEX = rp.filter(x=>x==='SUPER_FLEX').length;
  let remaining = rows.slice(), values = {};
  for (const [pos,k] of Object.entries(PURE)) {
    const { picks, remaining: rem } = selectBest(remaining, new Set([pos]), k);
    remaining = rem; values[pos] = picks.reduce((s,p)=>s+p.proj,0);
  }
  if (FLEX){ const { picks, remaining: rem } = selectBest(remaining, new Set(['RB','WR','TE']), FLEX); remaining=rem; values.FLEX=picks.reduce((s,p)=>s+p.proj,0);} else values.FLEX=0;
  if (SFLEX){ const { picks, remaining: rem } = selectBest(remaining, new Set(['QB','RB','WR','TE']), SFLEX); remaining=rem; values.SUPER_FLEX=picks.reduce((s,p)=>s+p.proj,0);} else values.SUPER_FLEX=0;
  return values;
}
function rankPct(vals, mine){ const sv=[...vals].sort((a,b)=>b-a); const rank=sv.indexOf(mine)+1; const n=sv.length; const below=sv.filter(v=>v<mine).length; return {rank, out_of:n, pct:Math.round(1000*below/n)/10}; }
function parseBD(meta){ for (const k of ['birth_date','birthdate','birthDate']){ const raw=meta?.[k]; if(!raw) continue; const d=new Date(String(raw).slice(0,10)); if(!isNaN(d)) return d; } return null; }
function ageFrom(d){ const now=new Date(); let a=now.getFullYear()-d.getFullYear(); const m=now.getMonth()-d.getMonth(); if(m<0||(m===0&&now.getDate()<d.getDate())) a--; return a; }
function age(meta){ if (meta?.age!=null){ const n=+meta.age; if (Number.isFinite(n)&&n>0) return Math.floor(n);} const bd=parseBD(meta); return bd?ageFrom(bd):null; }
const BYE_2025={ATL:5,CHI:5,GB:5,PIT:5,HOU:6,MIN:6,BAL:7,BUF:7,ARI:8,DET:8,JAX:8,LV:8,LAR:8,SEA:8,CLE:9,NYJ:9,PHI:9,TB:9,CIN:10,DAL:10,KC:10,TEN:10,IND:11,NO:11,DEN:12,LAC:12,MIA:12,WAS:12,CAR:14,NE:14,NYG:14,SF:14};
function teamBye(team, season){ return season==2025 ? BYE_2025[team] : null; }
function rosterRecord(roster){
  const s = roster?.settings || {};
  const w = Number.isFinite(+s.wins)   ? +s.wins   : 0;
  const l = Number.isFinite(+s.losses) ? +s.losses : 0;
  const t = Number.isFinite(+s.ties)   ? +s.ties   : 0;
  return t > 0 ? `(${w}-${l}-${t})` : `(${w}-${l})`;
}

// ===== Render helpers =====
function renderTable(container, headers, rows){
  const table=el('table'), thead=el('thead'), tbody=el('tbody');
  thead.append(el('tr',{},headers.map(h=>el('th',{html:h}))));
  rows.forEach(r=>tbody.append(el('tr',{},r.map(c=>el('td',{html:String(c)})))));
  table.append(thead,tbody); container.innerHTML=''; container.append(table);
}
function renderSortableTable(container, headers, rows, types){
  const table=el('table'), thead=el('thead'), tbody=el('tbody'); let sortCol=-1, sortDir='desc';
  const parse=(v,t)=>(t==='num'?(Number.isNaN(+v)?null:+v): t==='bye'?(v&&String(v).startsWith('W')?+String(v).slice(1):Number.isNaN(+v)?null:+v) : String(v||''));
  const cmp=(a,b,t,d)=>{const mul=d==='asc'?1:-1; if(t==='str') return mul*String(a).localeCompare(String(b)); if(a==null&&b==null) return 0; if(a==null) return 1; if(b==null) return -1; return mul*(a-b);};
  function head(){ const tr=el('tr'); headers.forEach((h,i)=>{ const th=el('th'); th.classList.add('sortable'); th.append(el('span',{html:h}), el('span',{class:'arrow',html:''}));
    th.addEventListener('click',()=>{ if(sortCol===i) sortDir=sortDir==='asc'?'desc':'asc'; else{sortCol=i; sortDir='desc';} body(); arrows(); }); tr.append(th);});
    thead.innerHTML=''; thead.append(tr);
  }
  function arrows(){ thead.querySelectorAll('th').forEach((th,i)=>{ th.classList.remove('sorted-asc','sorted-desc'); const a=th.querySelector('.arrow'); if(!a) return;
    if(i===sortCol){ th.classList.add(sortDir==='asc'?'sorted-asc':'sorted-desc'); a.textContent=sortDir==='asc'?'▲':'▼'; } else a.textContent=''; });}
  function body(){ const t=rows.map(r=>({raw:r,key:r.map((c,idx)=>parse(c,types[idx]))})); if(sortCol>=0) t.sort((ra,rb)=>cmp(ra.key[sortCol],rb.key[sortCol],types[sortCol],sortDir));
    tbody.innerHTML=''; t.forEach(r=>tbody.append(el('tr',{},r.raw.map(c=>el('td',{html:String(c)}))))); }
  head(); body(); arrows(); table.append(thead,tbody); container.innerHTML=''; container.append(table);
}

// ===== League/summary renders =====
function renderRoster(container, roster, players, season){
  const rows = rosterRows(roster, players).map((r)=>{
    const m=players[r.pid]||{}; const a=age(m); const ageDisp=Number.isInteger(a)?a:'—';
    let bye=teamBye(r.team, season); if(!(Number.isInteger(bye)&&bye>=1&&bye<=18)) bye=Number.isInteger(r.bye)?r.bye:null;
    const byeDisp=Number.isInteger(bye)?('W'+bye):'—';
    return [r.name, r.pos, r.team, ageDisp, byeDisp];
  });
  renderSortableTable(container, ['Player','Pos','Team','Age','Bye'], rows, ['str','str','str','num','bye']);
}
function renderPos(container, posStats){
  const order=['QB','RB','WR','TE','FLEX','SUPER_FLEX']; const rows=[];
  for (const pos of order){ const s=posStats[pos]; if(!s) continue; rows.push([pos, s.my_value.toFixed(2), `${s.rank} / ${s.out_of}`, `${s.percentile}%`]); }
  renderTable(container, ['Pos','Points','Rank','Percentile'], rows);
}
function renderMatchup(sumDiv, myDiv, oppDiv, p){
  renderTable(sumDiv,['Team','Projected Total'],[[p.me.team_name||'Me',p.me.projected_total],[p.opponent.team_name||'Opponent',p.opponent.projected_total]]);
  renderTable(myDiv,['My Starters','Pos','Team','Proj'], p.myStart.map(x=>[x.name,x.pos,x.team,x.proj.toFixed(2)]));
  renderTable(oppDiv,['Opponent Starters','Pos','Team','Proj'], p.oppStart.map(x=>[x.name,x.pos,x.team,x.proj.toFixed(2)]));
}
async function matchupPreview(leagueId, week, league, users, rosters, players, projFn, myRid, myTeam){
  let matchups=[]; try{ matchups = await fetchJSON(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`);}catch{}
  const byRid = new Map(matchups.filter(m=>m&&typeof m==='object').map(m=>[m.roster_id,m]));
  const myM = byRid.get(myRid);
  const userById = Object.fromEntries(users.map(u=>[u.user_id,u]));
  const rosterById = Object.fromEntries(rosters.map(r=>[r.roster_id,r]));
  const teamName = (rid)=>{ const r=rosterById[rid]||{}; const u=userById[r.owner_id]||{}; return (u.metadata?.team_name)||u.display_name||(rid?`Team ${rid}`:null); };
  const starters = (rid)=>{ const m=byRid.get(rid)||{}; const r=rosterById[rid]||{}; return (m.starters||r.starters||[]).filter(pid=>pid!=='0'); };
  const startersProj = (rid)=> starters(rid).map(pid=>{ const m=players[pid]||{}; const name=m.full_name||(m.first_name&&m.last_name?`${m.first_name} ${m.last_name}`:(m.last_name||'Unknown')); return { pid, name, pos:(m.position||'UNK').toUpperCase(), team:m.team||'FA', proj:+projFn(pid)||0}; });
  let oppRid = null; if (myM){ const mid=myM.matchup_id; const opp = matchups.find(m=>m.matchup_id===mid && m.roster_id!==myRid); oppRid = opp?.roster_id ?? null; }
  const myStart = startersProj(myRid); const oppStart = oppRid ? startersProj(oppRid) : [];
  return { week, me:{ team_name:myTeam, projected_total:+myStart.reduce((s,p)=>s+p.proj,0).toFixed(2) }, opponent:{ team_name:teamName(oppRid), projected_total:+oppStart.reduce((s,p)=>s+p.proj,0).toFixed(2) }, myStart, oppStart };
}

// ===== Bye matrix (cross-league, full season) =====
function byeMatrixAcrossLeagues(leagues, userId, players, season, weeks = Array.from({length:18},(_,i)=>i+1)){
  const rows = [];
  for (const { league, rosters } of Object.values(leagues)) {
    const my = rosters.find(r => r.owner_id === userId);
    if (!my) continue;

    const counts = weeks.map(() => 0);
    for (const pid of rosterPids(my)) {
      const meta = players[pid] || {};
      let b = teamBye(meta.team, season);
      if (!(Number.isInteger(b) && b >= 1 && b <= 18)) b = Number.isInteger(meta.bye_week) ? meta.bye_week : null;
      if (Number.isInteger(b) && b >= 1 && b <= 18) counts[b - 1] += 1;
    }
    const total = counts.reduce((s, c) => s + c, 0);
    rows.push({ leagueName: league.name, counts, total });
  }
  rows.sort((a,b)=>b.total - a.total || a.leagueName.localeCompare(b.leagueName));
  return { weeks, rows };
}
function renderByeAcrossLeagues(container, data){
  const headers = ['League', ...data.weeks.map(w => 'W' + w), 'Total'];
  const rows = data.rows.map(r => [r.leagueName, ...r.counts, r.total]);
  const types = ['str', ...data.weeks.map(()=> 'num'), 'num'];
  renderSortableTable(container, headers, rows, types);
}

// ===== Exposures (user summary) =====
function ownedExposuresAcrossLeagues(leagues, userId) {
  const counter = new Map();
  for (const { rosters } of Object.values(leagues)) {
    const my = rosters.find(r => r.owner_id === userId);
    if (!my) continue;
    const pids = new Set([...(my.players || []), ...(my.starters || []), ...(my.taxi || [])]);
    pids.delete('0');
    for (const pid of pids) counter.set(pid, (counter.get(pid) || 0) + 1);
  }
  return counter;
}
async function opponentExposuresAcrossLeagues(leagues, userId, week) {
  const counter = new Map();

  await Promise.all(Object.values(leagues).map(async ({ league, users, rosters }) => {
    const my = rosters.find(r => r.owner_id === userId);
    if (!my) return;

    let matchups = [];
    try {
      matchups = await fetchJSON(`https://api.sleeper.app/v1/league/${league.league_id}/matchups/${week}`);
    } catch {}

    const byRid = new Map((matchups || []).filter(m => m && typeof m === 'object').map(m => [m.roster_id, m]));
    const myM = byRid.get(my.roster_id);

    let oppRid = null;
    if (myM) {
      const mid = myM.matchup_id;
      const opp = (matchups || []).find(m => m.matchup_id === mid && m.roster_id !== my.roster_id);
      oppRid = opp?.roster_id ?? null;
    }

    if (!oppRid) return;

    const rosterById = Object.fromEntries(rosters.map(r => [r.roster_id, r]));
    const oppMatch = byRid.get(oppRid) || {};
    const oppRoster = rosterById[oppRid] || {};
    const starters = (oppMatch.starters || oppRoster.starters || []).filter(pid => pid !== '0');

    for (const pid of starters) counter.set(pid, (counter.get(pid) || 0) + 1);
  }));

  return counter;
}

async function renderUserSummary(){
  $('#leagueViews').classList.add('hidden'); $('#userSummary').classList.remove('hidden'); $('#contextNote').textContent=''; $('#posNote').textContent='';

  const week=+($('#weekSelect').value||1); const seasonSel=+($('#seasonMain').value||2025);

  const haveMap = ownedExposuresAcrossLeagues(g.leagues, g.userId);
  const vsMap   = await opponentExposuresAcrossLeagues(g.leagues, g.userId, week);

  const rowsFor = [];
  for (const [pid, haveCount] of haveMap.entries()) {
    if (haveCount < 2) continue;
    const m = g.players[pid] || {};
    const name = m.full_name || (m.first_name && m.last_name ? `${m.first_name} ${m.last_name}` : (m.last_name || 'Unknown'));
    const pos = (m.position || 'UNK').toUpperCase();
    const team = m.team || 'FA';
    const vsCount = vsMap.get(pid) || 0;
    rowsFor.push([name, pos, team, haveCount, vsCount]);
  }
  rowsFor.sort((a, b) => b[3] - a[3] || a[0].localeCompare(b[0]));
  if (rowsFor.length === 0) {
    $('#usRootForTable').innerHTML = '<div class="note">No players with 2+ exposures.</div>';
  } else {
    renderSortableTable($('#usRootForTable'),
      ['Player','Pos','Team','Leagues (Have)','Leagues (Vs)'],
      rowsFor, ['str','str','str','num','num']);
  }

  const rowsAgainst = [];
  for (const [pid, vsCount] of vsMap.entries()) {
    if (vsCount < 2) continue;
    const m = g.players[pid] || {};
    const name = m.full_name || (m.first_name && m.last_name ? `${m.first_name} ${m.last_name}` : (m.last_name || 'Unknown'));
    const pos = (m.position || 'UNK').toUpperCase();
    const team = m.team || 'FA';
    const haveCount = haveMap.get(pid) || 0;
    rowsAgainst.push([name, pos, team, vsCount, haveCount]);
  }
  rowsAgainst.sort((a, b) => b[3] - a[3] || a[0].localeCompare(b[0]));
  if (rowsAgainst.length === 0) {
    $('#usRootAgainstTable').innerHTML = '<div class="note">No opponents with 2+ exposures this week.</div>';
  } else {
    renderSortableTable($('#usRootAgainstTable'),
      ['Player','Pos','Team','Leagues (Vs)','Leagues (Have)'],
      rowsAgainst, ['str','str','str','num','num']);
  }

  // Projections with winner arrow
  $('#usProjTable').innerHTML = '<div class="note">Calculating projections…</div>';
  const projRows = await userSummaryProjections(g.leagues, g.players, week);
  renderTable($('#usProjTable'), ['League','My Proj','Opp Proj','Opponent'], projRows);

  // Full-season bye matrix only
  const matrixData = byeMatrixAcrossLeagues(g.leagues, g.userId, g.players, seasonSel);
  renderByeAcrossLeagues($('#usByeMatrix'), matrixData);
}

async function userSummaryProjections(leagues, players, week){
  const rows=[]; await Promise.all(Object.values(leagues).map(async (entry)=>{
    const {league,users,rosters}=entry; const season=+league.season; const scoring=league.scoring_settings||{};
    const myRoster=rosters.find(r=>r.owner_id===g.userId); if(!myRoster) return;
    const myUser=users.find(u=>u.user_id===myRoster.owner_id)||{};
    const myTeamName=(myUser.metadata?.team_name)||myUser.display_name||`Team ${myRoster.roster_id}`;
    const proj=await projByPid(season, week, 'regular', players, scoring); const projFn=(pid)=>proj[String(pid)]||0;
    const prev=await matchupPreview(league.league_id, week, league, users, rosters, players, projFn, myRoster.roster_id, myTeamName);

    const me = +prev.me.projected_total.toFixed(2);
    const opp = +prev.opponent.projected_total.toFixed(2);
    const myCell  = me >= opp ? `${me.toFixed(2)} <span class="win-arrow">➜</span>` : me.toFixed(2);
    const oppCell = opp >  me ? `${opp.toFixed(2)} <span class="win-arrow">➜</span>` : opp.toFixed(2);

    rows.push([league.name, myCell, oppCell, prev.opponent.team_name||'—']);
  }));
  rows.sort((a,b)=>parseFloat(b[1]) - parseFloat(a[1]));
  return rows;
}

function userSummaryByeCount(leagues, players, season, week){
  const rows=[]; for (const {league,rosters} of Object.values(leagues)){ const my=rosters.find(r=>r.owner_id===g.userId); if(!my) continue; let total=0;
    for (const pid of rosterPids(my)){ const m=players[pid]||{}; let b=teamBye(m.team, season); if(!(Number.isInteger(b)&&b>=1&&b<=18)) b=Number.isInteger(m.bye_week)?m.bye_week:null; if (b===week) total++; }
    rows.push([league.name, total]); } rows.sort((a,b)=>b[1]-a[1]); return rows;
}

// ===== Alerts (badges + tab) =====
async function computeLeagueAlertCount(entry, week, players){
  const { league, users, rosters } = entry;
  const myRoster = rosters.find(r => r.owner_id === g.userId);
  if (!myRoster) return 0;
  const season = +league.season;
  const scoring = league.scoring_settings || {};
  const proj = await projByPid(season, week, 'regular', players, scoring);
  const projFn = (pid) => proj[String(pid)] || 0;

  const myUser = users.find(u => u.user_id === myRoster.owner_id) || {};
  const myTeamName = (myUser.metadata?.team_name) || myUser.display_name || `Team ${myRoster.roster_id}`;
  const prev = await matchupPreview(league.league_id, week, league, users, rosters, players, projFn, myRoster.roster_id, myTeamName);

  return prev.myStart.filter(x => (x.proj || 0) === 0).length;
}
async function updateLeagueAlertBadges(week){
  const list = $('#leagueList');
  if (!list) return;
  const entries = Object.entries(g.leagues);
  await Promise.all(entries.map(async ([id, entry]) => {
    let count = 0;
    try { count = await computeLeagueAlertCount(entry, week, g.players); } catch {}
    const badge = list.querySelector(`[data-id="${id}"] .alert-badge`);
    if (badge){
      if (count > 0){ badge.textContent = String(count); badge.classList.remove('hidden'); }
      else { badge.textContent = '0'; badge.classList.add('hidden'); }
    }
  }));
}

function renderAlerts(container, { flagged, candidatesByPid, week }){
  container.innerHTML = '';
  if (flagged.length === 0) {
    container.innerHTML = `<div class="note">No alerts for Week ${week}. All starters have projections.</div>`;
    return;
  }

  flagged.forEach(p => {
    container.append(el('h3', { class: 'subhead', html: `${p.name} — ${p.pos} (${p.team}) • 0.00 pts` }));
    const cands = candidatesByPid[p.pid] || [];
    if (cands.length === 0) {
      container.append(el('div', { class: 'note', html: 'No same-position bench players available.' }));
      return;
    }
    const rows = cands.map(r => [r.name, r.pos, r.team, r.proj.toFixed(2)]);
    const wrap = el('div');
    renderSortableTable(wrap, ['Replacement','Pos','Team','Proj'], rows, ['str','str','str','num']);
    container.append(wrap);
  });
}

// ===== League roster positions display =====
function rosterPositionsSummary(league){
  const rp = (league.roster_positions || []).map(x => String(x).toUpperCase());
  const omit = new Set(['BN','TAXI','IR']);
  const counts = {};
  for (const slot of rp) { if (omit.has(slot)) continue; counts[slot] = (counts[slot] || 0) + 1; }
  const order = ['QB','RB','WR','TE','FLEX','SUPER_FLEX','K','DEF','DL','LB','DB'];
  const rest = Object.keys(counts).filter(k => !order.includes(k)).sort();
  const all = [...order.filter(k => counts[k]), ...rest];
  return all.map(k => `${k.replace('_',' ')}×${counts[k]}`).join(' • ');
}

// ===== UI utilities =====
function setWeekOptions(){ const wk=$('#weekSelect'); wk.innerHTML=''; for(let w=1; w<=18; w++){ const o=el('option',{value:String(w), html:'Week '+w}); if(w===1) o.selected=true; wk.append(o);} }
function showControls(){ $('#seasonGroup').classList.remove('hidden'); $('#weekGroup').classList.remove('hidden'); }
function resetMain(){
  $('#leagueViews').classList.add('hidden'); $('#userSummary').classList.add('hidden'); $('#contextNote').textContent=''; $('#posNote').textContent='';
  ['#rosterTable','#posTable','#matchupSummary','#myStarters','#oppStarters','#byeMatrix','#alertsView','#usRootForTable','#usRootAgainstTable','#usProjTable','#usByeMatrix'].forEach(s=>{ const n=$(s); if(n) n.innerHTML=''; });
}
function renderLeagueList(active=null){
  const list=$('#leagueList'); list.innerHTML=''; const ids=Object.keys(g.leagues);
  if(ids.length===0){ list.append(el('div',{class:'li-sub',html:'No leagues loaded yet.'})); return; }
  ids.forEach((id)=>{
    const {league,users,rosters}=g.leagues[id];
    const myRoster=rosters?.find?.(r=>r.owner_id===g.userId);
    const myUser=users?.find?.((u)=>u.user_id===myRoster?.owner_id) || {};
    const myTeamName=(myUser.metadata?.team_name) || myUser.display_name || `Team ${myRoster?.roster_id ?? ''}`;
    const rec = myRoster ? ' ' + rosterRecord(myRoster) : '';
    const item=el('div',{class:'league-item'+(id===active?' active':''), 'data-id':id},[
      el('div',{class:'li-info'},[
        el('div',{class:'li-title', html: league?.name || `League ${id}`}),
        el('div',{class:'li-sub',   html: (myTeamName || '') + rec })
      ]),
      el('span',{class:'alert-badge hidden', 'aria-label':'Alerts for this league', title:'Starters with 0 projected points'},'0')
    ]);
    item.addEventListener('click', async ()=>{
      g.mode='league'; g.selected=id;
      document.querySelectorAll('.league-item').forEach(n=>n.classList.remove('active'));
      item.classList.add('active'); $('#summaryItem').classList.remove('active');
      await renderSelectedLeague();
    });
    list.append(item);
  });
}

async function renderSelectedLeague(){
  const id=g.selected; if(!id) return; const {league,users,rosters}=g.leagues[id];
  const season=+league.season; const week=+($('#weekSelect').value||1);
  const myRoster=rosters.find(r=>r.owner_id===g.userId) || rosters[0];
  const myUser=users.find(u=>u.user_id===myRoster.owner_id)||{};
  const myTeamName=(myUser.metadata?.team_name)||myUser.display_name||`Team ${myRoster.roster_id}`;

  $('#contextNote').textContent = `${league.name} • ${league.season}`;
  $('#posNote').textContent = `Roster slots: ${rosterPositionsSummary(league)}`;

  renderRoster($('#rosterTable'), myRoster, g.players, season);

  const scoring=league.scoring_settings||{}; const proj=await projByPid(season, week, 'regular', g.players, scoring);
  const projFn=(pid)=>proj[String(pid)]||0;

  const vals=rosters.reduce((acc,r)=>{ acc[r.roster_id]=teamPosValues(league, rosterRows(r,g.players,projFn)); return acc; },{});
  const mine=vals[myRoster.roster_id];
  const posStats={}; for (const pos of ['QB','RB','WR','TE','FLEX','SUPER_FLEX']){ const list=rosters.map(r=>vals[r.roster_id][pos]||0); const my=list[rosters.findIndex(r=>r.roster_id===myRoster.roster_id)]; const {rank,out_of,pct}=rankPct(list,my); posStats[pos]={ my_value:+my.toFixed(2), rank, out_of, percentile:pct}; }
  renderPos($('#posTable'), posStats);

  const prev=await matchupPreview(league.league_id, week, league, users, rosters, g.players, projFn, myRoster.roster_id, myTeamName);
  renderMatchup($('#matchupSummary'), $('#myStarters'), $('#oppStarters'), prev);

  const matrixData = byeMatrixAcrossLeagues(g.leagues, g.userId, g.players, season);
  renderByeAcrossLeagues($('#byeMatrix'), matrixData);

  const startersSet = new Set(prev.myStart.map(p => p.pid));
  const allMyRows = rosterRows(myRoster, g.players, projFn);
  const flagged = prev.myStart.filter(p => (p.proj || 0) === 0);
  const candidatesByPid = {};
  for (const p of flagged) {
    const cands = allMyRows
      .filter(r => r.pos === p.pos && !startersSet.has(r.pid))
      .sort((a,b)=>b.proj - a.proj);
    candidatesByPid[p.pid] = cands;
  }
  renderAlerts($('#alertsView'), { flagged, candidatesByPid, week });

  const alertBtn = document.querySelector('#leagueTabs .tab-btn[data-tab="tab-alerts"]');
  if (alertBtn) {
    if (flagged.length > 0) alertBtn.classList.add('has-alert');
    else alertBtn.classList.remove('has-alert');
  }

  $('#userSummary').classList.add('hidden');
  $('#leagueViews').classList.remove('hidden');
}

// ===== Shared loader (landing + sidebar button) =====
async function loadForUsername(uname){
  resetMain();
  status('', 'Looking up your leagues…');
  try{
    if(!g.players) g.players = await loadPlayersMap();
    const uid = await resolveUserId(uname);
    if(!uid){ status('err', `Couldn’t find a Sleeper account for “${uname}”.`); return; }
    g.userId = uid;

    const season = $('#seasonMain').value || '2025';
    const leagues = await loadMyLeagues(uid, season);
    if(!Array.isArray(leagues) || leagues.length===0){
      status('err', `No leagues found in ${season}.`);
      $('#leagueList').innerHTML=''; return;
    }
    g.leagues = {};
    await Promise.all(leagues.map(async (L)=>{ g.leagues[L.league_id] = await loadLeagueBundle(L.league_id); }));
    setWeekOptions(); showControls();

    const sm=$('#summaryItem'); sm.classList.remove('hidden'); sm.classList.add('active');
    sm.onclick = async ()=>{ g.mode='summary'; g.selected=null; document.querySelectorAll('.league-item').forEach(n=>n.classList.remove('active')); sm.classList.add('active'); await renderUserSummary(); };

    renderLeagueList();
    g.mode='summary';
    await renderUserSummary();
    status('ok', `Loaded ${leagues.length} league(s).`);

    const week=+($('#weekSelect').value||1);
    await updateLeagueAlertBadges(week);

  }catch(err){
    console.error('[MFA] loadForUsername error', err);
    status('err','Failed to load leagues.');
  }
}

// ===== Events & init =====
function wireEvents(){
  $('#weekSelect').addEventListener('change', async ()=>{
    const week = +($('#weekSelect').value||1);
    if(g.mode==='summary') await renderUserSummary(); else await renderSelectedLeague();
    await updateLeagueAlertBadges(week);
  });

  $('#seasonMain').addEventListener('change', async ()=>{
    if(!g.userId) return; status('', 'Reloading leagues for selected season…');
    try{
      const season=$('#seasonMain').value;
      const leagues=await loadMyLeagues(g.userId, season);
      g.leagues={}; await Promise.all(leagues.map(async L=>{ g.leagues[L.league_id]=await loadLeagueBundle(L.league_id); }));
      status('ok', `Loaded ${leagues.length} league(s).`); renderLeagueList(); g.mode='summary'; $('#summaryItem').classList.add('active'); await renderUserSummary();

      const week = +($('#weekSelect').value||1);
      await updateLeagueAlertBadges(week);

    }catch(e){ console.error(e); status('err','Failed to reload for that season.'); }
  });

  $('#viewLeaguesBtn').addEventListener('click', async ()=>{
    const uname=$('#username').value.trim(); if(!uname){ status('err','Please enter a username.'); return; }
    await loadForUsername(uname);
  });

  $('#username').addEventListener('input', ()=>{ $('#viewLeaguesBtn').disabled = !$('#username').value.trim(); });
  $('#manualLeagueId').addEventListener('input', ()=>{ $('#addLeagueBtn').disabled = !$('#manualLeagueId').value.trim(); });
  $('#addLeagueBtn').addEventListener('click', async ()=>{
    const id=$('#manualLeagueId').value.trim(); if(!id) return;
    try{
      const b=await loadLeagueBundle(id); g.leagues[id]=b; renderLeagueList(g.selected);
      $('#manualLeagueId').value=''; $('#addLeagueBtn').disabled=true; status('ok','League added. Click it in the list.');
      const week = +($('#weekSelect').value||1);
      await updateLeagueAlertBadges(week);
    }
    catch(e){ console.error(e); status('err','Could not add that League ID.'); }
  });

  // Tabs (league + user summary)
  document.addEventListener('click', (e)=>{
    const btn1=e.target.closest('#leagueTabs .tab-btn');
    if(btn1){ document.querySelectorAll('#leagueTabs .tab-btn').forEach(x=>x.classList.remove('active')); btn1.classList.add('active');
      const id=btn1.dataset.tab; document.querySelectorAll('#leagueSections > section').forEach(s=>s.classList.toggle('active', s.id===id)); return; }
    const btn2=e.target.closest('#usTabs .tab-btn');
    if(btn2){ document.querySelectorAll('#usTabs .tab-btn').forEach(x=>x.classList.remove('active')); btn2.classList.add('active');
      const id=btn2.dataset.tab; document.querySelectorAll('#userSummary .sections > section').forEach(s=>s.classList.toggle('active', s.id===id)); return; }
  });

  // Landing
  const landingInput=$('#landingUsername'); const landingGo=$('#landingGo');
  landingInput.addEventListener('input', ()=>{ landingGo.disabled = !landingInput.value.trim(); });
  landingInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !landingGo.disabled) landingGo.click(); });
  landingGo.addEventListener('click', async ()=>{
    const uname=landingInput.value.trim(); if(!uname) return;
    $('#landing').classList.add('hidden'); $('#appLayout').classList.remove('hidden');
    $('#username').value = uname; $('#viewLeaguesBtn').disabled=false; await loadForUsername(uname);
  });
}

function init(){
  $('#appLayout').classList.add('hidden'); $('#landing').classList.remove('hidden');
  const wk=$('#weekSelect'); wk.innerHTML=''; for(let w=1; w<=18; w++){ const o=el('option',{value:String(w), html:'Week '+w}); if(w===1) o.selected=true; wk.append(o); }
  wireEvents();
  console.log('[MFA] ready');
}
window.addEventListener('DOMContentLoaded', init);
