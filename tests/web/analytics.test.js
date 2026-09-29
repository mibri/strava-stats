// Unit tests for web/analytics.js. Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../../web/analytics.js");

test("streaks: daily, weekly, break, and whether the current one is alive", () => {
  const dates = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-10", "2026-01-11 07:00", "2026-01-11 18:00"];
  const s = A.streaks(dates, "2026-01-12");
  assert.deepEqual(s.longest, { len: 3, start: "2026-01-01", end: "2026-01-03" });
  assert.deepEqual(s.current, { len: 2, start: "2026-01-10", end: "2026-01-11" });
  assert.equal(s.longestBreak.len, 6);
  assert.equal(s.longestBreak.start, "2026-01-04");
  // 2026-01-01 is a Thursday: weeks of Dec 29, Jan 5 (Sat 10 is in week of Jan 5), Jan 5 again (Sun 11)
  assert.equal(s.longestWeeks.len, 2);
  assert.equal(s.longestWeeks.start, "2025-12-29");
  // Three days later the daily streak is over, the weekly one is not.
  const later = A.streaks(dates, "2026-01-14");
  assert.equal(later.current.len, 0);
  assert.equal(later.currentWeeks.len, 2);
});

test("streaks: empty input", () => {
  assert.equal(A.streaks([], "2026-01-01").longest.len, 0);
});

test("weekday of a date string ignores the timezone", () => {
  assert.equal(A.dowOf("2026-09-28"), 0); // Monday
  assert.equal(A.dowOf("2026-09-27 23:30"), 6); // Sunday
});

test("paceCurve picks the fastest effort per distance within the window", () => {
  const recs = [
    { id: "a", date: "2026-01-01", be: { "1 mi": 480, "5k": 1600 } },
    { id: "b", date: "2026-03-01", be: { "1 mi": 470, "5k": 1650 } },
  ];
  const all = A.paceCurve(recs);
  assert.deepEqual(all.map((p) => [p.label, p.s, p.id]), [["1 mi", 470, "b"], ["5k", 1600, "a"]]);
  assert.ok(Math.abs(all[0].pace_s - 470) < 1e-6);            // 1 mi pace = time
  const recent = A.paceCurve(recs, "2026-02-01");
  assert.equal(recent.find((p) => p.label === "5k").s, 1650);
});

test("effortsByRun falls back to pr_progression when points lack `be`", () => {
  const points = [{ id: "a", date: "2026-01-01", type: "easy" }];
  const prog = { "5k": [{ id: "a", date: "2026-01-01", time_s: 1500 }] };
  assert.deepEqual(A.effortsByRun(points, prog), [{ id: "a", date: "2026-01-01", type: "easy", be: { "5k": 1500 } }]);
});

test("prTimeline records each improvement", () => {
  const recs = [
    { id: "a", date: "2026-01-01", be: { "5k": 1600 } },
    { id: "b", date: "2026-02-01", be: { "5k": 1650 } },
    { id: "c", date: "2026-03-01", be: { "5k": 1550 } },
  ];
  const t = A.prTimeline(recs);
  assert.deepEqual(t.map((e) => [e.id, e.prev]), [["a", null], ["c", 1600]]);
});

test("superlatives and biggest periods", () => {
  const runs = [
    { id: "a", date: "2026-01-05 06:10", name: "x", distance_mi: 5, moving_s: 2400, pace_s: 480, elev_gain_ft: 100, temp_f: 40 },
    { id: "b", date: "2026-01-06 19:45", name: "y", distance_mi: 12, moving_s: 6000, pace_s: 500, elev_gain_ft: 900, temp_f: 80 },
    { id: "c", date: "2026-02-20 01:00", name: "z", distance_mi: 3, moving_s: 1500, pace_s: 500, elev_gain_ft: 0, temp_f: null },
  ];
  const s = Object.fromEntries(A.superlatives(runs).map((x) => [x.key, x]));
  assert.equal(s.longest.id, "b");
  assert.equal(s.fast5.id, "a");
  assert.equal(s.cold.id, "a");
  assert.equal(s.early.id, "a");        // the 01:00 run is ignored for "earliest"
  assert.equal(s.late.id, "b");
  const big = A.biggestPeriods(runs);
  assert.equal(big.week.start, "2026-01-05");
  assert.equal(big.week.miles, 17);
  assert.equal(big.month.start, "2026-01");
});

