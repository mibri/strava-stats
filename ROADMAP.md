# Roadmap

_Last revised 2026-09-16. This is the plan for taking strava-stats from a personal
marathon-build dashboard to a free, public "drop your Strava export" running analytics
product. Design docs for the harder items live in [`docs/design/`](docs/design/)._

## Where we are

- 2026-09-29: added Records and Years tabs, run-vs-run comparison, run-detail upgrades,
  URL routing and keyboard shortcuts, and the first unit tests. Summary and ideas are in
  [`docs/FEATURES.md`](docs/FEATURES.md).

- The SF Marathon (2026-07-26) is done. `coach/goal.md`, the hardcoded 3:45 goal line in
  `web/app.js` (`RACE_GOALS`), and `coach/coach_context.md` (generated 2026-07-28) are all
  still pointed at it.
- The in-browser pipeline (`web/build/`) is effectively at parity with the Python one:
  tracks, best efforts, splits, streams, classification, fitness curve, projections,
  segments and regions all run client-side. The only gaps are reverse-geocoded region
  names (browser regions are "Home" / "Area N") and weather/GAP, which come from the CSV
  in both paths anyway. The header comment in `web/build/pipeline.js` still says track
  parsing is "a later phase" and the README still calls the API sync a "stub". Both are stale.
- Unit tests cover the dashboard's pure analytics (`tests/web/`, `node --test`, in CI).
  There are still no pipeline tests or Python-vs-JS parity checks.
- Data is browser-only: IndexedDB per device, nothing survives a cleared cache or a new laptop.

## Constraints that shape the plan

1. **Public users upload their own bulk export; the app never talks to the Strava API on
   their behalf.** Strava's API Policy (effective 2026-06-01) prohibits using API data in
   any AI application, explicitly including "ingestion into a context window", and
   multi-athlete apps now need the paid Developer Program. A user's own bulk export is not
   API data, so the export path is the safe one and it's what the site already does.
   `pipeline/strava_api.py` stays a personal, local-only convenience.
2. **Free, no paid tiers.** Every hosted component must fit a free tier at the expected
   scale (hundreds of users, not hundreds of thousands). Static hosting + one managed
   backend for auth and storage.
3. **Bring-your-own LLM.** The coach keeps running through Claude Code on the user's own
   subscription. No in-app chat, no API keys, no server-side model calls.
4. **Runs only, imperial by default.** See open decision on a metric toggle below.
5. **No build step for the web app.** Vanilla JS + CDN libraries, deployable by copying
   `web/` to GitHub Pages.

## Phases

Sizes are rough: S = an afternoon, M = a few days, L = a week or two, XL = more.

### Phase 0 — Housekeeping (all S, do first)

- [ ] Replace the hardcoded marathon goal in `web/app.js` with a goal read from data
      (bridging step for the Goal tab; see `docs/design/goal-tab.md`).
- [ ] Rewrite `coach/goal.md` for the 5k target; regenerate `coach_context.md`.
- [ ] Fix the stale header in `web/build/pipeline.js` and the "stub" note in `README.md`.
- [ ] Surface track-parse failures: `worker.js` collects `failures` but `buildAll` drops
      them. Show a count and a per-file list on the import page.
- [ ] `/coach` warns when `coach_context.md` is stale; make the pipeline write a
      `generated_at` into `summary.json` so the dashboard can show the same warning.

### Phase 1 — Generalize for any runner (M–L total)

The dashboard has "me" baked in: one goal, one race distance, HR max estimated, the
home region assumed. This phase makes those per-user settings.

- [ ] **Settings model** (M): `{ goal, hr_max, home_region_name, plan }` stored in
      IndexedDB (local mode: `coach/goal.json` + `coach/plan.json`). A small settings sheet
      in the header. Design: `docs/design/goal-tab.md` §Settings.
- [ ] **Goal / race tab** (L): countdown, projection vs goal over time, required pace,
      readiness, and a post-race debrief once the goal date has passed.
      Design: `docs/design/goal-tab.md`.
- [ ] **Projections for any distance** (M): ~~emit compact per-run best efforts into
      `summary.points`~~ (done 2026-09-29: `points[].be`, both pipelines) so the client can
      project any goal distance (5k today, whatever next) without a rebuild. Remaining:
      the client-side `projectAt`. Part of the goal-tab design.
- [ ] **Named regions in the browser build** (S): let the user rename "Area 2" in the map
      sidebar; persist in settings. (Nominatim from the browser stays out.)

### Phase 2 — Public readiness (L–XL total)

- [ ] **Accounts + cloud save** (XL): Google sign-in through Supabase Auth, processed
      bundle saved to Supabase Storage, settings in one Postgres table under row-level
      security. Zero IAM code of our own. Works fully without an account; signing in adds
      cross-device sync and backup. Design: `docs/design/accounts-and-cloud-save.md`.
- [ ] **Mobile layout** (L): bottom tab bar, card-based runs list, sheet-style run detail,
      touch-safe map and draw tool. Design: `docs/design/mobile-layout.md`.
