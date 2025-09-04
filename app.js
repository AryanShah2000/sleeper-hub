// ===== App state =====
let g = { players: null, userId: null, leagues: {}, selected: null, mode: 'summary', waiverPref: null };

// Lightweight static schedule fallback (editable). Structure: STATIC_SCHEDULE[season][week] = [{away_team,home_team},...]
const STATIC_SCHEDULE = {
  '2025': {
    '1': [
      { away_team: 'DAL', home_team: 'PHI' },
      { away_team: 'KC',  home_team: 'BUF' },
      { away_team: 'GB',  home_team: 'MIN' },
      { away_team: 'TB',  home_team: 'NO'  },
      { away_team: 'NE',  home_team: 'NYJ' },
      { away_team: 'SF',  home_team: 'LAR' },
      { away_team: 'ARI', home_team: 'SEA' },
      { away_team: 'NYG', home_team: 'WAS' },
      { away_team: 'CIN', home_team: 'BAL' },
      { away_team: 'PIT', home_team: 'CLE' },
      { away_team: 'HOU', home_team: 'IND' },
      { away_team: 'TEN', home_team: 'JAX' },
      { away_team: 'MIA', home_team: 'CAR' },
      { away_team: 'LAC', home_team: 'DEN' },
      { away_team: 'DET', home_team: 'ATL' },
      { away_team: 'CHI', home_team: 'LV'  }
    ]
  }
};

// ensure weeks 1..18 exist for 2025 by duplicating week 1 if missing
if(!STATIC_SCHEDULE['2025']) STATIC_SCHEDULE['2025'] = {};
for(let w=1; w<=18; w++){ const wk=String(w); if(!STATIC_SCHEDULE['2025'][wk]) STATIC_SCHEDULE['2025'][wk] = STATIC_SCHEDULE['2025']['1']; }

// Team abbreviation normalization map (maps variants to standard codes used in g.players)
const TEAM_ABBREV_NORMALIZE = {
  'JAC':'JAX','JAC.':'JAX','WAS':'WAS','WSH':'WAS','LAR':'LAR','LA':'LAR','STL':'LAR','SF':'SF','SFO':'SF',
  'KC':'KC','KAN':'KC','NE':'NE','NWE':'NE','NYG':'NYG','NYJ':'NYJ','NYJ':'NYJ','GB':'GB','GNB':'GB',
  'TB':'TB','TBB':'TB','NO':'NO','NOR':'NO','DAL':'DAL','DAL.':'DAL','PHI':'PHI','PHI.':'PHI',
  'BUF':'BUF','BUF.':'BUF','CIN':'CIN','CIN.':'CIN','BAL':'BAL','BAL.':'BAL','PIT':'PIT','PIT.':'PIT',
  'CLE':'CLE','CLE.':'CLE','HOU':'HOU','HOU.':'HOU','IND':'IND','IND.':'IND','TEN':'TEN','TEN.':'TEN',
  'JAX':'JAX','MIA':'MIA','MIA.':'MIA','CAR':'CAR','CAR.':'CAR','LAC':'LAC','LAC.':'LAC','DEN':'DEN','DEN.':'DEN',
  'DET':'DET','DET.':'DET','ATL':'ATL','ATL.':'ATL','CHI':'CHI','CHI.':'CHI','LV':'LV','LVR':'LV','ARI':'ARI','ARI.':'ARI','SEA':'SEA','SEA.':'SEA'
};
function normalizeTeam(abbr){ if(!abbr) return abbr; const a = String(abbr).toUpperCase(); return TEAM_ABBREV_NORMALIZE[a] || a; }

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