test("cumulativeByYear aligns years on day of year and stops at the anchor", () => {
  const runs = [
    { date: "2025-01-01", distance_mi: 3 }, { date: "2025-03-01", distance_mi: 4 }, { date: "2025-12-31", distance_mi: 1 },
    { date: "2026-01-02", distance_mi: 5 }, { date: "2026-02-15", distance_mi: 2 },
  ];
  const [y25, y26] = A.cumulativeByYear(runs, "miles", "2026-02-15");
  assert.equal(y25.total, 8);
  assert.equal(y25.x[0], "2000-01-01");
  assert.equal(y25.atAnchor, 3);          // by Feb 15, 2025 only the Jan 1 run
  assert.equal(y26.x[y26.x.length - 1], "2000-02-15");
  assert.equal(y26.total, 7);
  assert.equal(y26.atAnchor, 7);
  // A year that starts mid-way begins at its first run.
  const [first] = A.cumulativeByYear([{ date: "2024-10-05", distance_mi: 2 }, ...runs], "miles", "2026-02-15");
  assert.equal(first.x[0], "2000-10-05");
});

test("yearSummary", () => {
  const runs = [
    { date: "2026-01-05 07:00", distance_mi: 5, moving_s: 3000, elev_gain_ft: 10, type: "easy", avg_hr: 140 },
    { date: "2026-01-06 07:00", distance_mi: 10, moving_s: 6000, elev_gain_ft: 20, type: "long", avg_hr: 150 },
    { date: "2025-06-01 07:00", distance_mi: 3, moving_s: 1500, elev_gain_ft: 0, type: "easy" },
  ];
  const y = A.yearSummary(runs, "2026");
  assert.equal(y.runs, 2);
  assert.equal(y.miles, 15);
  assert.equal(y.avgPace, 600);
  assert.equal(y.topMonth, "Jan");
  assert.equal(y.topHour, 7);
  assert.equal(y.longest.distance_mi, 10);
  assert.equal(y.hours, 2.5);
  assert.equal(y.hourCounts[7], 2);
});

test("punchCard and histogram", () => {
  const m = A.punchCard([{ date: "2026-09-28 06:30" }, { date: "2026-09-28 06:59" }]);
  assert.equal(m[0][6], 2);
  const h = A.histogram([0.5, 1, 1.2, 3.9], 1);
  assert.deepEqual(h.map((b) => b.n), [1, 2, 0, 1]);
});

test("hrZoneTime caps pauses", () => {
  const zones = [{ lo: 0, hi: 120 }, { lo: 120, hi: 150 }, { lo: 150, hi: null }];
  const t = [0, 10, 20, 100, 110];
  const hr = [110, 130, 160, 130, 130];
  assert.deepEqual(A.hrZoneTime(t, hr, zones), [10, 20, 30]);
});

test("resample interpolates and leaves out-of-range as null", () => {
  assert.deepEqual(A.resample([0, 1, 2], [0, 10, 20], [0, 0.5, 2, 3]), [0, 5, 20, null]);
  assert.deepEqual(A.resample([0, 1, 1, 2], [0, 10, 12, 20], [1.5]), [16]);
});

test("alignRuns: identical runs have zero gap, a slower run a linear one", () => {
  const mk = (pace) => {
    const dist_mi = [], t = [];
    for (let i = 0; i <= 50; i++) { dist_mi.push(i * 0.1); t.push(i * 0.1 * pace); }
    return { dist_mi, t, pace_s: t.map(() => pace), hr: t.map(() => 150), elev_ft: t.map(() => 0) };
  };
  const same = A.alignRuns(mk(480), mk(480), "distance", 0.5);
  assert.ok(same.gap.every((g) => Math.abs(g) < 1e-9));
  const slow = A.alignRuns(mk(480), mk(490), "distance", 1);
  assert.deepEqual(slow.grid, [0, 1, 2, 3, 4, 5]);
  slow.gap.forEach((g, i) => assert.ok(Math.abs(g - 10 * i) < 1e-6));
  const byTime = A.alignRuns(mk(480), mk(490), "time");
  assert.equal(byTime.mode, "time");
  assert.ok(byTime.gap[byTime.gap.length - 1] > 0);         // B has covered less distance
});

test("routeSimilarity: same, reversed, and disjoint routes", () => {
  const line = Array.from({ length: 100 }, (_, i) => [-122.4 + i * 0.0002, 37.8]);
  assert.equal(A.routeSimilarity(line, line), 1);
  assert.equal(A.routeSimilarity(line, [...line].reverse()), 1);
  const far = line.map(([lo, la]) => [lo, la + 0.01]);
  assert.equal(A.routeSimilarity(line, far), 0);
  // B covers only half of A
  assert.ok(Math.abs(A.coverage(line, line.slice(0, 50)) - 0.5) < 0.05);
});

test("rankOf", () => {
  assert.equal(A.rankOf(10, [5, 10, 12, 20]), 3);
  assert.equal(A.rankOf(5, [5, 10, 12, 20], false), 1);
});
