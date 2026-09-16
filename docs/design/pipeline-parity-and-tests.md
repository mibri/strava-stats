# Design: Pipeline parity tests and CI

_Status: proposed · Size: L · Depends on: nothing; should land before Planned vs actual
and the projection refactor in the Goal tab_

## Summary

There are two implementations of the pipeline, Python (`pipeline/`) for local use and
JavaScript (`web/build/`) for the public site, and zero tests. Every feature on the
roadmap touches both. This design adds one synthetic fixture export, golden outputs, unit
tests for the tricky numeric pieces, a Python-vs-JS parity check with tolerances, and a
GitHub Actions workflow that runs all of it and gates the Pages deploy.

## Goals

- A change to either pipeline that alters numbers shows up as a diff in CI.
- Parity drift between Python and JS is a test failure, with a readable report of which
  field diverged on which run.
- Tests run in under a minute locally with no network.
- No build step for the web app is introduced; JS tests run on the ESM files as they are.

## Non-goals

- 100% coverage. The target is the numeric core: track parsing, best efforts, splits,
  classification, fitness curve, projections, segments, plan matching.
- Browser-level tests of charts (Playwright smoke tests are mentioned in other designs
  and are a separate, later item).

## Fixture

`tests/fixtures/export.zip`: a synthetic Strava export in the real layout
(`activities.csv` with the 103-column header including duplicate names, `activities/`
with `.gpx`, `.fit.gz`, and one `.fit`, `media/` with two tiny images).

Generated, not hand-made, by extending `pipeline/make_sample.py` into
`tests/make_fixture.py`:
- ~24 runs across 10 weeks so the fitness curve, ISO-week logic, week-long detection and
  classification (easy / long / workout / recovery / race via name override) all have
  something to bite on.
- Routes: one repeated loop (ran 8 times, both directions, so segment mining finds it),
  one out-and-back, one trip cluster 200 km away (regions), one treadmill run with no
  GPS (timezone fallback, no-route paths), one run with a 20-minute pause (cumulative
  cleaning), one with a HR dropout, one crossing a DST change.
- Coordinates in the ocean or a shifted grid so nothing is a real place.
- GPX is written directly. FIT is written with a minimal encoder in the fixture script
  (file header, one `file_id` definition, one `record` definition with timestamp,
  position, altitude, heart rate, distance, speed, cadence; CRC). ~120 lines; the format
  is documented and `fitdecode` validates the result in a test. This avoids checking in
  any real personal file.

The zip is checked in (≈ 300 KB) along with the script so it can be regenerated. Golden
outputs (`tests/golden/`) are the Python pipeline's `runs.json`, `summary.json`,
`segments.json` and a few `streams/<id>.json`, regenerated with `make test-golden` and
reviewed as a diff in PRs.

## Python tests (`pytest`)

- `test_tracks.py`: each fixture format parses to the same record schema; pause
  removal; HR dropout leaves `None`.
- `test_metrics.py`: best efforts on a constructed constant-pace stream equal
  distance / speed; mile splits count and elevation change; decoupling on a stream with a
  known second-half drift; Riegel and the exponent clamp.
- `test_classify.py`: name override beats data; surge detection flags the workout
  fixture; the week-long flag picks the longest run per ISO week.
- `test_build.py`: full build on the fixture into a temp `data/` (the module reads
  `DATA`; make it a parameter or env var) and compare to golden with tolerances.
- `test_strava_api.py`: `fetch_new_activities` with a fake `fetch` appends rows in the
  positional 103-column layout and writes GPX; overlap dedupe by id.

Tolerances: distances 0.01 mi, paces 1 s, times 1 s, HR 0.5, elevation 2 ft, fitness
values 0.5, floats otherwise 1e-6 relative.

## JS tests (Node built-in runner)

`node --test tests/js/` on Node 22. No bundler. Two problems to solve:

1. `tracks.js` imports `fit-file-parser` from jsdelivr and `pipeline.js` expects `fflate`
   as a global. Add `package.json` with these as devDependencies (they're only for
   tests; the browser keeps using the CDN) and a tiny `tests/js/setup.mjs` that sets
   `globalThis.fflate` and stubs the CDN import via a `--import` loader hook mapping the
   jsdelivr URL to the local package. Alternatively, pass the parser in as a parameter
   (`loadTrack(filename, bytes, { fit })`); that's cleaner and is the proposed change.
2. `buildTracks` uses a `Worker`. Export the worker body's per-file function
   (`parseOne(filename, bytes)`) from `worker.js` so tests call it directly.

Tests mirror the Python ones over the same fixture: unzip with fflate, run `buildAll`
(with the worker path swapped for a direct loop), compare to golden.

## Parity check

`tests/parity/compare.py` loads the Python outputs and the JS outputs (JS test writes
its results to `tests/out/js/`) and compares field by field with the tolerances above.
It prints a table of mismatches: run id, field, python value, js value. Exit non-zero on
any mismatch outside tolerance.

Known, accepted differences are listed in `tests/parity/allow.json` with a reason, e.g.
region names ("Home" vs geocoded), weather (CSV-only), and anything else discovered.
The allow list must not grow silently: adding to it needs a reason string.

## CI

`.github/workflows/test.yml` on `pull_request` and `push` to `main`:
```
python: setup 3.12, pip install -r requirements.txt pytest, pytest
node:   setup 22, npm ci, node --test tests/js/
parity: needs both, python tests/parity/compare.py
```
`deploy.yml` gains `needs: test` via `workflow_run` or by merging the jobs so a red test
blocks the Pages deploy.

## Import diagnostics (small, same area)

`web/build/pipeline.js#buildTracks` returns the worker's `failures`, but `buildAll`
destructures only `streams` and `routes` and drops them. Pass them through; `import.html` shows "3 tracks couldn't be parsed" with a details
toggle listing filenames and errors; the count is stored in the build's `meta` so the
overview can show a small note. The fixture includes one corrupt `.fit` to test this.

## Rollout

1. Fixture generator + zip + Python tests + golden. (Parity has nothing to compare yet
   but the Python side is locked.)
2. JS test harness and the `loadTrack` parameter change.
3. Parity script and CI workflow.
4. Deploy gating.

## Open questions

- Node 22's built-in runner vs. vitest. Built-in avoids a devDependency tree for a
  no-build project; vitest has nicer diffs. Proposed: built-in, revisit if the diff output
  hurts.
- Whether to keep `progression_excludes.json` honoured in the fixture build (yes, with
  one excluded id in the fixture to test it).
