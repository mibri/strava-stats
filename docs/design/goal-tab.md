# Design: Goal / race tab (and the settings model)

_Status: proposed · Size: L · Depends on: nothing; unblocks Planned vs actual and Accounts
(both store into the settings object defined here)_

## Summary

Replace the hardcoded SF Marathon with a per-user goal, give it its own tab, and let the
projection engine target any distance. Once the goal date passes, the same tab becomes a
race debrief. This is the first "generalize for other people" change, so it also
introduces the settings object every later feature writes into.

## Goals

- A user can set "5k on 2026-11-08, target 20:30" in the UI and see: days left, current
  projected time at that distance, the gap, required pace, and how the projection has
  trended.
- Multiple goals, one primary. Past goals stay as debriefs.
- No rebuild needed when the goal changes.
- In local mode, `/coach` reads the same structured goal.

## Non-goals

- Generating a training plan from the goal (Planned vs actual is authored, not generated).
- Weather or course-specific adjustments.

## Settings model

One object, stored in IndexedDB `meta.settings` (public) and in `coach/settings.json`
for local mode (gitignored, hand-edited or coach-edited). Later synced by Accounts.

```json
{
  "version": 1,
  "hr_max": 193,
  "goals": [
    { "id": "g_5k26", "name": "Turkey Trot 5k", "distance_m": 5000, "date": "2026-11-26",
      "target_s": 1230, "primary": true }
  ],
  "regions": { "1": "Marin" },
  "plan": { "version": 1, "workouts": [] }
}
```

- `distance_m` is a number so custom distances work; the UI offers 1 mi / 5k / 10k /
  half / marathon presets plus a custom field (mi or km entry, stored in meters).
- `hr_max` replaces the estimated max in the HR-zone chart when set. Default is the
  current estimate.
- `coach/goal.md` stays as the prose profile (constraints, injury history, coaching
  style). The pipeline's `coach_context.py` reads `settings.json` and writes a
  "Goal" section from it so the two files can't disagree about the target.

A settings sheet opens from a gear button in the header (next to the theme toggle).
Sections: Goals (list, add, set primary), HR max, Regions (rename), and later Units.

## Projections for any distance

Today `_fitness_projection` (Python) and `fitnessProjection` (JS) emit per-date
projections for five fixed labels. The goal can be any distance and can change after the
build, so the client needs to compute the projection itself.

Change: add each run's compact best efforts to `summary.points` as
`be: { "1000": 251.2, "1609": 402.9, "5000": 1317, "10000": 2713, "21097": 6370 }`
(meters → seconds, only distances the run covered). That's ≤ 8 numbers per run.
`projections` stays in `summary.json` for the existing race chart, but the Goal tab calls
`projectAt(points, distance_m, date)` in `web/build/project.js`, which is a line-for-line
port of the Python logic (90-day window, per-date personalized exponent clamped to
1.00–1.18, 4× distance band, keep the fastest equivalent). The Python function is then
refactored to call the same steps so the parity test can compare them.

Once this exists the race chart's five-label projection could also be computed
client-side and `projections` dropped from `summary.json`. Not required for this feature.

## Tab layout

Tab label is the goal name (falls back to "Goal"). Hidden entirely if there are no
goals; the settings sheet is where you create the first one.

### Upcoming goal

1. **Header strip**: name, date, "N days" countdown, target time, target pace.
2. **Readiness tiles** (the `stat-grid` style):
   - Projected time now (from `projectAt` on the latest run date) and Δ vs target,
     coloured green/amber/red at ±1% / ±4%.
   - Required pace vs best recent pace at ≥ ⅓ of the goal distance.
   - Form (TSB) today, with the plain-English read the coach context already uses.
   - Weeks of data behind the projection (so a 3-week-old account sees "low confidence").
3. **Projection vs target chart**: the projection series for this distance over the last
   26 weeks, target as a dashed line, goal date as a vertical marker. Same style as the
   race chart; reuse `drawRaces`' layout but goal-driven.
4. **Goal-pace work**: runs in the last 8 weeks with at least ⅓ of the goal distance run
   within ±3% of target pace (from mile splits, contiguous). Table: date, run, distance
   at pace, avg HR at pace. This is the "have you actually touched race pace" check.
5. **Taper / load**: last 12 weeks of volume as small bars with the goal date marked,
   and the ACWR band. No advice text; the coach does advice.

### Completed goal (debrief)

Shown when `date` < today. Find the race run: a run dated within ±1 day of the goal date
with distance within 5% of `distance_m`, preferring `type == race`. If none, show "No run
matched this goal" with a picker to choose the run manually (stores `run_id` on the goal).

1. **Result strip**: finish time (moving time; elapsed shown small), target, Δ, average
   pace, and the pre-race projection (projectAt on the day before) with its error. The
   projection error is the interesting number: it calibrates trust in the projections.
2. **Split chart**: mile splits as bars against the even-pace target line; positive /
   negative split label; first-half vs second-half pace and HR.
3. **Fade**: last 20% of the distance vs the middle 60% (pace and HR). Shown as one line.
4. **HR profile**: avg HR by quarter, % of `hr_max`. Highlights the "went out too hard"
   pattern without saying so.
5. **Plan adherence** (if a plan existed for the 8 weeks before): compliance % and
   planned vs actual miles, one line. Links to the compliance chart.

## Data flow

- Public: settings from IndexedDB; points from the build; nothing new in the pipeline
  except `be` on points (JS `summary.js`).
- Local: pipeline reads `coach/settings.json` and copies `goals` and `hr_max` into
  `summary.json` as `settings` so the dashboard needs no extra fetch. The dashboard treats
  IndexedDB settings as an overlay on top of `summary.settings`.
- `RACE_GOALS` in `app.js` is deleted; the race chart's dashed goal line comes from the
  primary goal when its distance matches the selected label.

## Edge cases

- Goal distance with no efforts in the 4× band (a marathon goal for someone with only
  5ks): projection shows "not enough long efforts yet" instead of a number.
- Goal in the past with no matching run: debrief in "pick the run" state.
- Two goals on the same date: both show; primary is the tab.
- Runs excluded via `progression_excludes.json` are excluded from projections here too
  (they already carry `exclude_prog`).

## Testing

- `project.js` vs Python on the fixture: per-date projections equal within 1 s.
- Debrief run matcher: unit tests for ±1 day, 5% distance band, race-type preference,
  no-match state.
- Goal-pace work detection: contiguous split windows at ±3%.

## Open questions

- Should target pace be entered instead of target time for the "no time goal, just a
  distance" case? Proposed: allow the goal with `target_s` null; tiles show projection
  only, no Δ.
- Readiness colouring thresholds (±1% / ±4%) are a guess. Fine to tune after seeing it.
