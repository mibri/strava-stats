# Dashboard feature guide

What each part of the dashboard shows and where the numbers come from. The
[changelog](#changelog) at the bottom lists what changed and when.

The dashboard has six tabs. Press <kbd>1</kbd>–<kbd>6</kbd> to switch between them, or
<kbd>?</kbd> to see every shortcut.

| Tab | What it's for |
|---|---|
| **Overview** | Lifetime totals, this week / month / year against the previous one, weekly mileage, the training calendar, fun facts, photos |
| **Progression** | Trends over a chosen timeframe: volume, fitness/fatigue/form, load balance, aerobic and hill efficiency, pace by type, durability, cadence, heat, race predictions, HR zones |
| **Records** | Trophy case, streaks, pace curve, PR timeline, superlatives, distance mix, pace against distance |
| **Years** | Year-over-year running totals, a year-in-review for any year, and a month-by-year heatmap |
| **Runs** | A sortable, filterable table of every run, with totals and a compare mode |
| **Map** | Every GPS route, region picker, photo pins, repeated segments, and the draw-a-segment tool |

---

## Overview

- **At a glance.** This week, this month and this year so far, each compared with the
  same stretch of the previous period. For example, "this month" on the 12th is compared
  with the 1st–12th of last month. If your data stops more than 45 days before today (an
  old export, or the sample), everything is measured up to your last run instead, and the
  card says "as of your last run".
- **Training calendar.** One grid per year, GitHub style. The **Miles / Time / Climb /
  Effort** buttons change what the shading measures. Colors are scaled to your 98th
  percentile day, so one very long day doesn't make every other day look pale. Click a
  day to open its run.

## Records

Everything on this tab is calculated in the browser from `summary.points` and the runs
table. None of it needs a pipeline change.

- **Trophy case.** Your fastest time at every best-effort distance from 400 m to the
  marathon, found in the fastest stretch of any run (the same "best efforts" as the run
  detail). Each card also shows the current year's best, or ★ if the all-time record was
  set this year.
- **Streaks.** The current and longest runs of consecutive days, and of consecutive weeks
  with at least one run. Also the longest break and the share of days with a run. A
  streak counts as current if your last run was today or yesterday (for weeks: this week
  or last week).
- **Pace curve.** For each distance, the fastest pace you've held for that distance.
  You can overlay all-time, the last 365 days, the last 90 days, and each calendar year.
  A flat curve means you hold pace well as the distance grows. The gap between the
  "all-time" and "last 90 days" lines shows how far you are from your best shape at each
  distance.
- **PR moments.** Every time a best was lowered, by distance. Bigger stars mean bigger
  improvements. Hover a star to see the old and new times.
- **Superlatives.** Longest run, longest time on feet, most climbing, fastest run of at
  least 5 and at least 10 miles, hardest effort, hottest, coldest, earliest and latest
  start, biggest week and biggest month. The earliest start ignores runs that start
  before 3 am, so a midnight run doesn't count as your earliest.
- **Distance mix.** A histogram of run distances, stacked by run type.
- **Pace vs. distance.** Every run by how far and how fast, colored and shaped by type.

## Years

- **Year over year.** A running total for each calendar year on one shared Jan–Dec axis,
  so you can see whether you're ahead of last year. Switch between miles, hours, climb
  and runs. The headline gives this year's total, the difference from last year at the
  same date, and a straight-line projection to Dec 31. Your first year starts at your
  first run, not on Jan 1.
- **Year in review.** Pick any year to see its totals with changes from the year before.
  For the current year, it's compared with last year up to the same calendar day, so a
  partial year isn't measured against a full one. It also includes a short written
  summary (miles in marathons, favorite day and hour, biggest month, longest run, bests
  set that year), the run-type mix, monthly miles against the previous year, and a
  day-of-week × start-hour heatmap of when you ran.
- **Month by month.** A heatmap with one row per year and one column per month, labeled
  with miles. Months before your first run or after today are left blank rather than
  shown as zero.

## Runs

- Filter by text (name, notes, or date such as `2025-06`), run type and year. Click a
  column header to sort. An arrow shows the sort column and direction.
- A **Total** row gives the distance, moving time, average pace and time-weighted
  average HR of whatever rows are currently shown. For example, filter to 2025 long runs
  to see those totals.
- **⇄ Compare** turns on selection checkboxes. Pick two runs and a bar appears at the
  bottom with a "Compare →" button.

## Run detail

Opens from any chart dot, table row, calendar day, trophy or photo.

- **‹ Older / Newer ›** (or <kbd>←</kbd> <kbd>→</kbd>) steps through your runs in date order.
- **Context badges** say how the run ranks. For example: "3rd longest run ever", "Most
  climbing ever", "All-time best 5k, 10k", "2026's best Half", or "Faster than 85% of
  similar easy runs". Similar means the same type and within ±50% of the distance.
- **Time in heart-rate zones** comes from the HR stream, using the same zones as the
  Progression chart. Gaps over 30 s (pauses) are capped so they don't inflate a zone.
- **Route coloring.** Color the route by:
  - **Pace**, relative to this run's median. Orange is faster, blue is slower, gray is
    about median.
  - **Heart rate**, in zone colors.
  - **Grade**, in the same colors as the terrain bar: blue is downhill, orange is uphill.
    Steep means 8% or more.

  Coloring uses the full-resolution trajectory (`traj`). Grade uses elevation resampled
  onto that trajectory and measured over about 50 m.
- **Hover sync.** Hovering the pace, HR or elevation chart moves a marker to that point
  on the map.
- **⇄ Compare with…** (or <kbd>c</kbd>) opens the compare picker.

## Compare two runs

Built from [`docs/design/compare-runs.md`](design/compare-runs.md).

- **The picker** ranks every other run. Runs on the same route come first, then runs of
  similar distance, with the same run type as a tiebreak. Route overlap is the share of
  each route's points within 40 m of the other route, taking the smaller of the two
  shares. It's calculated from the map geometry that's already loaded, so no extra files
  are fetched. Type in the search box to find a specific run by name, date or type.
- **The compare view** puts the older run as **A** (orange) and the newer as **B**
  (purple). It shows:
  - a stat table with B − A differences. Green means better (faster, lower HR, higher EF).
  - a **time gap** chart: at equal distance, how far ahead or behind B was. The area is
    shaded in the color of whoever was ahead.
  - pace, heart-rate and elevation overlays.
  - both routes on one map, with markers that follow your hover.
  - mile splits side by side.
  - a **By distance / By time** toggle. By time, the gap becomes "how far apart you'd be
    at the same moment".
  - "change B" to pick a different run for B.

## Links and shortcuts

Every view has its own URL, so you can bookmark or reload it, and Back works as you'd
expect:

| URL | View |
|---|---|
| `#records`, `#years`, … | a tab |
| `#run/<id>` | a run |
| `#compare/<idA>/<idB>` | a comparison |
| `#pick/<id>` | the compare picker for a run |

Back closes an open run or comparison. The ✕ button and <kbd>Esc</kbd> do the same.

| Key | Action |
|---|---|
| <kbd>1</kbd>–<kbd>6</kbd> | switch tab |
| <kbd>/</kbd> | search runs |
| <kbd>t</kbd> | light / dark |
| <kbd>←</kbd> <kbd>→</kbd> | previous / next run (in a run) |
| <kbd>c</kbd> | compare with… (in a run) |
| <kbd>Esc</kbd> | close |
| <kbd>?</kbd> | shortcut help |

## Where the code lives

| File | Role |
|---|---|
| `web/analytics.js` | Pure calculations: streaks, best-effort tables, pace curve, PR timeline, superlatives, year-over-year series, year summaries, punch card, HR-zone time, run alignment (`resample`, `alignRuns`), route similarity. No DOM, so it's unit tested in Node. |
| `web/insights.js` | Renders the Records and Years tabs and the Overview "at a glance" card. |
| `web/compare.js` | The compare picker and compare view. |
| `web/app.js` | Boot, tabs and hash routing, keyboard shortcuts, Overview, Progression, the Runs table, run detail and the map. |
| `tests/web/analytics.test.js` | Unit tests. Run with `node --test` (Node 18 or later, no dependencies). |

**Data contract addition:** each row in `summary.points` now carries `be`, that run's
best efforts as `{label: seconds}`. For example: `{"1 mi": 402.9, "5k": 1317.0}`. Both
pipelines emit it (`pipeline/build.py::_run_points` and `web/build/summary.js::runPoints`).
Builds made before this change don't have it, so the dashboard falls back to
`pr_progression`, which only covers the five race distances. Re-run the pipeline to fill
in every distance.

---

## Changelog

### 2026-09-29: Records, Years, Compare

- New **Records** tab: trophy case, streaks, pace curve, PR moments, superlatives,
  distance mix, pace vs. distance.
- New **Years** tab: year-over-year running totals with a pace projection, year in
  review, month-by-year heatmap.
- **Overview:** an "at a glance" card (this week / month / year against the previous
  one), and calendar shading by miles, time, climb or effort.
- **Run detail:** older/newer navigation, context badges, time-in-zones bar, route
  colored by pace, HR or grade, and chart-to-map hover sync.
- **Compare two runs:** picker ranked by route overlap, time-gap chart, overlays, side-by-side
  splits, both routes on one map. Implements `docs/design/compare-runs.md`.
- **Runs table:** year filter, totals row, sort arrows, compare mode.
- **App:** URL routing for tabs, runs and comparisons, so Back closes the modal. Also
  keyboard shortcuts with a help dialog, and a phone-width layout for six tabs.
- **Pipeline:** `summary.points[].be` (compact per-run best efforts) in both the Python
  and in-browser builds. The bundled sample was updated to include it.
- **Tests:** the first unit tests (`tests/web/analytics.test.js`) and a GitHub Actions
  workflow that runs them.

## Ideas for next time

These are not built yet. They're roughly ordered by how much they'd add compared with
the effort.

- **Goal tab.** The trophy case and pace curve now have per-distance bests for every
  run, which is the `be` data `docs/design/goal-tab.md` needs for projecting any distance.
- **Shoe / gear mileage.** The export's `Activity Gear` column isn't read yet. Adding it
  would allow a mileage-per-shoe chart with a retirement warning.
- **Weather.** Pace-adjusted-for-heat trends. The data is in the CSV, but only for
  export rows, not API rows.
- **Route "familiarity" map.** Shade each street by how many times you've run it, using
  the same grid hash as route similarity.
- **Printable / shareable year-in-review card.** An image export of the Years tab.
- **Compare more than two runs:** for example, every effort on a repeated segment laid
  over each other on one chart.
