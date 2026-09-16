# Design: Planned vs actual

_Status: proposed · Size: L · Depends on: settings model (Goal tab), ideally the parity
tests_

## Summary

Let the user (or, in local mode, the coach) write a structured weekly training plan, and
show it against what was actually run: planned workouts on the calendar, per-workout
hit / partial / missed / extra, and a weekly compliance number. The plan is data, not
prose, so both the dashboard and the coach can read it.

## Goals

- Author a plan in-app in under a minute per week (public users have no coach).
- In local mode, `/coach` can write the plan file directly.
- Every planned workout resolves to exactly one of: hit, partial, missed, or (for runs
  with no plan) extra. The rule must be explainable in one sentence in the UI.
- Weekly compliance trend in the Progression tab; this week's plan on the Overview.

## Non-goals

- Plan templates or generated plans (the coach does that in local mode; public users
  write their own).
- Multi-sport or cross-training entries.
- Intra-run structure (intervals as reps × distance). A workout is one line: type,
  distance or duration, optional target pace, note.

## Data model

Plan lives in settings (see accounts design) under `plan`, and in local mode in
`coach/plan.json` (gitignored; the pipeline copies it into `summary.json` as `plan` so the
dashboard has one place to read it).

```json
{
  "version": 1,
  "workouts": [
    { "id": "w_9f3a", "date": "2026-09-22", "type": "easy",    "dist_mi": 5,
      "note": "conversational" },
    { "id": "w_c1d0", "date": "2026-09-24", "type": "workout", "dist_mi": 7,
      "target_pace_s": 420, "note": "5×1k @ 5k pace, 2:30 jog" },
    { "id": "w_77ab", "date": "2026-09-27", "type": "long",    "dist_mi": 12 },
    { "id": "w_2e19", "date": "2026-09-26", "type": "rest" }
  ]
}
```

- `date` is a local calendar date with no timezone, matching how the dashboard already
  buckets runs (`localize_dates` gives each run a local date).
- `type` uses the existing run types (`easy | long | workout | recovery | race`) plus `rest`.
- Exactly one of `dist_mi` or `dur_min` is required for non-rest workouts.
- Two workouts on one date are allowed (doubles).
- `id` is client-generated and stable so edits don't reorder or re-match.

## Matching algorithm

Runs in: `state.runs` (local dates, types, distances). Plan in: `settings.plan.workouts`.

Per ISO week (Monday start, as the rest of the app):

1. **Same-day pass.** For each planned workout on date D, candidates are unmatched runs
   on D. Pick the one with the closest distance (or duration). If a double is planned,
   repeat. A planned `rest` matches "no run on D".
2. **Moved-workout pass** (within the same week only). Remaining planned workouts and
   remaining runs are paired greedily by lowest cost, accepting a pair only if
   cost < 1.0:
   - cost = 0.5 × |Δdays| / 3 + 0.5 × |dist_actual − dist_planned| / dist_planned
   - plus 0.3 if the run type differs from the planned type (types come from the
     classifier and are noisy, so a mismatch is a penalty, not a veto).
   This catches "long run moved from Saturday to Sunday" without matching a Tuesday
   easy 4 to a Sunday 14.
3. **Leftovers.** Unmatched planned workouts are `missed`; unmatched runs are `extra`.
   A planned `rest` day with a run on it is a `missed` rest.

Grading a matched pair:

| Verdict | Rule |
|---|---|
| hit | distance (or duration) within ±10% of planned, and type matches or planned type is easy/recovery |
| partial | within 70–130%, or type mismatch on a long/workout day |
| missed | matched by nothing, or under 70% |

Target pace is informational (shown next to the actual average pace) and never affects
the verdict; a workout's average pace is dominated by its recovery jogs.

Weekly compliance = hits / planned non-rest workouts. Also show planned vs actual miles
for the week. Both go into a `plan_weeks` array computed client-side on boot and after
any plan edit, so no pipeline change is needed for the public path.

The matcher is pure: `matchPlan(workouts, runs) → { pairs, missed, extra, weeks }`. It
lives in `web/build/plan.js` so it can run in Node tests and be ported to
`pipeline/plan.py` for the coach context with the same fixtures (see parity design).

## UI

### Overview: "This week" card
Above the mileage chart when a plan covers the current week. One row per day, Monday to
Sunday: planned (type pill, distance, note) on the left, actual (linked run, distance,
pace) on the right, verdict dot between them. Today's row is highlighted. Empty plan →
a single "Plan this week" link that opens the editor.

### Calendar
Days with a planned workout get a thin outline ring in the plan type's colour
(`TYPE_COLORS`). Missed days keep the ring on an empty cell, which is the useful signal.
The existing day click opens the run; a planned-but-unrun day opens the editor for that day.

### Progression: "Plan compliance" chart
Weekly bars: planned miles (outline) vs actual miles (filled), with hit rate as a line on
a second axis. Timeframe bar applies. Placed right after "Weekly volume".

### Editor
A modal reusing `.modal-box`. Week picker at the top (← this week →). Seven rows, each a
compact form: type select, distance/duration input with a mi/min toggle, target pace
(`m:ss`), note. "Copy last week" fills the grid. Edits save on blur to settings (local
first, then cloud debounce-upsert). Keyboard: Tab through cells, Enter to add a double.

No drag-and-drop in v1. Moving a workout is: change its date.

## Coach integration (local mode)

- `pipeline/coach_context.py` reads `coach/plan.json`, runs `plan.py`'s matcher, and
  writes a "Last week: planned vs actual" table plus "This week's plan" to
  `coach_context.md`.
- `.claude/commands/coach.md` gets a short section: the plan schema above, and "when
  asked to plan next week, write or update `coach/plan.json` (keep existing ids for
  workouts you're not changing)".
- `serve.py` already serves the repo root, so in local mode the dashboard can also read
  `../coach/plan.json` directly for edits made in the editor; the pipeline copy into
  `summary.json` is for the coach's benefit, not the dashboard's. To keep one writer, the
  editor in local mode writes to IndexedDB and shows a "copy plan JSON" button rather
  than writing files (the browser can't write to disk). This is the one rough edge of
  local mode and it's acceptable: the coach is the plan author there.

## Edge cases

- Runs before the first planned week: no verdicts, no `extra` noise. Compliance is only
  computed for weeks that have at least one planned workout.
- Race day: a planned `race` matched to a run marks the run type as race for display
  (name override already exists for "race" in the classifier; this is a second override).
- Timezone travel: run dates are already localized; plan dates are naive. A run at
  11 pm local on Saturday stays Saturday. Fine.
- Editing history: changing a past week's plan recomputes verdicts. No audit trail.
- Plan version bump: `version` is checked on load; unknown versions are ignored with a
  console warning rather than crashing the overview.

## Testing

- `web/build/plan.js` unit tests: same-day match, moved long run, double day, planned
  rest with a run, 70/110/130% boundaries, week with no plan yields no compliance.
- Parity test: `pipeline/plan.py` on the same fixture produces identical verdicts.
- Playwright: author a week in the editor, reload, calendar rings and This-week card
  render.

## Open questions

- Should `hit` require type agreement for workout days? The classifier's within-run
  surge detection is decent but a planned tempo run done as steady easy will read as
  "hit" on distance alone. Proposed: type mismatch on `workout`/`long` demotes to
  partial (as in the table). Say if you'd rather distance-only.
- Rest-day strictness: is a 2-mile shakeout on a planned rest day a miss? Proposed: a
  run under 3 miles on a planned rest day is `partial`, not missed.
