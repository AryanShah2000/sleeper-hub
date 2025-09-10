// rosters: roster helpers, bye matrices, exposures
(function(){
  const { el, $, escapeHtml, age } = window.__sha_utils || {};

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

const BYE_2025={ATL:5,CHI:5,GB:5,PIT:5,HOU:6,MIN:6,BAL:7,BUF:7,ARI:8,DET:8,JAX:8,LV:8,LAR:8,SEA:8,CLE:9,NYJ:9,PHI:9,TB:9,CIN:10,DAL:10,KC:10,TEN:10,IND:11,NO:11,DEN:12,LAC:12,MIA:12,WAS:12,CAR:14,NE:14,NYG:14,SF:14};
function teamBye(team, season){ return season==2025 ? BYE_2025[team] : null; }
function rosterRecord(roster){ const s = roster?.settings || {}; const w = Number.isFinite(+s.wins)   ? +s.wins   : 0; const l = Number.isFinite(+s.losses) ? +s.losses : 0; const t = Number.isFinite(+s.ties)   ? +s.ties   : 0; return t > 0 ? `(${w}-${l}-${t})` : `(${w}-${l})`; }

  // expose
  window.__sha_rosters = { rosterPids, rosterRows, selectBest, teamPosValues, rankPct, teamBye, rosterRecord, byeMatrixByPosition: window.byeMatrixByPosition, byeMatrixAcrossLeagues: window.byeMatrixAcrossLeagues };

  try{
    window.rosterPids = window.rosterPids || rosterPids;
    window.rosterRows = window.rosterRows || rosterRows;
    window.selectBest = window.selectBest || selectBest;
    window.teamPosValues = window.teamPosValues || teamPosValues;
    window.rankPct = window.rankPct || rankPct;
    window.teamBye = window.teamBye || teamBye;
    window.rosterRecord = window.rosterRecord || rosterRecord;
  }catch(e){}
})();
