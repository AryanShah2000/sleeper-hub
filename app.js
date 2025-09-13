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
// ensure weeks 1..18 exist for 2025 — leave missing weeks empty instead of duplicating week 1
if(!STATIC_SCHEDULE['2025']) STATIC_SCHEDULE['2025'] = {};
for(let w=1; w<=18; w++){ const wk=String(w); if(!Object.prototype.hasOwnProperty.call(STATIC_SCHEDULE['2025'], wk)) STATIC_SCHEDULE['2025'][wk] = []; }

// Import helpers provided by `src/utils.js` and API helpers from `src/api.js`.
const { normalizeTeam, $, el, escapeHtml, status, TTL, ck, parseBD, ageFrom, age } = window.__sha_utils || {};
// fetchJSON and other API helpers come from src/api.js via window.__sha_api or globals set by that module
const { fetchJSON: _apiFetchJSON, resolveUserId: _resolveUserId, loadMyLeagues: _loadMyLeagues, loadLeagueBundle: _loadLeagueBundle, loadPlayersMap: _loadPlayersMap } = window.__sha_api || {};
// Provide fallbacks to the global names (app.js references fetchJSON, resolveUserId, etc. directly)
try{
  window.fetchJSON = window.fetchJSON || _apiFetchJSON;
  window.resolveUserId = window.resolveUserId || _resolveUserId;
  window.loadMyLeagues = window.loadMyLeagues || _loadMyLeagues;
  window.loadLeagueBundle = window.loadLeagueBundle || _loadLeagueBundle;
  window.loadPlayersMap = window.loadPlayersMap || _loadPlayersMap;
}catch(e){}

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
  // Provider rows vary; prefer explicit fantasy point totals if present.
  const preferKeys = [
    'fantasy_points_ppr', 'fantasy_points', 'fpts', 'pts_ppr', 'ppr', 'pts', 'fantasy_points_total'
  ];
  for (const k of preferKeys) if (it?.[k] != null) return +it[k] || 0;
  const s = it?.stats || {};
  for (const k of preferKeys) if (s?.[k] != null) return +s[k] || 0;

  // Kicker fallback: if the stats include FG/XP breakdown, compute using sensible defaults.
  // This handles providers that expose field goal buckets instead of a single fantasy total.
  const fg = Number(s.field_goals_made || s.fg_made || s.fgm || s.fg || s.fgs || 0) || 0;
  const xp = Number(s.extra_points || s.xp || s.xps || 0) || 0;
  const fg0_39 = Number(s.fg0_39 || s.fg_0_39 || s.fg_0_19 || 0) || 0;
  const fg40_49 = Number(s.fg40_49 || s.fg_40_49 || 0) || 0;
  const fg50 = Number(s.fg50 || s.fg_50 || 0) || 0;
  // if we have any FG/XP info, build a default score: 0-39:3, 40-49:4, 50+:5, XP:1
  if (fg || xp || fg0_39 || fg40_49 || fg50) {
    const bucketSum = fg0_39 + fg40_49 + fg50;
    const genericFg = Math.max(0, fg - bucketSum);
    const pts = genericFg * 3 + fg0_39 * 3 + fg40_49 * 4 + fg50 * 5 + xp * 1;
    return +pts || 0;
  }

  return 0;
}
async function providerRows(season, week, season_type, opts = {}) {
  const url = `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=${season_type}&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=ppr`;
  const raw = await fetchJSON(url, opts);
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
async function projByPid(season, week, season_type, players, scoring, opts = {}) {
  const rows = await providerRows(season, week, season_type, opts);
  // If running from file:// the browser environment can block or interfere with
  // CORS requests to third-party APIs. Provide a visible warning to the user so
  // they can try serving the app via a local webserver (e.g. python -m http.server).
  try{
      if (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:') {
      status('err','Running from file:// may block projection fetches; serve the app via a local webserver (e.g. `python -m http.server`) and reload.');
    }
  }catch(e){}
    if (!rows || Object.keys(rows).length === 0) {
    try{ status('err', `Projections fetch returned no rows for ${season} W${week}. This may be a CORS/provider issue or a temporary outage.`); }catch(e){}
  }
  const out = {};
  Object.keys(rows).forEach((pid) => (out[pid] = rescored(pid, rows, players, scoring)));
  return out;
}

// Debug helper: show provider rows + rescored values + final proj used by app
async function showProjectionDebug(leagueId){
  try{
    const entry = g.leagues[leagueId]; if(!entry) { status('err','League not in memory for debug'); return; }
    const { league } = entry; const season = +league.season; const week = +($('#weekSelect').value||1);
    status('', `Fetching provider rows for ${league.name} W${week}…`);
    const rows = await providerRows(season, week, 'regular');
    const proj = await projByPid(season, week, 'regular', g.players, league.scoring_settings||{});

    // Build table rows: [Name, PID, Company, feedPPR, rescored, finalProj]
    const tableRows = Object.keys(rows).map(pid=>{
      const r = rows[pid] || {};
      const pmeta = g.players && g.players[pid] ? g.players[pid] : {};
      const name = pmeta.full_name || (pmeta.first_name && pmeta.last_name ? `${pmeta.first_name} ${pmeta.last_name}` : (pmeta.last_name||pid));
      const feed = (typeof feedPPR === 'function') ? feedPPR(r) : (r?.ppr||0);
      const resc = rescored(pid, rows, g.players, league.scoring_settings||{});
      const finalProj = proj[String(pid)] || 0;
      return [ name, pid, (r.company||''), (Number.isFinite(feed)?feed.toFixed(2):String(feed)), resc.toFixed(2), finalProj.toFixed(2) ];
    }).sort((a,b)=>parseFloat(b[5]) - parseFloat(a[5]));

    // Create modal
    const modal = el('div',{class:'__proj-debug-modal'});
    modal.style.position='fixed'; modal.style.left='8px'; modal.style.right='8px'; modal.style.top='8px'; modal.style.bottom='8px'; modal.style.background='#021124'; modal.style.color='#fff'; modal.style.zIndex=99999; modal.style.overflow='auto'; modal.style.padding='12px'; modal.style.border='1px solid rgba(255,255,255,0.06)'; modal.style.borderRadius='8px';
    const hdr = el('div',{html:`<b>Projection debug — ${league.name} Week ${week}</b>`}); hdr.style.marginBottom='8px';
    const close = el('button',{html:'Close', class:'small'}); close.style.marginLeft='12px'; close.onclick = ()=> modal.remove();
    const info = el('div',{html:`Provider rows: ${Object.keys(rows).length} • Rescored entries: ${Object.keys(proj).length}`}); info.style.margin='8px 0 12px 0';
    const tableWrap = el('div');
    renderSortableTable(tableWrap, ['Player','PID','Company','feedPPR','rescored','finalProj'], tableRows, ['str','str','str','num','num','num']);
    modal.append(hdr, close, info, tableWrap);
    document.body.append(modal);
    status('ok','Projection debug ready (modal opened)');
  }catch(e){ console.error('showProjectionDebug failed', e); status('err','Projection debug failed (see console)'); }
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
// date/age helpers provided by src/utils.js (available via window.__sha_utils)
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

  // compact scoreboard at top: render each side as name + score aligned vertically and centered
  // show projected totals only if both teams have no current scoring yet
  const showProjLine = (Number(p.me.current_total) === 0 && Number(p.opponent.current_total) === 0);
  // Build a centered scoreboard: team names on the sides, scores centered
  const leftSide = el('div',{class:'sb-side sb-left-side'}, [ el('div',{class:'sb-name', html:leftName}) ]);
  const rightSide = el('div',{class:'sb-side sb-right-side'}, [ el('div',{class:'sb-name', html:rightName}) ]);
  const leftScore = el('div',{class:'sb-side-score', html:leftCur});
  const rightScore = el('div',{class:'sb-side-score', html:rightCur});
  // center area: two rows — top row shows scores, bottom row shows projections under each score
  const topRow = el('div',{class:'sb-row'}, [ el('div',{class:'sb-side sb-score-left'}, [ leftScore ]), el('div',{class:'sb-vs', html:'vs'}), el('div',{class:'sb-side sb-score-right'}, [ rightScore ]) ]);
  const projRow = showProjLine ? el('div',{class:'sb-row sb-center-proj'}, [ el('div',{class:'sb-proj', html:(leftProj)}), el('div',{class:'sb-vs', html:''}), el('div',{class:'sb-proj', html:(rightProj)}) ]) : null;
  const centerScores = projRow ? el('div',{class:'sb-center-scores'}, [ topRow, projRow ]) : el('div',{class:'sb-center-scores'}, [ topRow ]);
  const scoreBoxChildren = [ el('div',{class:'sb-row'}, [ leftSide, centerScores, rightSide ]) ];
  const scoreBox = el('div',{class:'scorebox-small'}, scoreBoxChildren);
  sumDiv.append(scoreBox);

  // Build matchup table: use the starter order from Sleeper (array order)
    const tbl = document.createElement('table'); tbl.className='matchup-table';
  const thead = el('thead'); thead.append(el('tr',{}, [ el('th',{html:''}), el('th',{html:''}), el('th',{html:''}), el('th',{html:''}) ]));
    tbl.append(thead);
  const tbody = el('tbody');

  const leftList = p.myStart || [];
  const rightList = p.oppStart || [];
  const maxLen = Math.max(leftList.length, rightList.length);
  // helper to build score box with classes based on played state
  const buildScoreBox = (cur, proj) => {
    // Always show 0.00 in the current box even when no current value is present,
    // but keep the 'unplayed' class so it appears grey until the player actually plays.
    const curTxt = (cur === null || cur === undefined) ? '0.00' : (Number.isFinite(Number(cur)) ? Number(cur).toFixed(2) : '0.00');
    // sanitize projected value to avoid showing "NaN"
    const safeProj = (proj === null || proj === undefined || !Number.isFinite(Number(proj))) ? null : Number(proj);
    // treat null/undefined as "unplayed"; only show projection when player hasn't played
    const curClass = (cur === null || cur === undefined) ? 'ps-current unplayed' : 'ps-current played';
    const children = [ el('div',{class:curClass, html: curTxt}) ];
    // show projection only if player hasn't played yet
    if (cur === null || cur === undefined) {
      const projTxt = safeProj === null ? '' : safeProj.toFixed(2);
      children.push(el('div',{class:'ps-proj', html: projTxt}));
    }
    return el('div',{class:'player-score-box'}, children);
  };
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
  const lcur = L ? ((L.current === null || L.current === undefined) ? null : Number(L.current)) : null;
  const rcur = R ? ((R.current === null || R.current === undefined) ? null : Number(R.current)) : null;
  const lproj = L ? ((L.proj === null || L.proj === undefined) ? null : Number(L.proj)) : null;
  const rproj = R ? ((R.proj === null || R.proj === undefined) ? null : Number(R.proj)) : null;
    const leftScoreTd = el('td'); leftScoreTd.append(buildScoreBox(lcur, lproj, L ? L.preproj : null));
      const rightScoreTd = el('td'); rightScoreTd.append(buildScoreBox(rcur, rproj, R ? R.preproj : null));
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
  const lcur = L ? ((L.current === null || L.current === undefined) ? null : Number(L.current)) : null;
  const rcur = R ? ((R.current === null || R.current === undefined) ? null : Number(R.current)) : null;
  const lproj = L ? ((L.proj === null || L.proj === undefined) ? null : Number(L.proj)) : null;
  const rproj = R ? ((R.proj === null || R.proj === undefined) ? null : Number(R.proj)) : null;
  const leftScoreTd = el('td'); leftScoreTd.append(buildScoreBox(lcur, lproj, L ? L.preproj : null));
  const rightScoreTd = el('td'); rightScoreTd.append(buildScoreBox(rcur, rproj, R ? R.preproj : null));
      const tr = el('tr',{}, [ leftCell, leftScoreTd, rightScoreTd, rightCell ]);
      tr.classList.add('bench'); tbody.append(tr);
    }
  }

  tbl.append(tbody);
  sumDiv.append(tbl);
}
async function matchupPreview(leagueId, week, league, users, rosters, players, projFn, myRid, myTeam, preMap){
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
  // Distinguish between "didn't play" (null) and "played and scored 0" (0).
  // Only accept a 0 as "played" when there is per-player stats evidence.
  const scoreSources = ['players_points','player_points','points'];
  const statsKeys = ['player_stats','players_stats','stats','player_game_stats'];
  const mmHasScoring = scoreSources.some(k => mm?.[k] && Object.values(mm[k]).some(v => v != null && Number(v) !== 0));
  const pidHasStats = (pid)=> statsKeys.some(k => mm?.[k] && mm[k][pid] && Object.values(mm[k][pid]).some(v => v != null && Number(v) !== 0));
  let cur = null;
  for (const k of scoreSources){
    if (mm?.[k] && mm[k][pid] != null){
      const val = Number(mm[k][pid]);
      // If val is 0, require per-player stats to consider it a played value.
      if (val === 0){ cur = pidHasStats(pid) ? 0 : null; }
      else { cur = val; }
      break;
    }
  }
  const preproj = preMap && preMap[String(pid)] != null ? (+preMap[String(pid)]||0) : null;
  return { pid, name, pos:(m.position||'UNK').toUpperCase(), team:m.team||'FA', proj:+projFn(pid)||0, preproj, current: cur };
  });
  const bench = (rid)=>{ const m=byRid.get(rid)||{}; const r=rosterById[rid]||{}; const all = (m.players||r.players||[]).filter(pid=>pid!=='0'); const s = new Set(starters(rid)); return all.filter(pid=>!s.has(pid)); };
  const benchProj = (rid)=> bench(rid).map(pid=>{ const m=players[pid]||{}; const name=m.full_name||(m.first_name&&m.last_name?`${m.first_name} ${m.last_name}`:(m.last_name||'Unknown')); const mm = byRid.get(rid)||{}; const scoreSources = ['players_points','player_points','points']; const statsKeys = ['player_stats','players_stats','stats','player_game_stats']; const pidHasStats = (pid)=> statsKeys.some(k => mm?.[k] && mm[k][pid] && Object.values(mm[k][pid]).some(v => v != null && Number(v) !== 0)); let cur = null; for (const k of scoreSources){ if (mm?.[k] && mm[k][pid] != null){ const val = Number(mm[k][pid]); if (val === 0){ cur = pidHasStats(pid) ? 0 : null; } else { cur = val; } break; } } const preproj = preMap && preMap[String(pid)] != null ? (+preMap[String(pid)]||0) : null; return { pid, name, pos:(m.position||'UNK').toUpperCase(), team:m.team||'FA', proj:+projFn(pid)||0, preproj, current: cur }; });
  let oppRid = null; if (myM){ const mid=myM.matchup_id; const opp = matchups.find(m=>m.matchup_id===mid && m.roster_id!==myRid); oppRid = opp?.roster_id ?? null; }
  const myStart = startersProj(myRid); const oppStart = oppRid ? startersProj(oppRid) : [];
  const myBench = benchProj(myRid);
  const oppBench = oppRid ? benchProj(oppRid) : [];
  const getPoints = (rid)=>{ const m=byRid.get(rid)||{}; return Number(m?.points ?? m?.points_total ?? m?.team_points ?? m?.score ?? m?.total ?? 0) || 0; };
  const myCurrent = getPoints(myRid);
  const oppCurrent = getPoints(oppRid);
  // prefer actual current_total when matchup appears complete: either many starters have current values
  const myProjSum = myStart.reduce((s,p)=>s + (Number.isFinite(Number(p.proj)) ? Number(p.proj) : 0), 0);
  const oppProjSum = oppStart.reduce((s,p)=>s + (Number.isFinite(Number(p.proj)) ? Number(p.proj) : 0), 0);
  const myAllStartersPlayed = myStart.length>0 && myStart.every(p => p.current !== null && p.current !== undefined);
  const oppAllStartersPlayed = oppStart.length>0 && oppStart.every(p => p.current !== null && p.current !== undefined);
  const meProjected = (myAllStartersPlayed || (myCurrent && myCurrent > 0)) ? myCurrent : myProjSum;
  const oppProjected = (oppAllStartersPlayed || (oppCurrent && oppCurrent > 0)) ? oppCurrent : oppProjSum;
  return {
    week,
    me: { team_name: myTeam, projected_total: +Number(meProjected || 0).toFixed(2), current_total: myCurrent },
    opponent: { team_name: teamName(oppRid), projected_total: +Number(oppProjected || 0).toFixed(2), current_total: oppCurrent },
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
  // prepare player search list (lazy populate once per load or if players map changes)
  try{ buildPlayerSearchList(); }catch(e){}
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
      // Compose player cell: name + meta (smaller)
      const playerCell = {
        d: `<div style='display:flex;flex-direction:column;align-items:flex-start;'>`
          + `<span class='player-name' style='font-weight:600;'>${escapeHtml(name)}</span>`
          + `<span class='player-meta' style='font-size:12px;color:var(--muted);margin-top:2px;'>${escapeHtml(pos)} • ${escapeHtml(team)}</span>`
          + `</div>`,
        v: name
      };
      if(haveCount >= needFor){ rowsFor.push([playerCell, {v:haveCount, d:haveCount, ttip: haveLeagues.join('\n')}, {v:vsCount, d:vsCount, ttip: oppLeagues.join('\n')}]); }
      if(vsCount >= needAgainst){ rowsAgainst.push([playerCell, {v:vsCount,d:vsCount, ttip: oppLeagues.join('\n')}, {v:haveCount,d:haveCount, ttip: haveLeagues.join('\n')}]); }
    }

    // Only show Player, For, Against columns (no separate Pos/Team)
    const headers = ['Player','For','Against'];
    rowsFor.sort((a, b) => (b[1].v||0) - (a[1].v||0) || a[0].v.localeCompare(b[0].v));
    if (rowsFor.length === 0) {
      $('#usRootForTable').innerHTML = '<div class="note">No players with exposures meeting the threshold.</div>';
    } else {
      renderSortableTable($('#usRootForTable'), headers, rowsFor, ['str','num','num']);
    }

    // For 'Against', swap For/Against columns for visual alignment
    const rowsAgainstAligned = rowsAgainst.map(r => [r[0], r[2], r[1]]);
    if (rowsAgainst.length === 0) {
      $('#usRootAgainstTable').innerHTML = '<div class="note">No opponents with exposures meeting the threshold this week.</div>';
    } else {
      renderSortableTable($('#usRootAgainstTable'), headers, rowsAgainstAligned, ['str','num','num']);
    }
  }catch(e){ console.warn('renderRootingInterestTables failed', e); }
}