// Small HTML escaper for safe insertion into innerHTML when needed
function escapeHtml(s){
  if(s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

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
  let pos = (meta.position || 'UNK').toUpperCase();
  if (pos === 'D/ST' || pos === 'DST') pos = 'DEF';

  const row = rowsByPid[pid];
  if (pos === 'K' || pos === 'DEF') {
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
    let pos = (m.position||'UNK').toUpperCase();
    if (pos === 'D/ST' || pos === 'DST') pos = 'DEF';
    return { pid, name, pos, team: m.team||'FA', proj: projFn ? +projFn(pid)||0 : null, bye: m.bye_week };
  });
}
function selectBest(rows, set, k) {
  const pool = rows.filter((r)=>set.has(r.pos)).sort((a,b)=>b.proj-a.proj);
  const picks = pool.slice(0,k); const ids = new Set(picks.map((p)=>p.pid));
  return { picks, remaining: rows.filter((r)=>!ids.has(r.pid)) };
}
function teamPosValues(league, rows) {
  const rp = (league.roster_positions||[]).map((x)=>String(x).toUpperCase());
  const count = (slot) => rp.filter(x=>x===slot).length;

  const PURE_KEYS = ['QB','RB','WR','TE','K','DEF'].filter(k => count(k)>0);
  const PURE = Object.fromEntries(PURE_KEYS.map(k => [k, count(k)]));

  const FLEX = count('FLEX');
  const SFLEX = count('SUPER_FLEX');

  let remaining = rows.slice(), values = {};
  for (const [pos,k] of Object.entries(PURE)) {
    const { picks, remaining: rem } = selectBest(remaining, new Set([pos]), k);
    remaining = rem; values[pos] = picks.reduce((s,p)=>s+p.proj,0);
  }
  if (FLEX){ const { picks, remaining: rem } = selectBest(remaining, new Set(['RB','WR','TE']), FLEX); remaining=rem; values.FLEX=picks.reduce((s,p)=>s+p.proj,0);} else values.FLEX=undefined;
  if (SFLEX){ const { picks, remaining: rem } = selectBest(remaining, new Set(['QB','RB','WR','TE','K','DEF']), SFLEX); remaining=rem; values.SUPER_FLEX=picks.reduce((s,p)=>s+p.proj,0);} else values.SUPER_FLEX=undefined;

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
  // parse supports raw values or display objects {v: value, d: display, ttip: '...'}
  const parse=(v,t)=>{
    const raw = (v && typeof v === 'object' && v.v !== undefined) ? v.v : v;
    if(t==='num') return (Number.isNaN(+raw)?null:+raw);
    if(t==='bye') return (raw&&String(raw).startsWith('W')?+String(raw).slice(1):Number.isNaN(+raw)?null:+raw);
    return String(raw||'');
  };
  const cmp=(a,b,t,d)=>{const mul=d==='asc'?1:-1; if(t==='str') return mul*String(a).localeCompare(String(b)); if(a==null&&b==null) return 0; if(a==null) return 1; if(b==null) return -1; return mul*(a-b);};
  function head(){ const tr=el('tr'); headers.forEach((h,i)=>{ const th=el('th'); th.classList.add('sortable'); th.append(el('span',{html:h}), el('span',{class:'arrow',html:''}));
    th.addEventListener('click',()=>{ if(sortCol===i) sortDir=sortDir==='asc'?'desc':'asc'; else{sortCol=i; sortDir='desc';} body(); arrows(); }); tr.append(th);});
    thead.innerHTML=''; thead.append(tr);
  }
  function arrows(){ thead.querySelectorAll('th').forEach((th,i)=>{ th.classList.remove('sorted-asc','sorted-desc'); const a=th.querySelector('.arrow'); if(!a) return;
    if(i===sortCol){ th.classList.add(sortDir==='asc'?'sorted-asc':'sorted-desc'); a.textContent=sortDir==='asc'?'▲':'▼'; } else a.textContent=''; });}
  function body(){ const t=rows.map(r=>({raw:r,key:r.map((c,idx)=>parse(c,types[idx]))})); if(sortCol>=0) t.sort((ra,rb)=>cmp(ra.key[sortCol],rb.key[sortCol],types[sortCol],sortDir));
    tbody.innerHTML=''; t.forEach(r=>{
      const tr = el('tr');
      r.raw.forEach((c,ci)=>{
        // if cell is an object with d=display and ttip, render span with data-tooltip
        if(c && typeof c === 'object' && c.d !== undefined){
          const td = el('td');
          const span = el('span',{html:String(c.d)});
          if(c.ttip) span.setAttribute('data-tooltip', String(c.ttip));
          td.append(span); tr.append(td);
        } else {
          tr.append(el('td',{html:String(c)}));
        }
      });
      tbody.append(tr);
    });
  }
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
function renderPos(container, posStats, order){
  const rows=[];
  for (const pos of order){ const s=posStats[pos]; if(s==null) continue; rows.push([pos.replace('_',' '), (s.my_value||0).toFixed(2), `${s.rank} / ${s.out_of}`, `${s.percentile}%`]); }
  renderTable(container, ['Pos','Points','Rank','Percentile'], rows);
}
function renderMatchup(sumDiv, myDiv, oppDiv, p){
  // Clear containers
  if(sumDiv) sumDiv.innerHTML=''; if(myDiv) myDiv.innerHTML=''; if(oppDiv) oppDiv.innerHTML='';
  const leftName = p.me.team_name || 'Me';
  const rightName = p.opponent.team_name || 'Opponent';
  const leftProj = (Number(p.me.projected_total)||0).toFixed(2);
  const rightProj = (Number(p.opponent.projected_total)||0).toFixed(2);
  const leftCur = (Number(p.me.current_total)||0).toFixed(2);
  const rightCur = (Number(p.opponent.current_total)||0).toFixed(2);

  // compact scoreboard at top (smaller)
  const scoreBox = el('div',{class:'scorebox-small'},[
    el('div',{class:'sb-teams'}, [ el('div',{class:'sb-left', html:leftName}), el('div',{class:'sb-spacer', html:' ' }), el('div',{class:'sb-right', html:rightName}) ]),
    el('div',{class:'sb-scores'}, [ el('div',{class:'sb-left-score', html:leftCur}), el('div',{class:'sb-vs', html:'vs'}), el('div',{class:'sb-right-score', html:rightCur}) ]),
    el('div',{class:'sb-proj', html:`<em>Projected: ${leftProj} — ${rightProj}</em>`})
  ]);
  sumDiv.append(scoreBox);

  // Build matchup table: use the starter order from Sleeper (array order)
  const tbl = document.createElement('table'); tbl.className='matchup-table';
  const thead = el('thead'); thead.append(el('tr',{}, [ el('th',{html:''}), el('th',{html:'Proj'}), el('th',{html:'Proj'}), el('th',{html:''}) ]));
  tbl.append(thead);
  const tbody = el('tbody');

  const leftList = p.myStart || [];
  const rightList = p.oppStart || [];
  const maxLen = Math.max(leftList.length, rightList.length);
  // Precompute starter proj arrays by position and map pid->starter minimal proj for lookups
  const leftStartersByPos = {};
  const rightStartersByPos = {};
  const leftStarterMinByPos = {};
  const rightStarterMinByPos = {};
  const leftStarterByPid = {};
  const rightStarterByPid = {};
  (leftList||[]).forEach(s=>{ const pos=(s.pos||'UNK').toUpperCase(); leftStartersByPos[pos]=leftStartersByPos[pos]||[]; leftStartersByPos[pos].push(+s.proj||0); leftStarterByPid[String(s.pid)]=s; });
  (rightList||[]).forEach(s=>{ const pos=(s.pos||'UNK').toUpperCase(); rightStartersByPos[pos]=rightStartersByPos[pos]||[]; rightStartersByPos[pos].push(+s.proj||0); rightStarterByPid[String(s.pid)]=s; });
  Object.entries(leftStartersByPos).forEach(([pos,arr])=>{ leftStarterMinByPos[pos]=arr.length?Math.min(...arr):null; });
  Object.entries(rightStartersByPos).forEach(([pos,arr])=>{ rightStarterMinByPos[pos]=arr.length?Math.min(...arr):null; });
  for(let i=0;i<maxLen;i++){
    const L = leftList[i] || null;
    const R = rightList[i] || null;
    const leftCell = el('td');
    if(L){
      // determine if this starter should show a dot: red if proj === 0 or starter missing, yellow if any bench of same pos projects to outscore this starter
      const Lpid = String(L.pid);
      const Lpos = (L.pos||'UNK').toUpperCase();
      const LprojVal = Number(L.proj||0);
      const Lred = (LprojVal === 0);
      // find any bench in myBench that has higher proj than this starter
      const Lyellow = (p.myBench || []).some(b => ((b.pos||'UNK').toUpperCase() === Lpos) && (Number(b.proj||0) > LprojVal));
  // compose dot HTML: red takes visual priority but show both in matchup view
  let dots = '';
  if (Lred) dots += `<span class="starter-dot dot-red" title="Starter projected 0 pts"></span>`;
  if (Lyellow) dots += `<span class="starter-dot dot-yellow" title="Bench projects to outscore this starter"></span>`;
  leftCell.append(el('div',{}, [ el('div',{class:'player-name', html: escapeHtml(L.name) + dots}), el('div',{class:'player-meta', html: `${L.pos} • ${L.team}`}) ]));
    }
    const rightCell = el('td');
    if(R){
      const Rpid = String(R.pid);
      const Rpos = (R.pos||'UNK').toUpperCase();
      const RprojVal = Number(R.proj||0);
      const Rred = (RprojVal === 0);
      const Ryellow = (p.oppBench || []).some(b => ((b.pos||'UNK').toUpperCase() === Rpos) && (Number(b.proj||0) > RprojVal));
  let dotsR = '';
  if (Rred) dotsR += `<span class="starter-dot dot-red" title="Starter projected 0 pts"></span>`;
  if (Ryellow) dotsR += `<span class="starter-dot dot-yellow" title="Bench projects to outscore this starter"></span>`;
  rightCell.append(el('div',{}, [ el('div',{class:'player-name', html: escapeHtml(R.name) + dotsR}), el('div',{class:'player-meta', html: `${R.pos} • ${R.team}`}) ]));
    }
    const lcur = L ? (Number(L.current||0).toFixed(2)) : '';
    const rcur = R ? (Number(R.current||0).toFixed(2)) : '';
    const lproj = L ? (Number(L.proj||0).toFixed(2)) : '';
    const rproj = R ? (Number(R.proj||0).toFixed(2)) : '';
    const leftScoreTd = el('td'); leftScoreTd.append(el('div',{class:'player-score-box'}, [ el('div',{class:'ps-current', html: lcur}), el('div',{class:'ps-proj', html: lproj}) ]));
    const rightScoreTd = el('td'); rightScoreTd.append(el('div',{class:'player-score-box'}, [ el('div',{class:'ps-current', html: rcur}), el('div',{class:'ps-proj', html: rproj}) ]));
    const tr = el('tr',{}, [ leftCell, leftScoreTd, rightScoreTd, rightCell ]);
    tbody.append(tr);
  }

  // benches: render each bench player row the same way as starters but greyed
  if((p.myBench && p.myBench.length>0) || (p.oppBench && p.oppBench.length>0)){
    const leftBench = p.myBench || [];
    const rightBench = p.oppBench || [];
    // build starter proj arrays by position for comparisons
    const leftStarterProjByPos = {};
    const rightStarterProjByPos = {};
    (p.myStart||[]).forEach(s=>{ const pos=(s.pos||'UNK').toUpperCase(); leftStarterProjByPos[pos]=leftStarterProjByPos[pos]||[]; leftStarterProjByPos[pos].push(+s.proj||0); });
    (p.oppStart||[]).forEach(s=>{ const pos=(s.pos||'UNK').toUpperCase(); rightStarterProjByPos[pos]=rightStarterProjByPos[pos]||[]; rightStarterProjByPos[pos].push(+s.proj||0); });

    const bMax = Math.max(leftBench.length, rightBench.length);
    for(let i=0;i<bMax;i++){
      const L = leftBench[i] || null;
      const R = rightBench[i] || null;
      const leftCell = el('td');
      if(L){
        const pos = (L.pos||'UNK').toUpperCase();
        const sArr = leftStarterProjByPos[pos] || [];
        const minStarter = sArr.length? Math.min(...sArr) : null;
        const showDot = (minStarter !== null) && (Number(L.proj||0) > Number(minStarter||0));
        const nameHtml = escapeHtml(L.name) + (showDot? ' <span class="bench-dot dot-yellow" title="Bench projects to outscore starter"></span>' : '');
        leftCell.append(el('div',{}, [ el('div',{class:'player-name', html: nameHtml}), el('div',{class:'player-meta', html: `${L.pos} • ${L.team}`}) ]));
      }
      const rightCell = el('td');
      if(R){
        const pos = (R.pos||'UNK').toUpperCase();
        const sArr = rightStarterProjByPos[pos] || [];
        const minStarter = sArr.length? Math.min(...sArr) : null;
        const showDot = (minStarter !== null) && (Number(R.proj||0) > Number(minStarter||0));
        const nameHtml = escapeHtml(R.name) + (showDot? ' <span class="bench-dot dot-yellow" title="Bench projects to outscore starter"></span>' : '');
        rightCell.append(el('div',{}, [ el('div',{class:'player-name', html: nameHtml}), el('div',{class:'player-meta', html: `${R.pos} • ${R.team}`}) ]));
      }
      const lcur = L ? (Number(L.current||0).toFixed(2)) : '';
      const rcur = R ? (Number(R.current||0).toFixed(2)) : '';
      const lproj = L ? (Number(L.proj||0).toFixed(2)) : '';
      const rproj = R ? (Number(R.proj||0).toFixed(2)) : '';
      const leftScoreTd = el('td'); leftScoreTd.append(el('div',{class:'player-score-box'}, [ el('div',{class:'ps-current', html: lcur}), el('div',{class:'ps-proj', html: lproj}) ]));
      const rightScoreTd = el('td'); rightScoreTd.append(el('div',{class:'player-score-box'}, [ el('div',{class:'ps-current', html: rcur}), el('div',{class:'ps-proj', html: rproj}) ]));
      const tr = el('tr',{}, [ leftCell, leftScoreTd, rightScoreTd, rightCell ]);
      tr.classList.add('bench'); tbody.append(tr);
    }
  }

  tbl.append(tbody);
  sumDiv.append(tbl);
}
async function matchupPreview(leagueId, week, league, users, rosters, players, projFn, myRid, myTeam){
  let matchups=[]; try{ matchups = await fetchJSON(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`);}catch{}
  const byRid = new Map(matchups.filter(m=>m&&typeof m==='object').map(m=>[m.roster_id,m]));
  const myM = byRid.get(myRid);
  const userById = Object.fromEntries(users.map(u=>[u.user_id,u]));
  const rosterById = Object.fromEntries(rosters.map(r=>[r.roster_id,r]));
  const teamName = (rid)=>{ const r=rosterById[rid]||{}; const u=userById[r.owner_id]||{}; return (u.metadata?.team_name)||u.display_name||(rid?`Team ${rid}`:null); };
  const starters = (rid)=>{ const m=byRid.get(rid)||{}; const r=rosterById[rid]||{}; return (m.starters||r.starters||[]).filter(pid=>pid!=='0'); };
  // starters with projections and best-effort current points (from matchup payloads)
  const startersProj = (rid)=> starters(rid).map(pid=>{
    const m = players[pid]||{};
    const name = m.full_name || (m.first_name && m.last_name ? `${m.first_name} ${m.last_name}` : (m.last_name || 'Unknown'));
    const mm = byRid.get(rid) || {};
    let cur = 0;
    if (mm?.players_points && mm.players_points[pid] != null) cur = Number(mm.players_points[pid]) || 0;
    else if (mm?.player_points && mm.player_points[pid] != null) cur = Number(mm.player_points[pid]) || 0;
    else if (mm?.points && typeof mm.points === 'object' && mm.points[pid] != null) cur = Number(mm.points[pid]) || 0;
    return { pid, name, pos:(m.position||'UNK').toUpperCase(), team:m.team||'FA', proj:+projFn(pid)||0, current: cur };
  });
  const bench = (rid)=>{ const m=byRid.get(rid)||{}; const r=rosterById[rid]||{}; const all = (m.players||r.players||[]).filter(pid=>pid!=='0'); const s = new Set(starters(rid)); return all.filter(pid=>!s.has(pid)); };
  const benchProj = (rid)=> bench(rid).map(pid=>{ const m=players[pid]||{}; const name=m.full_name||(m.first_name&&m.last_name?`${m.first_name} ${m.last_name}`:(m.last_name||'Unknown')); const mm = byRid.get(rid)||{}; let cur = 0; if(mm?.players_points && mm.players_points[pid] != null) cur = Number(mm.players_points[pid])||0; else if(mm?.player_points && mm.player_points[pid] != null) cur = Number(mm.player_points[pid])||0; else if(mm?.points && typeof mm.points === 'object' && mm.points[pid] != null) cur = Number(mm.points[pid])||0; return { pid, name, pos:(m.position||'UNK').toUpperCase(), team:m.team||'FA', proj:+projFn(pid)||0, current: cur }; });
  let oppRid = null; if (myM){ const mid=myM.matchup_id; const opp = matchups.find(m=>m.matchup_id===mid && m.roster_id!==myRid); oppRid = opp?.roster_id ?? null; }
  const myStart = startersProj(myRid); const oppStart = oppRid ? startersProj(oppRid) : [];
  const myBench = benchProj(myRid);
  const oppBench = oppRid ? benchProj(oppRid) : [];
  const getPoints = (rid)=>{ const m=byRid.get(rid)||{}; return Number(m?.points ?? m?.points_total ?? m?.team_points ?? m?.score ?? m?.total ?? 0) || 0; };
  const myCurrent = getPoints(myRid);
  const oppCurrent = getPoints(oppRid);
  return {
    week,
    me: { team_name: myTeam, projected_total: +myStart.reduce((s,p)=>s+p.proj,0).toFixed(2), current_total: myCurrent },
    opponent: { team_name: teamName(oppRid), projected_total: +oppStart.reduce((s,p)=>s+p.proj,0).toFixed(2), current_total: oppCurrent },
    myStart, oppStart, myBench, oppBench
  };
}

// ===== Bye matrices =====
  
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
// Return Map<pid, Array<leagueName>> for leagues where the user has the player
function ownedExposureLeagues(leagues, userId){
  const m = new Map();
  for (const entry of Object.values(leagues)){
    const { league, rosters } = entry;
    const my = rosters.find(r => r.owner_id === userId);
    if(!my) continue;
    const pids = new Set([...(my.players||[]), ...(my.starters||[]), ...(my.taxi||[])]);
    pids.delete('0');
    for(const pid of pids){ const key=String(pid); const arr = m.get(key) || []; arr.push(league?.name || league?.league_id || 'League'); m.set(key, arr); }
  }
  return m;
}
async function opponentExposuresAcrossLeagues(leagues, userId, week) {
  const counter = new Map();
  await Promise.all(Object.values(leagues).map(async ({ league, users, rosters }) => {
    const my = rosters.find(r => r.owner_id === userId);
    if (!my) return;
    let matchups = [];
    try { matchups = await fetchJSON(`https://api.sleeper.app/v1/league/${league.league_id}/matchups/${week}`); } catch {}

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

// Return Map<pid, Array<leagueName>> for opponent starters across leagues where user has a roster
async function opponentExposureLeagues(leagues, userId, week){
  const m = new Map();
  await Promise.all(Object.values(leagues).map(async ({ league, users, rosters }) => {
    const my = rosters.find(r => r.owner_id === userId);
    if (!my) return;
    let matchups = [];
    try { matchups = await fetchJSON(`https://api.sleeper.app/v1/league/${league.league_id}/matchups/${week}`); } catch {}

    const byRid = new Map((matchups || []).filter(mk => mk && typeof mk === 'object').map(mk => [mk.roster_id, mk]));
    const myM = byRid.get(my.roster_id);
    let oppRid = null;
    if (myM) {
      const mid = myM.matchup_id;
      const opp = (matchups || []).find(mk => mk.matchup_id === mid && mk.roster_id !== my.roster_id);
      oppRid = opp?.roster_id ?? null;
    }
    if (!oppRid) return;

    const rosterById = Object.fromEntries(rosters.map(r => [r.roster_id, r]));
    const oppMatch = byRid.get(oppRid) || {};
    const oppRoster = rosterById[oppRid] || {};
    const starters = (oppMatch.starters || oppRoster.starters || []).filter(pid => pid !== '0');
    for (const pid of starters) {
      const key = String(pid);
      const arr = m.get(key) || [];
      arr.push(league?.name || league?.league_id || 'League');
      m.set(key, arr);
    }
  }));
  return m;
}

// Build a bye matrix aggregated across the user's leagues.
// Returns { weeks: [1..18], rows: [ { rosterName, weekMap: {week: [playerNames...] } } ] }
function byeMatrixAcrossLeagues(leagues, userId, players, season){
  const weeks = Array.from({length:18},(_,i)=>i+1);
  const rows = [];
  for(const entry of Object.values(leagues||{})){
    const { league, rosters, users } = entry;
    const my = rosters.find(r=>r.owner_id===userId);
    if(!my) continue;
    const user = users.find(u=>u.user_id===my.owner_id) || {};
    const rosterName = user.metadata?.team_name || user.display_name || `Team ${my.roster_id}`;
    const rr = rosterRows(my, players);
    const weekMap = Object.fromEntries(weeks.map(w=>[w,[]]));
    for(const r of rr){
      let bye = teamBye(r.team, season);
      if(!(Number.isInteger(bye)&&bye>=1&&bye<=18)) bye = Number.isInteger(r.bye)?r.bye:null;
      if(Number.isInteger(bye) && weekMap[bye]) weekMap[bye].push(r.name);
    }
    rows.push({ rosterName, weekMap });
  }
  return { weeks, rows };
}

// Render the cross-league bye matrix into a container
function renderByeAcrossLeagues(container, data){
  if(!container) return;
  if(!data || !Array.isArray(data.rows) || data.rows.length===0){ container.innerHTML = '<div class="note">No bye data available.</div>'; return; }
  const weeks = data.weeks || Array.from({length:18},(_,i)=>i+1);
  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr'); headRow.append(el('th',{html:'Team'})); for(const w of weeks) headRow.append(el('th',{html:'W'+w})); thead.append(headRow);
  const tbody = el('tbody');
  for(const row of data.rows){
    const tr = el('tr'); tr.append(el('td',{html:row.rosterName}));
    for(const w of weeks){
      const names = row.weekMap[w]||[];
      const span = el('span',{html: names.length>0?String(names.length):'—'});
      if(names.length>0) span.setAttribute('data-tooltip', names.join('\n'));
      const cell = el('td'); cell.append(span); tr.append(cell);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody); container.innerHTML=''; container.append(table);
}

// Build a bye matrix for a single roster, grouped by position.
// Returns { weeks: [1..18], positions: [pos], data: { pos -> { week -> [names] } } }
function byeMatrixByPosition(roster, players, season, league){
  const weeks = Array.from({length:18},(_,i)=>i+1);
  const rows = rosterRows(roster, players);
  const posMap = {};
  for(const r of rows){
    const pos = (r.pos||'UNK').toUpperCase(); if(!posMap[pos]) posMap[pos] = {};
    let bye = teamBye(r.team, season);
    if(!(Number.isInteger(bye)&&bye>=1&&bye<=18)) bye = Number.isInteger(r.bye)?r.bye:null;
    const wk = Number.isInteger(bye)?bye:null;
    if(wk){ posMap[pos][wk] = posMap[pos][wk] || []; posMap[pos][wk].push(r.name); }
  }
  const positions = Object.keys(posMap).sort();
  return { weeks, positions, data: posMap };
}

// Render bye-by-position table for a league
function renderByePositions(container, byeData){
  if(!container) return;
  if(!byeData || !byeData.positions || byeData.positions.length===0){ container.innerHTML = '<div class="note">No bye-by-position data to show.</div>'; return; }
  const weeks = byeData.weeks || Array.from({length:18},(_,i)=>i+1);
  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr'); headRow.append(el('th',{html:'Pos'})); for(const w of weeks) headRow.append(el('th',{html:'W'+w})); thead.append(headRow);
  const tbody = el('tbody');
  for(const pos of byeData.positions){
    const tr = el('tr'); tr.append(el('td',{html:pos}));
    for(const w of weeks){
      const names = (byeData.data[pos] && byeData.data[pos][w]) || [];
      const span = el('span',{html: names.length>0?String(names.length):'—'});
      if(names.length>0) span.setAttribute('data-tooltip', names.join('\n'));
      const cell = el('td'); cell.append(span); tr.append(cell);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody); container.innerHTML=''; container.append(table);
}

async function renderUserSummary(){
  $('#leagueViews').classList.add('hidden'); $('#userSummary').classList.remove('hidden'); $('#contextNote').textContent=''; $('#posNote').textContent='';

  const week=+($('#weekSelect').value||1); const seasonSel=+($('#seasonMain').value||2025);

  // render rooting interest tables (unfiltered)
  await renderRootingInterestTables(week);

  // Projections (arrow only on higher score)
  // projections tab removed — no-op

  // Cross-league season bye matrix
  const matrixData = byeMatrixAcrossLeagues(g.leagues, g.userId, g.players, seasonSel);
  renderByeAcrossLeagues($('#usByeMatrix'), matrixData);
  // Matchup overview cards
  await renderUserMatchups(week, seasonSel);

  // wire up game filter for Rooting Interest
  wireGameFilter(week);
}

// Render the Rooting Interest tables (Root For / Root Against).
// If filterTeams is an array of team codes (normalized), only include players from those teams.
async function renderRootingInterestTables(week, filterTeams=null){
  try{
    const haveMap = ownedExposuresAcrossLeagues(g.leagues, g.userId);
    const vsMap   = await opponentExposuresAcrossLeagues(g.leagues, g.userId, week);
    const haveListMap = ownedExposureLeagues(g.leagues, g.userId);
    const oppListMap = await opponentExposureLeagues(g.leagues, g.userId, week);

    const fset = (Array.isArray(filterTeams) && filterTeams.length>0) ? new Set(filterTeams.map(t=>normalizeTeam(t))) : null;

    // build a set of candidate pids (union of exposures)
    const candidate = new Set([...(haveMap.keys?.() || []), ...(vsMap.keys?.() || [])]);
    // also include any players from filtered teams (in case exposures maps miss them)
    if(fset){
      for(const [pid,m] of Object.entries(g.players||{})){
        const team = normalizeTeam(m.team||'');
        if(fset.has(team)) candidate.add(String(pid));
      }
    }

    const rowsFor = [];
    const rowsAgainst = [];
    for(const pid of candidate){
      const m = g.players[String(pid)] || {};
      const name = m.full_name || (m.first_name && m.last_name ? `${m.first_name} ${m.last_name}` : (m.last_name || 'Unknown'));
      const pos = (m.position || 'UNK').toUpperCase();
      const team = normalizeTeam(m.team || 'FA');
      if(fset && !fset.has(team)) continue;
      const haveCount = haveMap.get ? (haveMap.get(pid) || 0) : 0;
      const vsCount = vsMap.get ? (vsMap.get(pid) || 0) : 0;
      const haveLeagues = haveListMap.get(String(pid)) || [];
      const oppLeagues = oppListMap.get(String(pid)) || [];
      const needFor = fset ? 1 : 2;
      const needAgainst = fset ? 1 : 2;
      if(haveCount >= needFor){ rowsFor.push([name, pos, team, {v:haveCount, d:haveCount, ttip: haveLeagues.join('\n')}, {v:vsCount, d:vsCount, ttip: oppLeagues.join('\n')}]); }
      if(vsCount >= needAgainst){ rowsAgainst.push([name, pos, team, {v:vsCount,d:vsCount, ttip: oppLeagues.join('\n')}, {v:haveCount,d:haveCount, ttip: haveLeagues.join('\n')}]); }
    }

    rowsFor.sort((a, b) => (b[3].v||0) - (a[3].v||0) || a[0].localeCompare(b[0]));
    if (rowsFor.length === 0) {
      $('#usRootForTable').innerHTML = '<div class="note">No players with exposures meeting the threshold.</div>';
    } else {
      renderSortableTable($('#usRootForTable'), ['Player','Pos','Team','For','Against'], rowsFor, ['str','str','str','num','num']);
    }

    rowsAgainst.sort((a, b) => (b[3].v||0) - (a[3].v||0) || a[0].localeCompare(b[0]));
    if (rowsAgainst.length === 0) {
      $('#usRootAgainstTable').innerHTML = '<div class="note">No opponents with exposures meeting the threshold this week.</div>';
    } else {
      renderSortableTable($('#usRootAgainstTable'), ['Player','Pos','Team','Against','For'], rowsAgainst, ['str','str','str','num','num']);
    }
  }catch(e){ console.warn('renderRootingInterestTables failed', e); }
}

// Try to fetch schedule for a week from Sleeper. Fallback to a minimal mapping if unavailable.
async function fetchWeekGames(week, season=+($('#seasonMain').value||2025)){
  // Prefer ESPN scoreboard API for a reliable public NFL schedule
  try{
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${encodeURIComponent(week)}&season=${encodeURIComponent(season)}`;
    const data = await fetchJSON(url);
    const events = data?.events || [];
    const out = [];
    for(const ev of events){
      const comps = ev?.competitions || [];
      if(!comps[0]) continue;
      const comp = comps[0];
      const compsTeams = comp.competitors || [];
      const away = compsTeams.find(c=>c.homeAway==='away');
      const home = compsTeams.find(c=>c.homeAway==='home');
      const awayAb = away?.team?.abbreviation || away?.team?.shortDisplayName || null;
      const homeAb = home?.team?.abbreviation || home?.team?.shortDisplayName || null;
      if(awayAb && homeAb){ out.push({ away_team: awayAb.toUpperCase(), home_team: homeAb.toUpperCase(), label: `${awayAb.toUpperCase()} @ ${homeAb.toUpperCase()}` }); }
    }
    if(out.length>0) return out;
  }catch(e){ console.warn('ESPN schedule fetch failed', e); }

  // If direct ESPN fetch failed (CORS or network), try via a public CORS proxy
  try{
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${encodeURIComponent(week)}&season=${encodeURIComponent(season)}`;
    const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
    const data = await fetchJSON(proxy);
    const events = data?.events || [];
    const out = [];
    for(const ev of events){
      const comps = ev?.competitions || [];
      if(!comps[0]) continue;
      const comp = comps[0];
      const compsTeams = comp.competitors || [];
      const away = compsTeams.find(c=>c.homeAway==='away');
      const home = compsTeams.find(c=>c.homeAway==='home');
      const awayAb = away?.team?.abbreviation || away?.team?.shortDisplayName || null;
      const homeAb = home?.team?.abbreviation || home?.team?.shortDisplayName || null;
      if(awayAb && homeAb){ out.push({ away_team: awayAb.toUpperCase(), home_team: homeAb.toUpperCase(), label: `${awayAb.toUpperCase()} @ ${homeAb.toUpperCase()}` }); }
    }
    if(out.length>0) return out;
  }catch(e){ console.warn('ESPN proxy schedule fetch failed', e); }

  // fallback: try Sleeper schedule endpoint (best-effort)
  try{
    const games = await fetchJSON(`https://api.sleeper.app/v1/league/nfl/schedule/${season}`);
    if(Array.isArray(games)) return games.filter(g=>Number(g.week)===Number(week));
    if(typeof games==='object'){ const arr = Object.values(games).flat(); return arr.filter(g=>Number(g.week)===Number(week)); }
  }catch(e){ console.warn('Sleeper schedule fetch failed', e); }
  // Final fallback: STATIC_SCHEDULE embedded in the app
  try{
    const s = String(season);
    const w = String(week);
    const arr = (STATIC_SCHEDULE[s] && STATIC_SCHEDULE[s][w]) || null;
    if(Array.isArray(arr) && arr.length>0){
      return arr.map(it=>({ away_team: it.away_team.toUpperCase(), home_team: it.home_team.toUpperCase(), label: `${it.away_team.toUpperCase()} @ ${it.home_team.toUpperCase()}` }));
    }
  }catch(e){}

  return [];
}

function wireGameFilter(week){
  // if week not provided, read from top-level week selector
  const wk = (typeof week === 'number' && week) ? week : +($('#weekSelect')?.value || 1);
  const sel = $('#usGameSelect'); const btn = $('#usLoadGames'); const playersWrap = $('#usGamePlayers');
  if(!sel || !btn || !playersWrap) return;
  sel.innerHTML = '<option value="">All games (select week)</option>';
  const doLoadGames = async ()=>{
    btn.disabled = true; btn.textContent='Loading…';
    try{
  const games = await fetchWeekGames(wk);
      sel.innerHTML = '<option value="">Select a game…</option>';
      if(Array.isArray(games) && games.length>0){
        for(const g of games){
          // normalize team codes when storing in option value so comparisons match g.players
          const awayCode = normalizeTeam(g.away_team);
          const homeCode = normalizeTeam(g.home_team);
          const id = awayCode && homeCode ? `${awayCode}-${homeCode}` : (g.game_id||JSON.stringify(g));
          const label = g.away_team && g.home_team ? `${g.away_team} @ ${g.home_team}` : (g.title||id);
          const o = el('option',{value:id, html: label}); sel.append(o);
        }
      } else {
        // No NFL schedule from ESPN or Sleeper for this week — offer an opt-in to load fantasy matchups
        sel.innerHTML = '';
        sel.append(el('option',{value:'', html: 'No NFL games found for this week'}));
        const info = el('div',{class:'note', html: 'NFL schedule not available. You can optionally load fantasy matchups from your leagues instead (explicit).'});
        const btnWrap = el('div',{},[
          el('button',{type:'button', id:'usShowFantasy', style:'margin-top:8px;padding:6px 10px'}, 'Show fantasy matchups')
        ]);
        // place the info + button below dropdown
        playersWrap.parentNode.insertBefore(info, playersWrap);
        playersWrap.parentNode.insertBefore(btnWrap, playersWrap);
        const fantasyLoader = async ()=>{
          // remove helper nodes
          info.remove(); btnWrap.remove();
          // aggregate matchups from the user's leagues for this week
          const seen = new Set();
          const pairs = [];
          await Promise.all(Object.values(g.leagues).map(async (entry)=>{
            try{
              const m = await fetchJSON(`https://api.sleeper.app/v1/league/${entry.league.league_id}/matchups/${wk}`);
              if(!Array.isArray(m)) return;
              const rosterById = Object.fromEntries((entry.rosters||[]).map(r=>[r.roster_id,r]));
              const userById = Object.fromEntries((entry.users||[]).map(u=>[u.user_id,u]));
              for(const mk of m){
                const a = mk.roster_id; const mid = mk.matchup_id;
                const opp = m.find(x=>x.matchup_id===mid && x.roster_id!==a);
                if(!opp) continue;
                const rA = rosterById[a] || {}; const rB = rosterById[opp.roster_id] || {};
                const uA = userById[rA.owner_id] || {}; const uB = userById[rB.owner_id] || {};
                const nameA = uA.metadata?.team_name || uA.display_name || `Team ${rA.roster_id||a}`;
                const nameB = uB.metadata?.team_name || uB.display_name || `Team ${rB.roster_id||opp.roster_id}`;
                const label = `${nameA} @ ${nameB}`;
                if(!seen.has(label)) { seen.add(label); pairs.push({label, id: `${a}-${opp.roster_id}`}); }
              }
            }catch(e){}
          }));
          if(pairs.length>0){ for(const p of pairs){ sel.append(el('option',{value:p.id, html:p.label})); } }
          else { sel.innerHTML = '<option value="">No fantasy matchups found either</option>'; }
        };
        document.getElementById('usShowFantasy')?.addEventListener('click', fantasyLoader);
      }
    }catch(err){ console.warn('load games failed', err); sel.innerHTML='<option value="">Failed to load games</option>'; }
    btn.disabled=false; btn.textContent='Load games';
  };
  btn.onclick = doLoadGames;
  // auto-load when user opens the dropdown or focuses it
  sel.addEventListener('focus', ()=>{ if(sel.options.length<=1) doLoadGames(); });
  sel.addEventListener('mousedown', ()=>{ if(sel.options.length<=1) doLoadGames(); });

  // reload games when top-level week selector changes
  const topWeek = $('#weekSelect');
  if(topWeek){ topWeek.removeEventListener('change', topWeek._usGListener||(()=>{})); topWeek._usGListener = ()=>{ sel.innerHTML = '<option value="">All games (select week)</option>'; doLoadGames(); }; topWeek.addEventListener('change', topWeek._usGListener); }

  sel.onchange = async ()=>{
    const v = sel.value;
    // if no selection, clear any filter (show all in rooting interest)
    if(!v){ playersWrap.innerHTML=''; await renderRootingInterestTables(wk, null); return; }
    const parts = v.split('-'); if(parts.length<2){ playersWrap.innerHTML=''; await renderRootingInterestTables(wk, null); return; }
    const away = normalizeTeam(parts[0]);
    const home = normalizeTeam(parts[1]);
    // update rooting interest tables to only include players from the two teams
    playersWrap.innerHTML='';
    await renderRootingInterestTables(wk, [away, home]);
  };
}

// Render simple matchup cards per league for the user summary
async function renderUserMatchups(week, season){
  const container = $('#usMatchups'); if(!container) return;
  container.innerHTML = '';
  const entries = Object.values(g.leagues);
  for (const entry of entries){
    const { league, users, rosters } = entry;
    try{
      const myRoster = rosters.find(r=>r.owner_id===g.userId) || rosters[0];
      const myUser = users.find(u=>u.user_id===myRoster.owner_id) || {};
      const myTeamName = myUser.metadata?.team_name || myUser.display_name || `Team ${myRoster.roster_id}`;
      const proj = await projByPid(+league.season, week, 'regular', g.players, league.scoring_settings||{});
      const projFn = pid => proj[String(pid)]||0;
      const prev = await matchupPreview(league.league_id, week, league, users, rosters, g.players, projFn, myRoster.roster_id, myTeamName);
  // cache the preview so sidebar badge logic can reflect its findings without needing DOM inspection
  try{ g.leagues[league.league_id] = g.leagues[league.league_id] || {}; g.leagues[league.league_id].__lastPreview = prev; }catch(e){}
      // short league name: drop year if present at end
      const shortLeague = (league.name||'League').replace(/\s+\b(20\d{2})\b$/,'').trim();
      const leftScore = Number(prev.me.projected_total).toFixed(2);
      const rightScore = Number(prev.opponent.projected_total).toFixed(2);
      const myWins = Number(prev.me.projected_total) > Number(prev.opponent.projected_total);
      const myScoreClass = myWins ? 'mc-score win' : (Number(prev.me.projected_total) < Number(prev.opponent.projected_total) ? 'mc-score lose' : 'mc-score');
  const card = el('div',{class:'matchup-card','data-league-id': league.league_id},[
        el('div',{class:'mc-head', html: shortLeague}),
        el('div',{class:'mc-body'},[
          el('div',{class:'mc-row'},[
            el('div',{class:'mc-team'}, prev.me.team_name || 'Me'),
            el('div',{class: myScoreClass}, `${leftScore}`)
          ]),
          el('div',{class:'mc-row opp'},[
            el('div',{class:'mc-team'}, prev.opponent.team_name || 'Opponent'),
            el('div',{class:'mc-score'}, `${rightScore}`)
          ])
        ])
      ]);
      // clicking a card should open that league and switch to the matchup tab
      card.addEventListener('click', async ()=>{
        try{
          g.mode='league'; g.selected = league.league_id;
          // mark active in league list and clear User Summary active state
          document.querySelectorAll('.league-item').forEach(n=>n.classList.remove('active'));
          // ensure summary item is not marked active
          const s = document.querySelector('#summaryItem'); if(s) s.classList.remove('active');
          const li = document.querySelector(`#leagueList .league-item[data-id="${league.league_id}"]`);
          if(li) li.classList.add('active');
          // render league and switch to matchup tab
          await renderSelectedLeague();
          openLeagueTab('tab-matchup');
        }catch(err){ console.error('Failed to open league from matchup card', err); status('err', 'Failed to open league'); }
      });
      container.append(card);
    }catch(e){ console.warn('renderUserMatchups failed for', league?.league_id, e); }
  }
}

// delegated tooltip handler for elements with data-tooltip
document.addEventListener('mouseover', (e)=>{
  const t = e.target.closest('[data-tooltip]');
  if(!t) return;
  const tip = t.getAttribute('data-tooltip');
  if(!tip) return;
  let bubble = document.querySelector('.__temp-tooltip');
  if(!bubble){ bubble = document.createElement('div'); bubble.className='__temp-tooltip'; document.body.appendChild(bubble); }
  bubble.textContent = tip;
  const rect = t.getBoundingClientRect();
  bubble.style.position='fixed'; bubble.style.zIndex=9999; bubble.style.maxWidth='320px'; bubble.style.whiteSpace='pre-wrap';
  bubble.style.left = Math.min(window.innerWidth - 20, rect.right + 8) + 'px';
  bubble.style.top = Math.max(8, rect.top) + 'px';
  bubble.style.padding='8px 10px'; bubble.style.background='#07102a'; bubble.style.border='1px solid rgba(255,255,255,0.08)'; bubble.style.borderRadius='8px';
});
document.addEventListener('mouseout', (e)=>{ const leave = e.target.closest('[data-tooltip]'); if(!leave) return; const bubble = document.querySelector('.__temp-tooltip'); if(bubble) bubble.remove(); });

async function userSummaryProjections(leagues, players, week){
  const rows=[];
  await Promise.all(Object.values(leagues).map(async (entry)=>{
    const {league,users,rosters}=entry; const season=+league.season; const scoring=league.scoring_settings||{};
    const myRoster=rosters.find(r=>r.owner_id===g.userId); if(!myRoster) return;
    const myUser=users.find(u=>u.user_id===myRoster.owner_id)||{};
    const myTeamName=(myUser.metadata?.team_name)||myUser.display_name||`Team ${myRoster.roster_id}`;
    const proj=await projByPid(season, week, 'regular', players, scoring); const projFn=(pid)=>proj[String(pid)]||0;
    const prev=await matchupPreview(league.league_id, week, league, users, rosters, players, projFn, myRoster.roster_id, myTeamName);

    const me  = +prev.me.projected_total.toFixed(2);
    const opp = +prev.opponent.projected_total.toFixed(2);
    const myCell  = (me  > opp) ? `${me.toFixed(2)} <span class="win-arrow">➜</span>` : me.toFixed(2);
    const oppCell = (opp > me ) ? `${opp.toFixed(2)} <span class="win-arrow">➜</span>` : opp.toFixed(2);

    rows.push([league.name, myCell, oppCell, prev.opponent.team_name||'—']);
  }));
  rows.sort((a,b)=>parseFloat(b[1]) - parseFloat(a[1]));
  return rows;
}

// ===== Alerts (badges + collapsible replacements) =====
// Compute alert status for a league for the current user/week
// Returns { count: number, red: boolean, yellow: boolean }
async function computeLeagueAlertStatus(entry, week, players){
  const { league, users, rosters } = entry;
  const myRoster = rosters.find(r => r.owner_id === g.userId);
  if (!myRoster) return { count: 0, red: false, yellow: false };
  const season = +league.season;
  const scoring = league.scoring_settings || {};
  const proj = await projByPid(season, week, 'regular', players, scoring);
  const projFn = (pid) => proj[String(pid)] || 0;

  // starters array from roster (may include '0' placeholders)
  const starters = (myRoster.starters || []).slice();
  let red = false;
  // if there is an empty starting slot
  if (!Array.isArray(starters) || starters.length === 0 || starters.some(s=>!s || s==='0')) red = true;

  // build starter projections map by pid and position
  const starterProjByPid = {};
  const starterPids = starters.filter(pid=>pid && pid!=='0');
  for(const pid of starterPids){ starterProjByPid[String(pid)] = +projFn(pid)||0; }

  // count starters with proj === 0
  const countZero = Object.values(starterProjByPid).filter(v=>Number(v)===0).length;
  if(countZero>0) red = true;

  // Do not short-circuit — allow downstream logic to decide how to represent red+yellow together

  // build bench list
  const allPids = new Set([...(myRoster.players||[]), ...(myRoster.starters||[])]);
  // bench pids = players in roster but not in starters
  const benchPids = (myRoster.players||[]).filter(pid=>pid && pid!=='0' && !starterPids.includes(pid));

  // map pid -> pos & proj
  const benchRows = benchPids.map(pid => {
    const m = players[String(pid)] || {};
    return { pid: String(pid), pos: ((m.position||'UNK').toUpperCase()), proj: +projFn(pid)||0 };
  });

  // map starters by pos with their projections
  const startersByPos = {};
  for(const pid of starterPids){ const m = players[String(pid)]||{}; const pos = ((m.position||'UNK').toUpperCase()); startersByPos[pos] = startersByPos[pos] || []; startersByPos[pos].push({ pid:String(pid), proj:+projFn(pid)||0 }); }

  // yellow if any bench of same position has proj > any starter proj for that position
  let yellow = false;
  for(const b of benchRows){ const sList = startersByPos[b.pos] || []; for(const s of sList){ if(b.proj > (s.proj||0)){ yellow = true; break; } } if(yellow) break; }

  return { count: countZero, red, yellow };
}
async function updateLeagueAlertBadges(week){
  const list = $('#leagueList');
  if (!list) return;
  const entries = Object.entries(g.leagues);
  await Promise.all(entries.map(async ([id, entry]) => {
    let status = { count: 0, red: false, yellow: false };
    try { status = await computeLeagueAlertStatus(entry, week, g.players); } catch (e) { /* ignore */ }
    // If we have a cached preview for this league, use it to force red when any starter proj===0
    try{
      const cached = entry.__lastPreview;
      if (cached && Array.isArray(cached.myStart)){
        const anyZero = cached.myStart.some(p => Number(p.proj||0) === 0);
        if (anyZero) status.red = true;
      }
    }catch(e){}
  const dot = list.querySelector(`[data-id="${id}"] .league-dot`);
    if (dot){
      // If this league is currently active in the UI, check the rendered matchup DOM for starter/bench dots
      try{
        if (g.selected === id){
          const activeMatchupArea = document.querySelector('#matchupSummary') || document.querySelector('#myStarters') || document.querySelector('#oppStarters');
          if (activeMatchupArea){
            const hasRedStarter = !!activeMatchupArea.querySelector('.starter-dot.dot-red');
            const hasYellowStarter = !!activeMatchupArea.querySelector('.starter-dot.dot-yellow') || !!activeMatchupArea.querySelector('.bench-dot.dot-yellow');
            if (hasRedStarter) status.red = true;
            if (hasYellowStarter) status.yellow = true;
          }
        }
      }catch(e){ }

      // render three-dot indicator: red, yellow, green (green means OK)
      dot.innerHTML = '';
      const redDot = el('span',{class:'ldot'});
      const yellowDot = el('span',{class:'ldot'});
      const greenDot = el('span',{class:'ldot'});
      // apply active classes
      if (status.red) redDot.classList.add('red-active');
      if (status.yellow) yellowDot.classList.add('yellow-active');
      // green is active only when neither red nor yellow present
      if (!status.red && !status.yellow) greenDot.classList.add('green-active');
      dot.append(redDot, yellowDot, greenDot);
      dot.title = status.red ? 'Starter issue' : (status.yellow ? 'Bench has better projected' : 'All starters OK');
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
    const d = el('details', { class: 'alert-item' });
    const summary = el('summary', { html: `⚠️ <b>${p.name}</b> — ${p.pos} (${p.team}) • 0.00 pts &nbsp; <a href="#" class="waiver-link" data-pos="${p.pos}">Find waiver alternatives</a>` });
    d.append(summary);

    const cands = candidatesByPid[p.pid] || [];
    if (cands.length === 0) {
      d.append(el('div', { class: 'note', html: 'No same-position bench players available.' }));
    } else {
      const rows = cands.map(r => [r.name, r.pos, r.team, r.proj.toFixed(2)]);
      const wrap = el('div');
      renderSortableTable(wrap, ['Replacement','Pos','Team','Proj'], rows, ['str','str','str','num']);
      d.append(wrap);
    }
    container.append(d);
  });
}

// ===== League roster positions display =====
function rosterPositionsSummary(league){
  const rp = (league.roster_positions || []).map(x => String(x).toUpperCase());
  const omit = new Set(['BN','TAXI','IR']);
  const counts = {};
  for (const slot of rp) { if (omit.has(slot)) continue; counts[slot] = (counts[slot] || 0) + 1; }
  const order = ['QB','RB','WR','TE','FLEX','SUPER_FLEX','K','DEF'];
  const rest = Object.keys(counts).filter(k => !order.includes(k)).sort();
  const all = [...order.filter(k => counts[k]), ...rest];
  return all.map(k => `${k.replace('_',' ')}×${counts[k]}`).join(' • ');
}

// ===== Waiver Wire =====
async function loadTrendingAddsMap(){
  // last 24h, up to 300 players
  let data = [];
  try {
    data = await fetchJSON(`https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=300`);
  } catch {}
  const m = new Map();
  if (Array.isArray(data)) {
    for (const it of data) {
      const pid = String(it?.player_id ?? it?.player ?? '');
      const ct  = +it?.count || 0;
      if (pid) m.set(pid, ct);
    }
  }
  return m; // Map<pid, addsCount>
}

function getRosteredPidSet(rosters){
  const set = new Set();
  for (const r of rosters || []) {
    for (const pid of (r.players || [])) set.add(String(pid));
    for (const pid of (r.starters || [])) if (pid !== '0') set.add(String(pid));
    for (const pid of (r.taxi || [])) set.add(String(pid));
  }
  return set;
}

function leagueAllowedPositions(league){
  return activeLeaguePositions(league); // ['QB','RB','WR','TE','K','DEF'] filtered by league
}

function openLeagueTab(tabId){
  const btn = document.querySelector(`#leagueTabs .tab-btn[data-tab="${tabId}"]`);
  if (btn){
    document.querySelectorAll('#leagueTabs .tab-btn').forEach(x=>x.classList.remove('active'));
    btn.classList.add('active');
  }
  document.querySelectorAll('#leagueSections > section').forEach(s=>s.classList.toggle('active', s.id===tabId));
}

async function renderWaiverWire(league, rosters, season, week, scoring, preferredPos){
  const note = $('#waiverNote');
  const tableC = $('#waiverTable');
  const posSel = $('#waiverPos');

  // If the HTML doesn't include the waiver UI (some variants omit it), skip rendering.
  if (!note || !tableC || !posSel) {
    console.warn('renderWaiverWire: waiver DOM elements not found, skipping.');
    return;
  }

  note.textContent = `Week ${week} • ${league.name} scoring`;
  tableC.innerHTML = '';

  // Projections for week/league already computed in renderSelectedLeague and passed via scoring.
  const proj = await projByPid(season, week, 'regular', g.players, scoring);
  const trendMap = await loadTrendingAddsMap();

  const rostered = getRosteredPidSet(rosters);
  const allowed = leagueAllowedPositions(league);
  const choices = ['ALL', ...allowed];

  // (Re)build position select
  posSel.innerHTML = '';
  for (const opt of choices){
    const o = el('option', { value: opt, html: opt.replace('_',' ') });
    if (preferredPos && opt === preferredPos) o.selected = true;
    posSel.append(o);
  }

  // Candidate pool: only those with a projection row (fast) and not rostered in this league
  const items = [];
  for (const pid of Object.keys(proj)) {
    if (rostered.has(String(pid))) continue;
    const m = g.players[pid]; if (!m) continue;
    let pos = (m.position || 'UNK').toUpperCase();
    if (pos === 'D/ST' || pos === 'DST') pos = 'DEF';
    if (!allowed.includes(pos)) continue;

    let bye = teamBye(m.team, season);
    if (!(Number.isInteger(bye)&&bye>=1&&bye<=18)) bye = Number.isInteger(m.bye_week) ? m.bye_week : null;

    const name = m.full_name || (m.first_name && m.last_name ? `${m.first_name} ${m.last_name}` : (m.last_name || 'Unknown'));
    const projVal = +proj[String(pid)] || 0;
    const trend = trendMap.get(String(pid)) || 0;

    items.push({
      pid: String(pid),
      name,
      pos,
      team: m.team || 'FA',
      proj: projVal,
      trend,
      bye
    });
  }

  function draw(selectedPos){
    const filtered = items
      .filter(it => selectedPos === 'ALL' || it.pos === selectedPos)
      .sort((a,b)=> b.proj - a.proj || b.trend - a.trend || a.name.localeCompare(b.name))
      .slice(0, 50); // keep it tight

    if (filtered.length === 0) {
      tableC.innerHTML = '<div class="note">No available players match this filter.</div>';
      return;
    }

    const rows = filtered.map(p => [
      p.name,
      p.pos,
      p.team,
      p.proj.toFixed(2),
      p.trend,
      Number.isInteger(p.bye) ? ('W'+p.bye) : '—'
    ]);

    renderSortableTable(tableC,
      ['Player','Pos','Team','Proj (W'+week+')','Trend (adds/24h)','Bye'],
      rows, ['str','str','str','num','num','bye']);
  }

  draw(posSel.value || choices[0]);
  posSel.onchange = () => draw(posSel.value);
}

// ===== UI utilities =====
function setWeekOptions(){ const wk=$('#weekSelect'); wk.innerHTML=''; for(let w=1; w<=18; w++){ const o=el('option',{value:String(w), html:'Week '+w}); if(w===1) o.selected=true; wk.append(o);} }
function showControls(){ $('#seasonGroup').classList.remove('hidden'); $('#weekGroup').classList.remove('hidden'); }
function resetMain(){
  $('#leagueViews').classList.add('hidden'); $('#userSummary').classList.add('hidden'); $('#contextNote').textContent=''; $('#posNote').textContent='';
  ['#rosterTable','#posTable','#matchupSummary','#myStarters','#oppStarters','#byeMatrix','#alertsView','#usRootForTable','#usRootAgainstTable','#usByeMatrix','#waiverTable'].forEach(s=>{ const n=$(s); if(n) n.innerHTML=''; });
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
    // dot for red/yellow indicator, numeric badge for count
    const dot = el('span',{class:'league-dot', title:''});
    const titleWrapper = el('div',{class:'li-info'},[
      el('div',{class:'li-title', html: league?.name || `League ${id}`}),
      el('div',{class:'li-sub',   html: (myTeamName || '') + rec })
    ]);
  const item=el('div',{class:'league-item'+(id===active?' active':''), 'data-id':id},[ titleWrapper, dot ]);
    item.addEventListener('click', async ()=>{
      try {
        console.log('League click:', id);
        g.mode='league'; g.selected=id;
        document.querySelectorAll('.league-item').forEach(n=>n.classList.remove('active'));
        item.classList.add('active'); $('#summaryItem').classList.remove('active');
  // open the Matchup tab by default when clicking a league
  openLeagueTab('tab-matchup');
  await renderSelectedLeague();
      } catch (err) {
        console.error('Error rendering league on click:', err);
        status('err', `Failed to open league: ${err.message || err}`);
      }
    });
    list.append(item);
  });
}

async function renderSelectedLeague(){
  try {
    const id=g.selected; if(!id) return; const {league,users,rosters}=g.leagues[id];
    const season=+league.season; const week=+($('#weekSelect').value||1);
    const myRoster=rosters.find(r=>r.owner_id===g.userId) || rosters[0];
    const myUser=users.find(u=>u.user_id===myRoster.owner_id)||{};
    const myTeamName=(myUser.metadata?.team_name)||myUser.display_name||`Team ${myRoster.roster_id}`;

    // Context text + positions summary
    $('#contextNote').textContent = `${league.name} • ${league.season}`;
    $('#posNote').textContent = `Roster slots: ${rosterPositionsSummary(league)}`;

    // Roster table
    renderRoster($('#rosterTable'), myRoster, g.players, season);

    // Projections for this league/week
    const scoring=league.scoring_settings||{}; 
    const proj=await projByPid(season, week, 'regular', g.players, scoring);
    const projFn=(pid)=>proj[String(pid)]||0;

    // Team projections (dynamic positions)
    const vals=rosters.reduce((acc,r)=>{ acc[r.roster_id]=teamPosValues(league, rosterRows(r,g.players,projFn)); return acc; },{});
    const rp = (league.roster_positions||[]).map(x=>String(x).toUpperCase());
    const orderPure = ['QB','RB','WR','TE','K','DEF'].filter(k => rp.includes(k));
    const orderFlex = []; if (rp.includes('FLEX')) orderFlex.push('FLEX'); if (rp.includes('SUPER_FLEX')) orderFlex.push('SUPER_FLEX');
    const order = [...orderPure, ...orderFlex];

    const posStats={};
    const allRosters = rosters.map(r => r.roster_id);
    for (const pos of order){
      const list = rosters.map(r => (vals[r.roster_id][pos] || 0));
      const my = list[allRosters.indexOf(myRoster.roster_id)] || 0;
      const {rank,out_of,pct}=rankPct(list,my);
      posStats[pos]={ my_value:+(+my).toFixed(2), rank, out_of, percentile:pct};
    }
    renderPos($('#posTable'), posStats, order);

    // Matchup preview
    const prev=await matchupPreview(league.league_id, week, league, users, rosters, g.players, projFn, myRoster.roster_id, myTeamName);
  renderMatchup($('#matchupSummary'), $('#myStarters'), $('#oppStarters'), prev);
  try{ g.leagues[id] = g.leagues[id] || {}; g.leagues[id].__lastPreview = prev; }catch(e){}

    // League-specific Bye Matrix (by position groups)
    const byeData = byeMatrixByPosition(myRoster, g.players, season, league);
    renderByePositions($('#byeMatrix'), byeData);

    // Alerts content + badge on tab
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
      if (flagged.length > 0) alertBtn.classList.add('has-alert'); else alertBtn.classList.remove('has-alert');
    }

    // Waiver Wire render (use any preferred pos jump from Alerts)
    // Only attempt if the waiver UI exists in the DOM (some HTML variants omit it)
    if (document.querySelector('#waiverTable') || document.querySelector('#tab-waivers')){
      await renderWaiverWire(league, rosters, season, week, scoring, g.waiverPref);
      g.waiverPref = null; // consume one-shot preference
    }

    $('#userSummary').classList.add('hidden');
    $('#leagueViews').classList.remove('hidden');
  // ensure sidebar alert badges reflect any changes discovered while rendering this league
  try{ await updateLeagueAlertBadges(week); }catch(e){}
  } catch (err) {
    console.error('Error in renderSelectedLeague:', err);
    status('err', `Error rendering league: ${err.message || err}`);
  }
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

  // Refresh button: repull everything from Sleeper for current username
  const refreshBtn = $('#refreshBtn');
  if(refreshBtn){
    refreshBtn.addEventListener('click', async ()=>{
      const uname = ($('#username').value || '').trim();
      if(!uname){ status('err','No username to refresh. Enter a username first.'); return; }
      try{
        status('', 'Refreshing data from Sleeper…');
        // Remove all cached entries created by fetchJSON (keys prefixed with cache:)
        try{
          const keys = Object.keys(localStorage || {}).filter(k=>k&&k.startsWith('cache:'));
          for(const k of keys) localStorage.removeItem(k);
        }catch(e){}
        await loadForUsername(uname);
        status('ok','Data refreshed.');
      }catch(e){ console.error('Refresh failed', e); status('err','Refresh failed.'); }
    });
  }

  $('#username').addEventListener('input', ()=>{ $('#viewLeaguesBtn').disabled = !$('#username').value.trim(); });
  // ...existing code...

  // Tabs (league + user summary) + waiver jump
  document.addEventListener('click', async (e)=>{
    const btn1=e.target.closest('#leagueTabs .tab-btn');
    if(btn1){
      document.querySelectorAll('#leagueTabs .tab-btn').forEach(x=>x.classList.remove('active'));
      btn1.classList.add('active');
      const id=btn1.dataset.tab;
      document.querySelectorAll('#leagueSections > section').forEach(s=>s.classList.toggle('active', s.id===id));

      // If switching to Waiver Wire, refresh it (uses current week & scoring)
      if (id === 'tab-waivers' && g.mode==='league' && g.selected){
        const { league, rosters } = g.leagues[g.selected];
        const season=+league.season; const week=+($('#weekSelect').value||1);
        const scoring=league.scoring_settings||{};
        await renderWaiverWire(league, rosters, season, week, scoring, g.waiverPref);
        g.waiverPref = null;
      }
      return;
    }

    const btn2=e.target.closest('#usTabs .tab-btn');
    if(btn2){
      document.querySelectorAll('#usTabs .tab-btn').forEach(x=>x.classList.remove('active'));
      btn2.classList.add('active');
      const id=btn2.dataset.tab; document.querySelectorAll('#userSummary .sections > section').forEach(s=>s.classList.toggle('active', s.id===id));
      return;
    }

    // Alerts -> Waiver jump
    const wlink = e.target.closest('.waiver-link');
    if (wlink) {
      e.preventDefault();
      g.waiverPref = wlink.getAttribute('data-pos') || null;
      openLeagueTab('tab-waivers');
      // Re-render immediately
      if (g.mode==='league' && g.selected){
        const { league, rosters } = g.leagues[g.selected];
        const season=+league.season; const week=+($('#weekSelect').value||1);
        const scoring=league.scoring_settings||{};
        await renderWaiverWire(league, rosters, season, week, scoring, g.waiverPref);
        g.waiverPref = null;
      }
    }
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