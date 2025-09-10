// projections: feedPPR, providerRows, rescored, projByPid, showProjectionDebug
(function(){
  const { el, $, escapeHtml, status } = window.__sha_utils || {};
  const PROVIDER = 'rotowire';
  function feedPPR(it) {
  const ks = ['ppr','pts_ppr','fantasy_points_ppr'];
  for (const k of ks) if (it?.[k] != null) return +it[k] || 0;
  const s = it?.stats || {};
  for (const k of ks) if (s?.[k] != null) return +s[k] || 0;
  return 0;
}
async function providerRows(season, week, season_type, opts = {}) {
  const url = `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=${season_type}&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=ppr`;
  const raw = await window.__sha_api.fetchJSON(url, opts);
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

async function showProjectionDebug(leagueId){
  try{
    const entry = g.leagues[leagueId]; if(!entry) { status('err','League not in memory for debug'); return; }
    const { league } = entry; const season = +league.season; const week = +($('#weekSelect').value||1);
    status('', `Fetching provider rows for ${league.name} W${week}…`);
    const rows = await providerRows(season, week, 'regular');
    const proj = await projByPid(season, week, 'regular', g.players, league.scoring_settings||{});

    const tableRows = Object.keys(rows).map(pid=>{
      const r = rows[pid] || {};
      const pmeta = g.players && g.players[pid] ? g.players[pid] : {};
      const name = pmeta.full_name || (pmeta.first_name && pmeta.last_name ? `${pmeta.first_name} ${pmeta.last_name}` : (pmeta.last_name||pid));
      const feed = (typeof feedPPR === 'function') ? feedPPR(r) : (r?.ppr||0);
      const resc = rescored(pid, rows, g.players, league.scoring_settings||{});
      const finalProj = proj[String(pid)] || 0;
      return [ name, pid, (r.company||''), (Number.isFinite(feed)?feed.toFixed(2):String(feed)), resc.toFixed(2), finalProj.toFixed(2) ];
    }).sort((a,b)=>parseFloat(b[5]) - parseFloat(a[5]));

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

  window.__sha_proj = { feedPPR, providerRows, rescored, projByPid, showProjectionDebug };

  try{
    window.feedPPR = window.feedPPR || feedPPR;
    window.providerRows = window.providerRows || providerRows;
    window.rescored = window.rescored || rescored;
    window.projByPid = window.projByPid || projByPid;
    window.showProjectionDebug = window.showProjectionDebug || showProjectionDebug;
  }catch(e){}
})();
