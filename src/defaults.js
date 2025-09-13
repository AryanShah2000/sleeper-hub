// Explicit week transition defaults (user-specified times)
// This file builds a list of transition ISO timestamps for week rollovers.
// Times are stored in UTC. The user requested that on 2025-09-09 at 01:00 AM Eastern
// the app should switch to week 2, on 2025-09-16 01:00 AM Eastern switch to week 3, etc.
(function(){
  // Eastern in Sept 2025 is UTC-4 (EDT). 01:00 EDT == 05:00Z
  const baseIso = '2025-09-09T05:00:00Z'; // week 2 transition
  const baseMs = Date.parse(baseIso);
  const transitions = [];
  // generate week transitions from week 2 up to week 18 (one week apart)
  for(let w=2; w<=18; w++){
    const ms = baseMs + (w-2) * 7 * 24 * 60 * 60 * 1000;
    transitions.push({ week: w, iso: (new Date(ms)).toISOString() });
  }
  window.__sha_defaults = window.__sha_defaults || {};
  window.__sha_defaults.weekTransitions = transitions;
})();