- [ ] **Onboarding** (M): landing state with the sample dataset one click away, clear
      "how to get your export" steps (already on import page), progress with ETA for large
      exports, and a privacy statement ("your zip never leaves the browser; if you sign in,
      only derived stats are stored").
- [ ] **Error reporting** (S): a "copy debug info" button on the import page and an
      opt-in `console` dump. No third-party telemetry.
- [ ] **Delete my data** (S once accounts exist): one button wipes storage + settings.

### Phase 3 — Training features (L–XL total)

- [ ] **Planned vs actual** (L): a structured weekly plan (authored in-app, or by the
      coach in local mode) rendered against the calendar, with per-workout hit/miss and
      weekly compliance. Design: `docs/design/planned-vs-actual.md`.
- [x] **Compare two runs** (L): overlay pace/HR/elevation by distance, cumulative time
      gap, side-by-side splits, both routes on one map with same-route detection.
      Design: `docs/design/compare-runs.md`. Shipped 2026-09-29 (`web/compare.js`).
- [ ] **Coach reads the plan** (S, local mode only): `coach_context.md` gains a
      "last week: planned vs actual" table and `/coach` learns the plan schema so it can
      write next week's plan.

### Phase 4 — Data plumbing (M–L total)

- [ ] **Parity test suite** (L): one synthetic fixture export, golden outputs, and a
      Python-vs-JS comparison with tolerances. Node's built-in test runner for JS, pytest
      for Python, both in a GitHub Actions `test` workflow that gates the Pages deploy.
      Design: `docs/design/pipeline-parity-and-tests.md`.
- [ ] **Import diagnostics** (S): parse-time report (runs found, tracks parsed, tracks
      failed, runs without GPS, runs without HR) saved with the build and shown on the
      overview when non-trivial.
- [ ] **Local auto-sync** (S, personal only): a launchd/cron recipe for
      `python -m pipeline.strava_api --build`. See the API-policy note under decisions.
- [ ] **Bundle export/import** (S): "download my data" as a single `.json.gz` and re-import
      it without re-parsing. Doubles as the offline backup for people who don't sign in,
      and it's the same format the cloud save uses.

### Phase 5 — More data viz (ideas, unsized)

Shipped 2026-09-29: Records tab, Years tab, calendar metrics, route coloring, context
badges. Next candidates (see `docs/FEATURES.md` § Ideas): shoe/gear mileage, heat-adjusted
pace trend, a street-familiarity map, a shareable year-in-review image, and many-effort
overlays for repeated segments.

### Later / explicitly not doing

- No in-app chat or hosted LLM (constraint 3).
- No Strava API for public users (constraint 1).
- No cycling or multi-sport (decided: runs only).
- No native apps; the mobile layout is the mobile story.
- No social or leaderboard features; every user sees only their own data.

## Decisions I need from you

These change the work materially, so I haven't assumed an answer.

1. **Metric toggle.** The codebase is imperial end to end (constraint 4). A public
   product will get asked for km and min/km on day one. Options: (a) ship imperial-only
   and say so; (b) add a display-only toggle (format at render time, storage stays
   imperial; ~M, touches every chart and table). I'd do (b) in Phase 1 but it's a real
   chunk of UI work and you said you're picky about scope.
2. **HR max.** Today zones use an estimated max. Options: user-entered in settings
   (simple, accurate for people who know it) vs. estimated as the 99th percentile of per-run max HR (today's rule), which is
   no input needed but wrong for people who never race. I'd do user-entered with the
   estimate as the default.
3. **Sign-in providers.** Google only, or Google + GitHub + email magic link? Each extra
   provider is a Supabase toggle, not code, but it's more UI. I'd start with Google + magic
   link (covers everyone without a password).
4. **Photos in cloud save.** Photos are ~20 MB per user and the most personal thing in
   the export. I'd keep them local-only by default with an opt-in "also back up photos".
5. **Personal API sync and the coach.** Strava's policy now says API data may not be put
   into an LLM context window. Your local `strava_api.py` path feeds `coach_context.md`,
   which `/coach` reads. That's your own data in your own app, but it's technically
   against the API policy. Options: keep using exports for anything the coach reads and
   use API sync only for the dashboard; or use Strava's official MCP (personal use is
   allowed) for coaching questions. Your call; I only need to know whether to keep
   promoting the API path in the README.
6. **Hosting.** GitHub Pages works. Cloudflare Pages would give a custom domain, a
   built-in redirect for the OAuth callback, and the option of Workers later. Not needed
   for anything in this roadmap; flagging in case you want a domain.

## Suggested order

Phase 0 → Goal tab + settings (Phase 1) → Accounts (Phase 2) → Parity tests (Phase 4)
→ Mobile → Planned vs actual → Compare runs.

Accounts before mobile because cloud save changes the import flow that mobile has to lay
out. Tests before the training features because those add a second data source (the plan)
to both pipelines, and parity drift is the most likely way this project rots.