// Try to fetch schedule for a week from Sleeper. Fallback to a minimal mapping if unavailable.
async function fetchWeekGames(week, season=+($('#seasonMain').value||2025)){
  // Prefer a local schedule JSON file first (repo-provided fallback), then try Sleeper, ESPN, etc.
  try{
    const local = await fetchJSON(`data/schedule-${season}.json`);
    const wkStr = String(week);
    if(local && (local[wkStr] || Array.isArray(local)) ){
      const arr = Array.isArray(local[wkStr]) ? local[wkStr] : (Array.isArray(local) ? local.filter(g=>Number(g.week)===Number(week)) : null);
      if(Array.isArray(arr) && arr.length>0){
        return arr.map(g=>({ away_team: (g.away_team||g.away||g.away_team_abbr||'').toUpperCase(), home_team: (g.home_team||g.home||g.home_team_abbr||'').toUpperCase(), label: g.label || (g.away_team+' @ '+g.home_team) }));
      }
    }
  }catch(e){ console.warn('Local schedule fetch failed', e); }

  // Prefer the Sleeper schedule endpoint first (CORS-friendly and canonical for NFL schedule)
  try{
    const games = await fetchJSON(`https://api.sleeper.app/v1/league/nfl/schedule/${season}`);
    if (Array.isArray(games)){
      const filtered = games.filter(g => Number(g.week) === Number(week));
      if (filtered.length > 0) return filtered.map(g=>({ away_team: (g.away_team||g.away_team_abbr||g.away||'').toUpperCase(), home_team: (g.home_team||g.home_team_abbr||g.home||'').toUpperCase(), label: g.title || (g.away_team+' @ '+g.home_team) }));
    }
    if (games && typeof games === 'object'){
      const arr = Object.values(games).flat(); const filtered = arr.filter(g => Number(g.week) === Number(week));
      if (filtered.length > 0) return filtered.map(g=>({ away_team: (g.away_team||g.away_team_abbr||g.away||'').toUpperCase(), home_team: (g.home_team||g.home_team_abbr||g.home||'').toUpperCase(), label: g.title || (g.away_team+' @ '+g.home_team) }));
    }
  }catch(e){ console.warn('Sleeper schedule fetch failed', e); }

  // Next: try ESPN public API (may be blocked by CORS). Prefer direct fetch then fallback to a public proxy.
  // Try ESPN via a public CORS proxy first (helps avoid CORS / 500 server errors seen from direct calls)
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

  // Try ESPN direct as a secondary attempt
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
  // Team abbreviation normalization map for dropdown
  const teamAbbrMap = {
    'NWE':'NE', 'NE':'NE',
    'KAN':'KC', 'KC':'KC',
    'SFO':'SF', 'SF':'SF',
    'LAC':'LAC', 'SDG':'LAC', 'SD':'LAC',
    'IND':'IND',
    'LVR':'LV', 'OAK':'LV', 'LV':'LV',
    'STL':'LAR', 'LA':'LAR', 'LAR':'LAR',
    'JAC':'JAX', 'JAX':'JAX',
    'NYJ':'NYJ', 'NYG':'NYG', 'MIA':'MIA', 'BUF':'BUF', 'CIN':'CIN', 'BAL':'BAL', 'PIT':'PIT', 'CLE':'CLE', 'DET':'DET', 'CHI':'CHI', 'GB':'GB', 'DAL':'DAL', 'PHI':'PHI', 'SEA':'SEA', 'DEN':'DEN', 'MIN':'MIN', 'ATL':'ATL', 'CAR':'CAR', 'TB':'TB', 'TEN':'TEN'
  };
  const doLoadGames = async ()=>{
    btn.disabled = true; btn.textContent='Loading…';
    try{
      const games = await fetchWeekGames(wk);
      sel.innerHTML = '<option value="">Select a game…</option>';
      if(Array.isArray(games) && games.length>0){
        for(const g of games){
          // normalize team codes for dropdown
          let away = g.away_team;
          let home = g.home_team;
          // Special handling for LAC (Colts) and LAC (Raiders)
          if(away === 'LAC' && g.home_team === 'IND') away = 'IND';
          if(home === 'LAC' && g.away_team === 'IND') home = 'IND';
          if(away === 'LAC' && g.home_team === 'LV') away = 'LV';
          if(home === 'LAC' && g.away_team === 'LV') home = 'LV';
          // Apply mapping
          away = teamAbbrMap[away] || away;
          home = teamAbbrMap[home] || home;
          const awayCode = normalizeTeam(away);
          const homeCode = normalizeTeam(home);
          const id = awayCode && homeCode ? `${awayCode}-${homeCode}` : (g.game_id||JSON.stringify(g));
          const label = away && home ? `${away} @ ${home}` : (g.title||id);
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
  // Auto-invoke the fantasy loader because NFL schedule fetch failed —
  // populate the dropdown automatically so the user doesn't have to click.
  try{ if(typeof status === 'function') status('warn','NFL schedule not available; loading fantasy matchups from your leagues...'); }catch(e){}
  // fire-and-forget the async loader (it will remove the helper nodes when running)
  fantasyLoader().catch(()=>{});
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
  const preMap = entry.__preProj || null;
  const prev = await matchupPreview(league.league_id, week, league, users, rosters, g.players, projFn, myRoster.roster_id, myTeamName, preMap);
  // cache the preview so sidebar badge logic can reflect its findings without needing DOM inspection
  try{ g.leagues[league.league_id] = g.leagues[league.league_id] || {}; g.leagues[league.league_id].__lastPreview = prev; }catch(e){}
      // short league name: drop year if present at end
      const shortLeague = (league.name||'League').replace(/\s+\b(20\d{2})\b$/,'').trim();
  const leftScoreVal = (Number(prev.me.current_total) !== 0) ? Number(prev.me.current_total) : Number(prev.me.projected_total || 0);
  const rightScoreVal = (Number(prev.opponent.current_total) !== 0) ? Number(prev.opponent.current_total) : Number(prev.opponent.projected_total || 0);
  const leftScore = Number(leftScoreVal).toFixed(2);
  const rightScore = Number(rightScoreVal).toFixed(2);
  const myWins = leftScoreVal > rightScoreVal;
  const myScoreClass = myWins ? 'mc-score win' : (leftScoreVal < rightScoreVal ? 'mc-score lose' : 'mc-score');
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
  const preMap = entry.__preProj || null;
  const prev=await matchupPreview(league.league_id, week, league, users, rosters, players, projFn, myRoster.roster_id, myTeamName, preMap);

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
      // If this league is currently active in the UI, inspect the rendered matchup DOM for starter/bench dots
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

      // Decide whether to show a dot based on selected week vs current default week
      const selectedWeek = Number(week || (+($('#weekSelect')?.value || 1)));
      const defaultWeek = computeDefaultWeekByTuesday();
      // If selected week is prior to the current default week, show no dot
      if (selectedWeek < defaultWeek){
        dot.innerHTML = '';
        dot.title = '';
      } else {
        // Render a single dot according to priority: red > yellow > green
        dot.innerHTML = '';
        const single = el('span',{class:'ldot'});
        if (status.red) single.classList.add('red-active');
        else if (status.yellow) single.classList.add('yellow-active');
        else single.classList.add('green-active');
        dot.append(single);
        dot.title = status.red ? 'Starter issue' : (status.yellow ? 'Bench has better projected' : 'All starters OK');
      }
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
// Populate week options; accepts optional defaultWeek to preselect
function setWeekOptions(defaultWeek){
  const wk=$('#weekSelect'); if(!wk) return; wk.innerHTML='';
  for(let w=1; w<=18; w++){
    const o=el('option',{value:String(w), html:'Week '+w});
    if(defaultWeek && Number(defaultWeek)===w) { o.selected = true; o.setAttribute('selected','selected'); }
    wk.append(o);
  }
  // if no default selected, fallback to week 1
  if(!wk.querySelector('option[selected]')){
    const first = wk.querySelector('option[value="1"]'); if(first) { first.selected = true; first.setAttribute('selected','selected'); }
  }
  // Ensure the select's value reflects the default (some browsers/flows read .value not option[selected])
  try{ if(defaultWeek) wk.value = String(defaultWeek); }catch(e){}
  try{ console.log('[MFA] setWeekOptions defaultWeek=', defaultWeek, 'selectedValue=', wk.value); }catch(e){}
}
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
    // compact mini-score using cached preview if available
    let miniScore = el('div',{class:'mini-score'}, '');
    try{
      const cached = g.leagues[id] && g.leagues[id].__lastPreview;
  if (cached){
    const myCurNum = Number(cached.me.current_total||0);
    const oppCurNum = Number(cached.opponent.current_total||0);
    const myCur = myCurNum.toFixed(2);
    const oppCur = oppCurNum.toFixed(2);
    const myProj = Number(cached.me.projected_total||0).toFixed(2);
    const oppProj = Number(cached.opponent.projected_total||0).toFixed(2);
    // determine highlighted class using current score if present else projected
    const myValForWin = myCurNum !== 0 ? myCurNum : Number(cached.me.projected_total||0);
    const oppValForWin = oppCurNum !== 0 ? oppCurNum : Number(cached.opponent.projected_total||0);
    const myWin = myValForWin > oppValForWin;
    const myCls = myWin ? 'mini-my win' : (myValForWin < oppValForWin ? 'mini-my lose' : 'mini-my');
  // left: my boxed current with proj under the box (proj only shown when both currents are zero), center: vs, right: opponent current with proj under the box
  const myBoxL = el('div',{class:'mini-box ' + myCls}, [ el('div',{class:'mini-cur', html: myCur}) ]);
  const leftSide = el('div',{class:'mini-side mini-left'}, [ myBoxL ]);
  const rightBox = el('div',{class:'mini-box mini-op'}, [ el('div',{class:'mini-cur', html: oppCur}) ]);
  const rightSide = el('div',{class:'mini-side mini-right'}, [ rightBox ]);
  const topRow = el('div',{class:'mini-row'}, [ leftSide, el('div',{class:'mini-vs', html:'vs'}), rightSide ]);
  const showMiniProj = (myCurNum === 0 && oppCurNum === 0);
  if (showMiniProj) miniScore = el('div',{class:'mini-score'}, [ topRow, el('div',{class:'mini-proj-row'}, [ el('div',{class:'mini-proj-left mini-proj', html: myProj}), el('div',{class:'mini-proj-spacer'}), el('div',{class:'mini-proj-right mini-proj', html: oppProj}) ]) ]);
  else miniScore = el('div',{class:'mini-score'}, [ topRow ]);
      }
    }catch(e){ }
  const item=el('div',{class:'league-item'+(id===active?' active':''), 'data-id':id},[ titleWrapper, miniScore, dot ]);
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

    // Add projection debug button (helpful for troubleshooting mismatched projections)
    try{
      let dbg = document.querySelector('#projDebugBtn');
      if(!dbg){ dbg = el('button',{id:'projDebugBtn', class:'small', html:'Proj debug'}); dbg.style.marginLeft='8px'; $('#contextNote').parentNode.append(dbg); }
      dbg.onclick = ()=> showProjectionDebug(id);
    }catch(e){}

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

  // Matchup preview (use stored pre-week projection map so individual players show their pre-week proj)
  const preMap = (g.leagues[id] && g.leagues[id].__preProj) ? g.leagues[id].__preProj : null;
  const prev=await matchupPreview(league.league_id, week, league, users, rosters, g.players, projFn, myRoster.roster_id, myTeamName, preMap);
  renderMatchup($('#matchupSummary'), $('#myStarters'), $('#oppStarters'), prev);
    try{ g.leagues[id] = g.leagues[id] || {}; g.leagues[id].__lastPreview = prev; }catch(e){}
    // ensure sidebar mini-scores reflect the latest preview immediately
    try{ renderLeagueList(id); }catch(e){}

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
    // precompute matchup previews for each league so sidebar mini-scores render immediately
    const weekNow = +($('#weekSelect').value||1);
    await Promise.all(Object.values(g.leagues).map(async (entry) => {
      try{
        const { league, users, rosters } = entry;
        const season = +league.season;
        const myRoster = rosters.find(r=>r.owner_id===g.userId) || rosters[0];
        const myUser = users.find(u=>u.user_id===myRoster?.owner_id) || {};
        const myTeamName = myUser.metadata?.team_name || myUser.display_name || `Team ${myRoster?.roster_id}`;
        const scoring = league.scoring_settings||{};
  const proj = await projByPid(season, weekNow, 'regular', g.players, scoring);
  // store the initial pre-week projection map for later per-player preproj display
  entry.__preProj = Object.assign({}, proj);
  const projFn = (pid)=>proj[String(pid)]||0;
  const prev = await matchupPreview(league.league_id, weekNow, league, users, rosters, g.players, projFn, myRoster.roster_id, myTeamName, entry.__preProj);
  entry.__lastPreview = prev;
      }catch(e){ /* ignore per-league failures */ }
    }));
  // compute and apply default week based on current date / Tuesday rule
  const defaultWeek = computeDefaultWeekByTuesday();
  try{ console.log('[MFA] loadForUsername before setWeekOptions defaultWeek=', defaultWeek, 'currentSelect=', $('#weekSelect')?$('#weekSelect').value:undefined); }catch(e){}
  setWeekOptions(defaultWeek);
  try{ console.log('[MFA] loadForUsername after setWeekOptions selected=', $('#weekSelect')?$('#weekSelect').value:undefined); }catch(e){}
  showControls();

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
  // Refresh previews for all loaded leagues so sidebar mini-scores update immediately
  try{ if(typeof refreshLiveAll === 'function') await refreshLiveAll(false); }catch(e){ /* ignore */ }
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

  // recompute default week now that season changed
  const defaultWeek = computeDefaultWeekByTuesday();
  try{ console.log('[MFA] seasonMain change before setWeekOptions defaultWeek=', defaultWeek, 'currentSelect=', $('#weekSelect')?$('#weekSelect').value:undefined); }catch(e){}
  setWeekOptions(defaultWeek);
  try{ console.log('[MFA] seasonMain change after setWeekOptions selected=', $('#weekSelect')?$('#weekSelect').value:undefined); }catch(e){}
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
      let uname = ($('#username').value || '').trim();
      // allow refresh even when the username input is empty by falling back to g.userId
      if(!uname && g.userId) uname = g.userId;
      if(!uname){ status('err','No username to refresh. Enter a username first.'); return; }
      await refreshLiveAll(true);
    });
  }

  // Refresh live projections & matchups for all loaded leagues.
  async function refreshLiveAll(force = true){
    if(!g || !g.leagues) return;
    const weekNow = +($('#weekSelect').value||1);
    status('', 'Refreshing live projections…');
    try{
      g._forceFetch = Boolean(force);
      await Promise.all(Object.values(g.leagues).map(async (entry)=>{
        try{
          const { league, users, rosters } = entry;
          const season = +league.season;
          const myRoster = rosters.find(r=>r.owner_id===g.userId) || rosters[0];
          const myUser = users.find(u=>u.user_id===myRoster?.owner_id) || {};
          const myTeamName = myUser.metadata?.team_name || myUser.display_name || `Team ${myRoster?.roster_id}`;
          const proj = await projByPid(season, weekNow, 'regular', g.players, league.scoring_settings||{}, { force: Boolean(force) });
          const projFn = (pid)=>proj[String(pid)]||0;
          const preMap = entry.__preProj || null;
          const prev = await matchupPreview(league.league_id, weekNow, league, users, rosters, g.players, projFn, myRoster.roster_id, myTeamName, preMap);
          entry.__lastPreview = prev;
        }catch(e){ /* ignore per-league failures */ }
      }));

      try{ renderLeagueList(g.selected); }catch(e){}
      try{ await updateLeagueAlertBadges(weekNow); }catch(e){}

      // If user currently viewing a league, re-render it to pick up live values
      if (g.mode === 'league' && g.selected){ try{ await renderSelectedLeague(); }catch(e){} }

      status('ok','Live projections updated.');
    }catch(e){ console.error('refreshLiveAll failed', e); status('err','Live refresh failed'); }
    finally{ try{ g._forceFetch = false; }catch(e){} }
  }

  function startAutoRefresh(intervalMs = 60000){ try{ stopAutoRefresh(); g._autoRefreshInterval = intervalMs; g._autoRefreshId = setInterval(()=>{ refreshLiveAll(true).catch(()=>{}); }, intervalMs); }catch(e){} }
  function stopAutoRefresh(){ try{ if(g._autoRefreshId){ clearInterval(g._autoRefreshId); delete g._autoRefreshId; } }catch(e){} }
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
      if(id==='us-search'){ try{ buildPlayerSearchList(); }catch(e){} }
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

// ===== Player Search (User Summary tab) =====
let _playerSearchBuilt = false;
let _playerSearchIndex = [];
let _playerSearchLastQ = '';
let _playerSearchActive = -1;
function buildPlayerSearchList(){
  if(!g.players) return; if(_playerSearchBuilt) return;
  _playerSearchIndex = [];
  for(const [pid, meta] of Object.entries(g.players||{})){
    const pos = (meta.position||'').toUpperCase(); if(!['QB','RB','WR','TE','K','D/ST','DST','DEF'].includes(pos)) continue;
    const name = meta.full_name || (meta.first_name && meta.last_name ? `${meta.first_name} ${meta.last_name}` : (meta.last_name||''));
    if(!name) continue;
    const team = (meta.team||'FA').toUpperCase();
    _playerSearchIndex.push({ pid, name, pos: (pos==='D/ST'||pos==='DST')?'DEF':pos, team });
  }
  _playerSearchIndex.sort((a,b)=> a.name.localeCompare(b.name));
  _playerSearchBuilt = true;
  wirePlayerSearchEvents();
}
function wirePlayerSearchEvents(){
  const input = document.getElementById('playerSearchInput');
  const btn = document.getElementById('playerSearchBtn');
  const box = document.getElementById('playerSearchSuggest');
  if(!input || !btn || !box) return;
  if(btn && !btn._wired){ btn._wired=true; btn.addEventListener('click', ()=> runPlayerSearch(input.value.trim())); }
  if(input && !input._wired){
    input._wired = true;
    input.addEventListener('input', ()=> showPlayerSuggestions(input.value));
    input.addEventListener('keydown', (e)=>{
      if(box.classList.contains('hidden')){ if(e.key==='Enter'){ runPlayerSearch(input.value.trim()); } return; }
      if(e.key==='ArrowDown'){ e.preventDefault(); movePlayerSuggest(1); }
      else if(e.key==='ArrowUp'){ e.preventDefault(); movePlayerSuggest(-1); }
      else if(e.key==='Enter'){ e.preventDefault(); selectActivePlayerSuggest(); }
      else if(e.key==='Escape'){ hidePlayerSuggestions(); }
    });
    input.addEventListener('blur', ()=>{ setTimeout(()=> hidePlayerSuggestions(), 150); });
  }
}
function hidePlayerSuggestions(){ const box=document.getElementById('playerSearchSuggest'); if(box) box.classList.add('hidden'); _playerSearchActive=-1; }
function showPlayerSuggestions(q){
  const box = document.getElementById('playerSearchSuggest'); if(!box){ return; }
  _playerSearchLastQ = q;
  if(!q){ box.innerHTML=''; box.classList.add('hidden'); return; }
  const qq = q.toLowerCase();
  const matches = _playerSearchIndex.filter(p => p.name.toLowerCase().includes(qq)).slice(0,30);
  if(matches.length===1 && matches[0].name.toLowerCase()===qq){ // auto-run for exact
    hidePlayerSuggestions(); runPlayerSearch(matches[0].name, matches[0].pid); return;
  }
  box.innerHTML='';
  if(matches.length===0){ box.classList.add('hidden'); return; }
  for(let i=0;i<matches.length;i++){
    const m = matches[i];
    const opt = document.createElement('div'); opt.className='ps-option'; opt.setAttribute('role','option'); opt.dataset.pid=m.pid; opt.dataset.index=String(i);
    const nameSpan = document.createElement('span'); nameSpan.className='ps-name'; nameSpan.textContent = m.name;
    const metaSpan = document.createElement('span'); metaSpan.className='ps-meta'; metaSpan.textContent = `${m.pos} • ${m.team}`;
    opt.append(nameSpan, metaSpan);
    opt.addEventListener('mousedown', (e)=>{ e.preventDefault(); runPlayerSearch(m.name, m.pid); hidePlayerSuggestions(); });
    box.append(opt);
  }
  _playerSearchActive = -1;
  box.classList.remove('hidden');
}
function movePlayerSuggest(delta){
  const box=document.getElementById('playerSearchSuggest'); if(!box || box.classList.contains('hidden')) return;
  const opts = [...box.querySelectorAll('.ps-option')]; if(opts.length===0) return;
  _playerSearchActive += delta; if(_playerSearchActive < 0) _playerSearchActive = opts.length-1; if(_playerSearchActive >= opts.length) _playerSearchActive = 0;
  opts.forEach((o,i)=> o.classList.toggle('active', i===_playerSearchActive));
  const active = opts[_playerSearchActive]; if(active){ const r = active.getBoundingClientRect(); const br = box.getBoundingClientRect(); if(r.top < br.top) active.scrollIntoView({block:'nearest'}); else if(r.bottom > br.bottom) active.scrollIntoView({block:'nearest'}); }
}
function selectActivePlayerSuggest(){ const box=document.getElementById('playerSearchSuggest'); if(!box) return; const active = box.querySelector('.ps-option.active'); if(active){ runPlayerSearch(active.querySelector('.ps-name').textContent.trim(), active.dataset.pid); hidePlayerSuggestions(); } }
function fuzzyMatch(a,b){ return a.toLowerCase().includes(b.toLowerCase()); }
function findPlayerByName(name){ if(!name) return null; const lower=name.toLowerCase(); return _playerSearchIndex.find(p=>p.name.toLowerCase()===lower) || _playerSearchIndex.find(p=>p.name.toLowerCase().includes(lower)) || null; }
function runPlayerSearch(raw, forcedPid){
  const resC = document.getElementById('playerSearchResults'); const metaC = document.getElementById('playerSearchMeta');
  if(!resC || !metaC){ return; }
  resC.innerHTML=''; metaC.textContent='';
  if(!raw){ metaC.textContent='Enter a player name to search.'; return; }
  let found = null; if(forcedPid){ const meta = g.players && g.players[forcedPid]; if(meta) found = { pid: forcedPid, meta }; }
  if(!found) found = findPlayerByName(raw);
  if(!found){ metaC.textContent='No player matched that name.'; return; }
  const { pid, meta } = found;
  const pos = (meta.position||'').toUpperCase();
  let team = (meta.team||'FA');
  if(team===''||team==null) team='FA';
  const name = meta.full_name || (meta.first_name && meta.last_name ? (meta.first_name+' '+meta.last_name) : (meta.last_name || pid));
  metaC.innerHTML = `${name} • ${pos} • ${team}`;
  // Build league ownership rows
  const week = +($('#weekSelect')?.value||1);
  const rows = [];
  const myLeagues = [];
  const oppLeagues = [];
  const freeLeagues = [];
  for(const entry of Object.values(g.leagues||{})){
    const { league, rosters, users } = entry; const leagueName = league?.name || league?.league_id || 'League';
    const myRoster = rosters.find(r=>r.owner_id===g.userId);
    const rosterWith = rosters.find(r => (r.players||[]).includes(pid) || (r.starters||[]).includes(pid) || (r.taxi||[]).includes(pid));
    let state=''; let ownerName='';
    if(rosterWith){
      if(myRoster && rosterWith.roster_id === myRoster.roster_id){ state='Mine'; myLeagues.push(leagueName); }
      else {
        state='Opponent';
        const u = (users||[]).find(u=>u.user_id === rosterWith.owner_id) || {};
        ownerName = u.metadata?.team_name || u.display_name || (`Team ${rosterWith.roster_id}`);
        oppLeagues.push(`${leagueName} (${ownerName})`);
      }
    } else { state='Free'; freeLeagues.push(leagueName); }
    rows.push([leagueName, state, ownerName || '—']);
  }
  // Sort rows by state priority Mine > Opponent > Free
  const order = { 'Mine':0, 'Opponent':1, 'Free':2 };
  rows.sort((a,b)=> (order[a[1]]-order[b[1]]) || a[0].localeCompare(b[0]));
  const container = document.createElement('div');
  renderSortableTable(container, ['League','Status','Owner'], rows, ['str','str','str']);
  // Summary chips
  const summary = document.createElement('div'); summary.style.marginTop='8px'; summary.className='note';
  summary.innerHTML = `<b>Owned by you:</b> ${myLeagues.length} • <b>Owned by others:</b> ${oppLeagues.length} • <b>Free:</b> ${freeLeagues.length}`;
  resC.append(summary, container);
}

function computeDefaultWeekByTuesday(seasonStartDate){
  // seasonStartDate: Date for week 1 Tuesday boundary reference (if null, use Sept 1 of season year)
  const rawNow = new Date();
  // normalize to local date (no time) to avoid timezone surprises
  const now = new Date(rawNow.getFullYear(), rawNow.getMonth(), rawNow.getDate());
  // Find the season year from seasonMain if present, else default to current year
  const seasonSel = Number($('#seasonMain')?.value || (now.getFullYear()));
  // Default reference date: Sept 1 of season year
  const ref = seasonStartDate ? new Date(seasonStartDate) : new Date(seasonSel, 8, 1);
  // If explicit week transitions are provided by src/defaults.js, prefer them.
  try{
    const trans = (window.__sha_defaults && Array.isArray(window.__sha_defaults.weekTransitions)) ? window.__sha_defaults.weekTransitions : null;
    if(trans && trans.length>0){
      // find highest transition iso that is <= now
      const nowMs = now.getTime();
      let lastWeek = 1;
      for(const t of trans){
        const tMs = Date.parse(t.iso);
        if(Number.isNaN(tMs)) continue;
        if(nowMs >= tMs) lastWeek = Math.max(lastWeek, Number(t.week)||lastWeek);
      }
  try{ console.log('[MFA] computeDefaultWeekByTuesday using transitions, now=', now.toISOString(), 'lastWeek=', lastWeek); }catch(e){}
  return Math.min(Math.max(1, lastWeek), 18);
    }
  }catch(e){ /* fall back */ }

  // Fallback: Find the first Tuesday on or after ref (inclusive)
  const firstTue = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  while(firstTue.getDay() !== 2) firstTue.setDate(firstTue.getDate() + 1);
  if(now < firstTue) return 1;
  // Count how many Tuesdays (including firstTue) have occurred up to 'now'
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysSinceFirst = Math.floor((now - firstTue) / msPerDay);
  const tuesdaysElapsed = Math.floor(daysSinceFirst / 7);
  const week = 1 + tuesdaysElapsed;
  return Math.min(Math.max(1, week), 18);
}

function init(){
  $('#appLayout').classList.add('hidden'); $('#landing').classList.remove('hidden');
  // compute default week based on Tuesday boundary rule
  const defaultWeek = computeDefaultWeekByTuesday();
  setWeekOptions(defaultWeek);
  wireEvents();
  // Diagnostic: report whether explicit defaults file loaded and how many transitions it provided
  try{ console.log('[MFA] __sha_defaults present=', !!window.__sha_defaults, 'weekTransitionsLen=', (window.__sha_defaults && window.__sha_defaults.weekTransitions ? window.__sha_defaults.weekTransitions.length : 0)); }catch(e){}
  console.log('[MFA] ready — default week:', defaultWeek);
}
window.addEventListener('DOMContentLoaded', init);