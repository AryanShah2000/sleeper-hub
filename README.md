# Sleeper Hub (My Fantasy Agent)

A single‑page client (no build step) that helps a Sleeper fantasy football user manage and compare all of their leagues in one dashboard. Open `index.html` directly in a modern browser; all logic runs in the browser via `app.js` and public Sleeper API endpoints.

## File Overview

### `index.html`
Static HTML + embedded CSS defining the full UI layout and visual design:
- Landing screen that asks for a Sleeper username.
- Main two‑column layout (sidebar + main panel) with responsive grid.
- Sidebar: username input, season/week selectors (revealed after load), league list, user summary shortcut.
- Tabs for two modes:
  - User Summary (cross‑league views): Rooting Interest, Projections, Bye Count, Matchup Overview.
  - Selected League views: Roster, Team Projections (position strength), Opponent Projections (matchup breakdown), Bye Week Matrix (by position), Alerts (0‑projection starters + replacements), Waiver Wire (available players + projections + trending adds).
- Reusable status banner, tooltip container (created dynamically), tables, cards, and CSS utility classes.
- Includes a single `<script defer src="app.js"></script>` tag; there are no external JS/CSS dependencies.

### `app.js`
All application logic. Pure front‑end JavaScript (no frameworks) organized into functional sections:
- App State (`g`): caches players map, user id, loaded leagues, selected league, current mode, and a waiver position preference.
- DOM helpers: `$()` query shortcut and `el()` element factory used throughout for rendering.
- Fetch utilities with localStorage caching (3h TTL) to reduce API hits (`fetchJSON`).
- Sleeper API wrappers: user resolution, leagues listing, league bundle (league/users/rosters), players map.
- Projection + scoring pipeline: pulls Rotowire projections via Sleeper, normalizes PPR values, and re‑scores using league‐specific scoring settings to produce per‑player projected fantasy points.
- Optional weekly stats loader to replace projections with actual scores once games are underway.
- Roster + positional value math: builds per‑roster player rows, selects optimal starters by slot (including FLEX / SUPER_FLEX) to compute comparative team strength and percentile rankings.
- Bye week analytics: two matrix styles (across leagues; per position in one league) using static 2025 bye data plus player metadata.
- Exposure / Rooting Interest: cross‑league counts of players you roster vs players your opponents are starting in the current week; drives “Who to Root For/Against” tables with hover tooltips listing league names.
- Matchup previews: derives opponent roster for given week, builds starter projection tables, and creates summary cards for all leagues.
- Alerts system: flags starters with 0 projected points and suggests bench replacements at the same position (sortable tables inside collapsible details elements).
- Waiver Wire: filters unrostered projected players matching allowed positions; merges in 24h trending add counts; sortable & position‑filterable.
- Tooltip engine: lightweight custom hover bubble listing leagues for For/Against exposures.
- Event wiring: week & season selectors, league selection, tab navigation, landing flow, manual league add, “jump to waivers” links from alerts.
- Rendering helpers: generic sortable table builder, matchup tables, roster tables, positional strength tables, bye matrices, and matchup overview card grid.
- Initialization (`init` on DOMContentLoaded) seeds week selector, sets landing state, and wires events.

## Runtime Flow
1. User enters Sleeper username on landing screen.
2. `loadForUsername()` resolves user id, fetches leagues for chosen season, and for each league fetches metadata+users+rosters; players map fetched once.
3. User Summary view renders: exposures, projections, bye matrix, matchup overview, and alert badges (count of zero‑projection starters per league).
4. Selecting a league switches to league tabs; projections & matchup preview computed on demand for the chosen week.
5. Changing week or season triggers re-fetch or re-render with cached player data reused.

## Key Data Structures
- `g.players`: object keyed by Sleeper player id -> player metadata (position, team, names, bye).
- `g.leagues[id]`: `{ league, users, rosters }` bundle mirroring Sleeper API responses.
- Projection maps: plain object `pid -> projectedPoints` recomputed per league/week (because of league scoring).

## Caching Strategy
- Generic fetch wrapper stores JSON responses in `localStorage` with a timestamp; reused if under 3 hours old.
- Large player map benefits most from this; reduces initial load on repeat visits.

## Notable UI/UX Details
- All tables can sort (numeric, text, special bye/week parsing).
- Rooting tables show league lists in custom tooltips (accessible fallback: counts remain visible even without hover).
- Alerts badge dot on the league Alerts tab and numeric badges in sidebar next to each league after projections load.
- Waiver wire automatically preselects a position when user clicks a replacement link in Alerts.

## How to Run
No build step.
1. Clone or download the repository.
2. Open `index.html` in a modern desktop browser (Chrome, Edge, Firefox, Safari).
3. Enter a Sleeper username and choose View Leagues.

(If opening via local `file://` causes localStorage or fetch CORS warnings in some hardened browser setups, serve with a tiny static server.)

## Extensibility Ideas
- Add persistent user preferences (last week viewed, dark/light toggle variant).
- Support custom scoring overrides per league or alternative projection providers.
- Include player detail modal with recent trends and injury notes (additional API surface).
- Export exposures / bye matrix as CSV.
- Add offline cache invalidation UI and manual refresh.

## Privacy / API Notes
- Uses only public Sleeper endpoints; no auth tokens stored.
- All data stays in the browser; nothing is sent to any third‑party server besides Sleeper.

## License
(Choose & add a license if you plan to publish. Currently unspecified.)

---
Generated documentation summarizing `index.html` layout/styling responsibilities and `app.js` application logic.
