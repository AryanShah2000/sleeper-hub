// utils: DOM helpers and small utilities (copied from app.js)

// Team abbreviation normalization map (attach to window to avoid duplicate-declaration across script splits)
window.TEAM_ABBREV_NORMALIZE = window.TEAM_ABBREV_NORMALIZE || {
  'JAC':'JAX','JAC.':'JAX','WAS':'WAS','WSH':'WAS','LAR':'LAR','LA':'LAR','STL':'LAR','SF':'SF','SFO':'SF',
  'KC':'KC','KAN':'KC','NE':'NE','NWE':'NE','NYG':'NYG','NYJ':'NYJ','NYJ':'NYJ','GB':'GB','GNB':'GB',
  'TB':'TB','TBB':'TB','NO':'NO','NOR':'NO','DAL':'DAL','DAL.':'DAL','PHI':'PHI','PHI.':'PHI',
  'BUF':'BUF','BUF.':'BUF','CIN':'CIN','CIN.':'CIN','BAL':'BAL','BAL.':'BAL','PIT':'PIT','PIT.':'PIT',
  'CLE':'CLE','CLE.':'CLE','HOU':'HOU','HOU.':'HOU','IND':'IND','IND.':'IND','TEN':'TEN','TEN.':'TEN',
  'JAX':'JAX','MIA':'MIA','MIA.':'MIA','CAR':'CAR','CAR.':'CAR','LAC':'LAC','LAC.':'LAC','DEN':'DEN','DEN.':'DEN',
  'DET':'DET','DET.':'DET','ATL':'ATL','ATL.':'ATL','CHI':'CHI','CHI.':'CHI','LV':'LV','LVR':'LV','ARI':'ARI','ARI.':'ARI','SEA':'SEA','SEA.':'SEA'
};

(function(){
  function normalizeTeam(abbr){ if(!abbr) return abbr; const a = String(abbr).toUpperCase(); return (window.TEAM_ABBREV_NORMALIZE || {})[a] || a; }

  // Tiny DOM helpers + cache
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

  // date/age helpers
  function parseBD(meta){ for (const k of ['birth_date','birthdate','birthDate']){ const raw=meta?.[k]; if(!raw) continue; const d=new Date(String(raw).slice(0,10)); if(!isNaN(d)) return d; } return null; }
  function ageFrom(d){ const now=new Date(); let a=now.getFullYear()-d.getFullYear(); const m=now.getMonth()-d.getMonth(); if(m<0||(m===0&&now.getDate()<d.getDate())) a--; return a; }
  function age(meta){ if (meta?.age!=null){ const n=+meta.age; if (Number.isFinite(n)&&n>0) return Math.floor(n);} const bd=parseBD(meta); return bd?ageFrom(bd):null; }

  // expose as window utils for convenience
  window.__sha_utils = { normalizeTeam, $, el, escapeHtml, status, TTL, ck, parseBD, ageFrom, age };

  // Preserve original global helper names for compatibility with existing code
  try{
    window.$ = window.$ || $;
    window.el = window.el || el;
    window.escapeHtml = window.escapeHtml || escapeHtml;
    window.status = window.status || status;
  }catch(e){}
})();

