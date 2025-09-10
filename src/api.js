// api: fetch wrapper and Sleeper API helpers (copied from app.js)
(function(){
  const { $, el, status, TTL, ck } = window.__sha_utils || {};

  async function fetchJSON(url, opts = {}) {
    const now = Date.now();
    const force = Boolean(opts && opts.force) || (typeof g !== 'undefined' && g._forceFetch);
    if (!force) {
      try {
        const c = localStorage.getItem(ck(url));
        if (c) {
          const { ts, data } = JSON.parse(c);
          if (now - ts < TTL) return data;
        }
      } catch {}
    }

    let fetchUrl = url;
    if (force) {
      const sep = url.includes('?') ? '&' : '?';
      fetchUrl = `${url}${sep}_cb=${now}`;
    }

    const r = await fetch(fetchUrl, force ? { cache: 'no-store' } : undefined);
    if (!r.ok) throw new Error(`${r.status} for ${url}`);
    const data = await r.json();
    try { localStorage.setItem(ck(url), JSON.stringify({ ts: now, data })); } catch {}
    return data;
  }

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

  window.__sha_api = { fetchJSON, resolveUserId, loadMyLeagues, loadLeagueBundle, loadPlayersMap };

  // Preserve original global names for backward compatibility with app.js
  try{
    window.fetchJSON = window.fetchJSON || fetchJSON;
    window.resolveUserId = window.resolveUserId || resolveUserId;
    window.loadMyLeagues = window.loadMyLeagues || loadMyLeagues;
    window.loadLeagueBundle = window.loadLeagueBundle || loadLeagueBundle;
    window.loadPlayersMap = window.loadPlayersMap || loadPlayersMap;
  }catch(e){}
})();
