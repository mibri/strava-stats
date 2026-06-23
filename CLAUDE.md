# strava-stats — notes for Claude

Personal running analytics + LLM coach over a Strava export. Single user, runs locally.

## Architecture
- `pipeline/` — Python. `python -m pipeline.build` reads `data/activities.csv` +
  `data/activities/<tracks>`, filters to **runs only**, converts to **imperial
  (miles, min/mile, feet)**, derives metrics, and writes `data/clean/`.
  - `tracks.py` parses `.fit`, `.fit.gz`, `.gpx` into a uniform record stream.
  - `metrics.py` — best efforts, mile splits, stream downsampling, Riegel.
  - `build.py` — orchestrator + run classification + aggregates.
  - `coach_context.py` — writes `coach/coach_context.md`.
  - `strava_api.py` — stub for future live sync (keep the export-compatible contract).
- `web/` — static dashboard (vanilla JS + Plotly + Leaflet). `python web/serve.py`
  serves repo root so the page can fetch `../data/clean/*`. No build step.
- `coach/` — `goal.md` (hand-edited), `coach_context.md` (generated),
  `conversations/` (coach memory). The `/coach` command is in `.claude/commands/`.

## Conventions
- Units are imperial everywhere user-facing. Pace = seconds/mile internally,
  formatted `m:ss`. Pace charts use a reversed, outlier-clipped axis (`paceAxis`).
- Run types: easy / long / workout / recovery / race. Names are generic ("Morning
  Run"), so classification is **data-driven** (trailing pace baseline + within-run
  surge detection) with name/description keywords as override. See `classify_runs`.
- Stream/detail files are keyed by **Activity ID**, not the track filename (they differ).
- Strava's `Activity Date` is **UTC**; the pipeline localizes each run to its GPS
  start timezone (`localize_dates`, uses `timezonefinder`) so time-of-day is correct
  even on trips. Runs without GPS fall back to the home timezone.
- The athlete trains in multiple cities (SF home + travel). `regions.py` clusters
  routes (~0.7°) and reverse-geocodes each via Nominatim (cached to
  `data/geocode_cache.json`; needs network only on first run). `core` bounds are
  percentile-trimmed for a tight default map view.
- `summary.json` carries everything the dashboard needs: `points` (one rich,
  clickable row per run incl. `ef`, `ef_gap`, `cadence`, `decoup`), `daily_miles`,
  `patterns`, `hr_zones`, `marathon_projection` (Riegel), `fitness` (CTL/ATL/TSB/ACWR),
  `regions`, `photos`.

## Don't
- Don't commit anything under `data/` (private export, gitignored).
- Don't add an in-browser LLM chatbox — the coach intentionally runs via Claude Code
  on the user's subscription (no API key). An in-page chat would require the Anthropic API.
