# Design: Compare two runs

_Status: proposed · Size: L · Depends on: nothing_

## Summary

Pick two runs and see them on top of each other: pace, HR and elevation by distance, the
cumulative time gap, splits side by side, and both routes on one map. The main use is
"same route, a month apart" and "this workout vs last time", so same-route detection and
a distance-aligned time gap are the core, not just overlaid lines.

## Goals

- Select two runs from the runs table or from a run's detail view, in two clicks.
- Overlays align by distance, with a time-axis toggle.
- A cumulative gap chart that answers "where did I gain or lose the 40 seconds".
- Works entirely from the existing per-run stream files; no pipeline change.

## Non-goals

- Comparing more than two runs.
- Comparing arbitrary sub-sections (the draw-a-segment tool already covers that).
- GAP-normalized overlays in v1 (streams carry pace, not grade-adjusted pace).

## Inputs available

Each stream detail has `stream: { t, dist_mi, pace_s, hr, elev_ft, latlng }` at ≤600
points (latlng on its own stride), `splits`, `best_efforts`, and `traj` (~12 m spacing
with `lat, lon, t, dist_mi, hr, pace_s`). `traj` is what the drawn-segment matcher uses
and is what same-route detection uses here.

## Selection UX

- Runs table: a checkbox column appears when hovering rows or after the first click on
  a new "Compare" toggle in the toolbar. Selecting two runs shows a sticky pill at the
  bottom: "Compare Sep 14 long run vs Aug 17 long run →".
- Run detail modal: a "Compare with…" button opens a picker listing runs sorted by
  route similarity, then by distance similarity, so the natural comparison is at the top.
- URL state: `#compare=<idA>,<idB>` so a comparison can be reloaded or shared with
  yourself. The runs tab already ignores the hash, so this is additive.

## The compare view

A full-width modal (same `.modal-box`, wider) with A in orange (`#fc5200`) and B in
purple (`#9b6bff`), matching the existing pace/elevation colours.

1. **Stat strip**: two columns, one per run, with Δ in the middle: distance, moving time,
   pace, GAP, avg HR, EF, elevation gain, cadence, effort. Δ is B − A with sign and
   colour (faster / lower HR is green).
2. **Alignment toggle**: Distance (default) | Time.
3. **Cumulative time gap** (the headline chart): at each distance d on a common grid,
   `gap(d) = t_B(d) − t_A(d)`. Positive means B is behind. Filled area, zero line, mile
   grid lines. Plotly `hovertemplate` shows both elapsed times.
4. **Pace overlay**: both `pace_s` series on the common grid, reversed pace axis via
   `paceAxis` over the union of values. Splits shown as faint bars behind the lines.
5. **HR overlay**: both HR series; if either lacks HR, the card is omitted.
6. **Elevation**: A's profile filled, B's as a line. On a same-route pair these overlap
   and the card collapses to A only with a note.
7. **Splits table**: mile, pace A, pace B, Δ, HR A, HR B. Extra miles on the longer run
   are shown greyed.
8. **Map**: both polylines; on hover over any chart the corresponding points are
   marked on both routes (reuse the hover-sync pattern if any; otherwise a
   `plotly_hover` handler that moves two `L.circleMarker`s).

## Alignment

Common grid: `step = 0.05 mi`, from 0 to `min(dist_A, dist_B)`. For each run, linear
interpolation of `t`, `pace_s`, `hr`, `elev_ft` on `dist_mi` (already monotonic after
`cleanCumulative`). Interpolate `t` from the full-resolution `traj` when present, since
the display stream's 600 points can be 30–50 m apart on a long run and the gap chart is
sensitive to that. Pace and HR from the display stream are fine.

Time alignment uses the same approach with `t` as the independent variable.

Implementation: `web/build/align.js` exporting `resample(series, x, grid)` and
`compare(streamA, streamB, mode) → { grid, a: {...}, b: {...}, gap }`. Pure functions,
Node-testable.

## Same-route detection

Given `traj` for both runs, project B's points onto A's polyline (reuse
`buildCenterline` / `projectToCenterline` from the drawn-segment code, extracted into a
shared module) and compute the fraction of B's points within 30 m of A. Symmetric check.
`same_route = min(fracAB, fracBA) ≥ 0.85`.

When same-route is true:
- The elevation card collapses (identical profile).
- The gap chart's x axis is annotated with the repeated-segment names from
  `segments.json` that both runs traverse, so "lost 20 s on the Presidio climb" is
  readable.
- The compare picker ranks by this score.

When it's false, everything still works; the gap chart is simply "at equal distance
covered", which is still meaningful for two workouts on different roads.

Score computation over all pairs for the picker: ~230 runs × one candidate = 230
projections of ~800 points each, well under a second, but do it lazily (only when the
picker opens) and cache per anchor run.

## Edge cases

- One run without GPS: no map, no same-route; distance axis from `dist_mi` still works
  (treadmill runs carry distance from the FIT). If `dist_mi` is absent, force time mode.
- Very different distances (5 mi vs 20 mi): grid stops at 5 mi; the strip shows full
  totals; a note says "overlays cover the first 5.0 mi".
- Missing HR on one side: omit HR card and HR columns.
- Paused runs: `cleanCumulative` already removes stops, so `t` is moving time on both.

## Testing

- `align.js`: resampling on synthetic monotonic series; identical inputs give zero gap;
  B at constant +10 s/mi gives a linear gap.
- Same-route score: identical traj → 1.0; reversed direction → still high (the check is
  positional, not directional, by design); disjoint routes → ~0.
- Playwright on the sample data: select two sample runs, assert the modal opens with the
  gap chart and both routes.

## Open questions

- Should the compare view be a modal or a fourth panel in the runs tab? Modal keeps the
  URL and tab state simple and matches the run detail pattern. Proposed: modal.
- Direction-aware same-route (out-and-back vs loop, clockwise vs counter)? The gap chart
  by distance already handles direction implicitly; a direction mismatch just makes the
  elevation profiles differ, which the collapse rule would then leave expanded. Fine for v1.
