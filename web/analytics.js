/* Pure analytics for the dashboard's Records / Years / Compare views. No DOM, no
 * Plotly: every function takes plain data (the runs table, summary.points, stream
 * blobs) and returns plain data, so it runs in the browser (window.Analytics) and in
 * Node's test runner (module.exports). Dates are the pipeline's local wall-clock
 * strings ("YYYY-MM-DD" or "YYYY-MM-DD HH:MM") and are handled as calendar days, never
 * through the browser's timezone. */
(function (root) {
  "use strict";
  const DAY_MS = 864e5;
  const M_PER_MI = 1609.344;

  // Best-effort distances, shortest first (label -> meters). Mirrors
  // BEST_EFFORT_DISTANCES in pipeline/metrics.py and the worker's list.
  const BE_DISTANCES = [
    ["400m", 400], ["1/2 mi", 805], ["1k", 1000], ["1 mi", 1609.344], ["2 mi", 3218.688],
    ["5k", 5000], ["10k", 10000], ["10 mi", 16093.44], ["Half", 21097.5], ["Marathon", 42195],
  ];

  /* ---------- day arithmetic (UTC day numbers, no timezone drift) ---------- */
  const dayNum = (s) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY_MS);
  const isoDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
  // Monday-start week index (day 0 = Thu 1970-01-01, so shift by 3).
  const weekNum = (n) => Math.floor((n + 3) / 7);
  const weekStart = (w) => isoDay(w * 7 - 3);
  const hourOf = (s) => (s.length >= 13 ? +s.slice(11, 13) : null);
  // 0 = Monday … 6 = Sunday
  const dowOf = (s) => (((dayNum(s) + 3) % 7) + 7) % 7;
  const pad2 = (n) => String(n).padStart(2, "0");

  /* ---------- streaks ---------- */
  /** Consecutive-day and consecutive-week streaks over the run dates.
   *  `today` ("YYYY-MM-DD") decides whether the latest streak is still alive: it is if
   *  the last run was today or yesterday (daily) / this week or last week (weekly). */
  function streaks(dates, today) {
    const days = [...new Set(dates.map((d) => dayNum(d.slice(0, 10))))].sort((a, b) => a - b);
    const empty = { len: 0, start: null, end: null };
    if (!days.length) return { longest: empty, current: empty, longestWeeks: empty, currentWeeks: empty, longestBreak: empty };
    const t = today ? dayNum(today) : days[days.length - 1];

    const runsOf = (xs) => {           // maximal runs of consecutive integers
      const out = []; let s = xs[0], p = xs[0];
      for (let i = 1; i < xs.length; i++) {
        if (xs[i] === p + 1) { p = xs[i]; continue; }
        out.push([s, p]); s = p = xs[i];
      }
      out.push([s, p]);
      return out;
    };
    const best = (spans) => spans.reduce((b, s) => (s[1] - s[0] > b[1] - b[0] ? s : b), spans[0]);

    const dSpans = runsOf(days);
    const dBest = best(dSpans), dLast = dSpans[dSpans.length - 1];
    const weeks = [...new Set(days.map(weekNum))];
    const wSpans = runsOf(weeks);
    const wBest = best(wSpans), wLast = wSpans[wSpans.length - 1];

    let brk = null;                    // longest gap between two runs (days off)
    for (let i = 1; i < days.length; i++) {
      const g = days[i] - days[i - 1] - 1;
      if (g > 0 && (!brk || g > brk.len)) brk = { len: g, start: isoDay(days[i - 1] + 1), end: isoDay(days[i] - 1) };
    }
    const alive = t - dLast[1] <= 1;
    const wAlive = weekNum(t) - wLast[1] <= 1;
    return {
      longest: { len: dBest[1] - dBest[0] + 1, start: isoDay(dBest[0]), end: isoDay(dBest[1]) },
      current: alive ? { len: dLast[1] - dLast[0] + 1, start: isoDay(dLast[0]), end: isoDay(dLast[1]) } : { len: 0, start: null, end: null },
      longestWeeks: { len: wBest[1] - wBest[0] + 1, start: weekStart(wBest[0]), end: weekStart(wBest[1]) },
      currentWeeks: wAlive ? { len: wLast[1] - wLast[0] + 1, start: weekStart(wLast[0]), end: weekStart(wLast[1]) } : { len: 0, start: null, end: null },
      longestBreak: brk || empty,
    };
  }

  /* ---------- best efforts ---------- */
  /** Per-run best efforts as {label: seconds}. Prefers the compact `be` map on
   *  summary.points (newer builds); falls back to pr_progression, which only tracks
   *  the five race distances. Returns [{id, date, type, be}] */
  function effortsByRun(points, prProgression) {
    if (points.some((p) => p.be)) return points.filter((p) => p.be).map((p) => ({ id: p.id, date: p.date, type: p.type, be: p.be }));
    const by = {};
    const typeOf = Object.fromEntries(points.map((p) => [p.id, p.type]));
    for (const [label, list] of Object.entries(prProgression || {})) {
      for (const e of list) {
        const o = (by[e.id] ||= { id: e.id, date: e.date, type: typeOf[e.id] || null, be: {} });
        o.be[label] = e.time_s;
      }
    }
    return Object.values(by).sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  /** Fastest effort per distance among `recs` (optionally only dates in [from, to]).
   *  Returns [{label, m, s, pace_s, id, date}] in distance order, distances with no
   *  effort omitted. pace_s is seconds per mile. */
  function paceCurve(recs, from, to) {
    const best = {};
    for (const r of recs) {
      if ((from && r.date < from) || (to && r.date > to)) continue;
      for (const [label, s] of Object.entries(r.be)) {
        if (s == null || !(s > 0)) continue;
        if (!best[label] || s < best[label].s) best[label] = { s, id: r.id, date: r.date };
      }
    }
    return BE_DISTANCES.filter(([l]) => best[l]).map(([label, m]) => ({
      label, m, ...best[label], pace_s: best[label].s / (m / M_PER_MI),
    }));
  }

  /** Every moment a distance's all-time best was lowered, oldest first:
   *  [{label, m, s, prev, id, date, first}] (`first` = the first-ever effort). */
  function prTimeline(recs) {
    const best = {}, out = [];
    const sorted = [...recs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const r of sorted) {
      for (const [label, m] of BE_DISTANCES) {
        const s = r.be[label];
        if (s == null) continue;
        if (!(label in best) || s < best[label]) {
          out.push({ label, m, s, prev: best[label] ?? null, id: r.id, date: r.date, first: !(label in best) });
          best[label] = s;
        }
      }
    }
    return out;
  }

  /* ---------- superlatives ---------- */
  /** Headline records over the runs table. Each: {key, title, value, sub, id?}. The
   *  caller formats `value`; `raw` is kept for sorting/tests. */
  function superlatives(runs) {
    const out = [];
    const pick = (key, title, arr, score, fmt, better = "max") => {
      const xs = arr.filter((r) => score(r) != null && isFinite(score(r)));
      if (!xs.length) return;
      const r = xs.reduce((b, x) => ((better === "max" ? score(x) > score(b) : score(x) < score(b)) ? x : b));
      out.push({ key, title, raw: score(r), id: r.id, date: r.date.slice(0, 10), name: r.name, fmt });
    };
    pick("longest", "Longest run", runs, (r) => r.distance_mi, "mi");
    pick("time", "Longest time on feet", runs, (r) => r.moving_s, "dur");
    pick("climb", "Most climbing", runs, (r) => r.elev_gain_ft, "ft");
    pick("fast5", "Fastest run ≥ 5 mi", runs.filter((r) => r.distance_mi >= 5), (r) => r.pace_s, "pace", "min");
    pick("fast10", "Fastest run ≥ 10 mi", runs.filter((r) => r.distance_mi >= 10), (r) => r.pace_s, "pace", "min");
    pick("effort", "Hardest effort", runs, (r) => r.rel_effort, "num");
    pick("hot", "Hottest run", runs, (r) => r.temp_f, "temp");
    pick("cold", "Coldest run", runs, (r) => r.temp_f, "temp", "min");
    // Start time as minutes after midnight; "earliest" ignores the small hours so a
    // post-midnight run doesn't count as the earliest start.
    const mins = (r) => (r.date.length >= 16 ? +r.date.slice(11, 13) * 60 + +r.date.slice(14, 16) : null);
    pick("early", "Earliest start", runs.filter((r) => mins(r) != null && mins(r) >= 180), mins, "clock", "min");
    pick("late", "Latest start", runs.filter((r) => mins(r) != null && mins(r) >= 180), mins, "clock");
    return out;
  }

  /** Biggest calendar week and month by miles: {week: {start, miles, runs}, month: {...}} */
  function biggestPeriods(runs) {
    const wk = {}, mo = {};
    for (const r of runs) {
      const d = r.date.slice(0, 10);
      const w = weekStart(weekNum(dayNum(d))), m = d.slice(0, 7);
      (wk[w] ||= { start: w, miles: 0, runs: 0 }); wk[w].miles += r.distance_mi || 0; wk[w].runs++;
      (mo[m] ||= { start: m, miles: 0, runs: 0 }); mo[m].miles += r.distance_mi || 0; mo[m].runs++;
    }
    const top = (o) => Object.values(o).reduce((b, x) => (!b || x.miles > b.miles ? x : b), null);
    return { week: top(wk), month: top(mo) };
  }

  /* ---------- years ---------- */
  const METRICS = {
    miles: (r) => r.distance_mi || 0,
    hours: (r) => (r.moving_s || 0) / 3600,
    elev: (r) => r.elev_gain_ft || 0,
    runs: () => 1,
  };

  /** Cumulative metric by day of year, one series per calendar year. x is a date in
   *  leap year 2000 so every year shares one Jan→Dec axis. The last (anchor) year
   *  stops at `until` ("YYYY-MM-DD"); earlier years run to Dec 31.
   *  -> [{year, x: [...], y: [...], total, atAnchor}] oldest first. `atAnchor` is the
   *  year's cumulative value on the anchor's day-of-year (for "vs. this time last year"). */
  function cumulativeByYear(runs, metric, until) {
    const f = METRICS[metric] || METRICS.miles;
    const byDay = {};
    for (const r of runs) { const d = r.date.slice(0, 10); byDay[d] = (byDay[d] || 0) + f(r); }
    const years = [...new Set(runs.map((r) => r.date.slice(0, 4)))].sort();
    const anchor = until || runs.reduce((m, r) => (r.date > m ? r.date : m), "").slice(0, 10);
    const anchorMD = anchor.slice(5, 10);
    const firstDay = runs.reduce((m, r) => (!m || r.date < m ? r.date : m), "").slice(0, 10);
    return years.map((y) => {
      const x = [], ys = [];
      let acc = 0, atAnchor = 0;
      const last = y === anchor.slice(0, 4) ? anchor : `${y}-12-31`;
      // The first year starts at the first run, not a flat line from Jan 1.
      const first = y === firstDay.slice(0, 4) ? firstDay : `${y}-01-01`;
      for (let n = dayNum(first); n <= dayNum(last); n++) {
        const d = isoDay(n);
        acc += byDay[d] || 0;
        if (d.slice(5) <= anchorMD) atAnchor = acc;
        x.push(`2000-${d.slice(5)}`); ys.push(Math.round(acc * 100) / 100);
      }
      return { year: y, x, y: ys, total: acc, atAnchor };
    });
  }

  /** Everything the year-in-review card needs for one calendar year. */
  function yearSummary(runs, year) {
    const rs = runs.filter((r) => r.date.startsWith(year));
    const sum = (f) => rs.reduce((s, r) => s + (f(r) || 0), 0);
    const byMonth = Array(12).fill(0), runsByMonth = Array(12).fill(0), byType = {};
    const dow = Array(7).fill(0), hours = Array(24).fill(0);
    let paceNum = 0, paceDen = 0, hrNum = 0, hrDen = 0;
    for (const r of rs) {
      const m = +r.date.slice(5, 7) - 1;
      byMonth[m] += r.distance_mi || 0; runsByMonth[m]++;
      byType[r.type] = (byType[r.type] || 0) + 1;
      dow[dowOf(r.date)]++;
      const h = hourOf(r.date); if (h != null) hours[h]++;
      if (r.moving_s && r.distance_mi) { paceNum += r.moving_s; paceDen += r.distance_mi; }
      if (r.avg_hr && r.moving_s) { hrNum += r.avg_hr * r.moving_s; hrDen += r.moving_s; }
    }
    const longest = rs.reduce((b, r) => (!b || r.distance_mi > b.distance_mi ? r : b), null);
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const DOWS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const argmax = (a) => a.reduce((b, v, i) => (v > a[b] ? i : b), 0);
    const activeDays = new Set(rs.map((r) => r.date.slice(0, 10))).size;
    return {
      year, runs: rs.length, miles: sum((r) => r.distance_mi), hours: sum((r) => r.moving_s) / 3600,
      elev: sum((r) => r.elev_gain_ft), calories: sum((r) => r.calories),
      avgPace: paceDen ? paceNum / paceDen : null, avgHr: hrDen ? hrNum / hrDen : null,
      activeDays, longest, byMonth, runsByMonth, byType,
      topMonth: rs.length ? MONTHS[argmax(byMonth)] : null,
      topDow: rs.length ? DOWS[argmax(dow)] : null,
      topHour: rs.length && hours.some((h) => h) ? argmax(hours) : null,
      dow, hourCounts: hours,
    };
  }

  /** runs -> 7×24 matrix of run counts (rows Mon..Sun, cols hour 0..23). */
  function punchCard(runs) {
    const m = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const r of runs) { const h = hourOf(r.date); if (h != null) m[dowOf(r.date)][h]++; }
    return m;
  }

  /** Fixed-width histogram: [{lo, hi, n}] covering [0, max]. */
  function histogram(values, width) {
    const v = values.filter((x) => x != null && isFinite(x));
    if (!v.length) return [];
    const nb = Math.max(1, Math.ceil((Math.max(...v) + 1e-9) / width));
    const out = Array.from({ length: nb }, (_, i) => ({ lo: i * width, hi: (i + 1) * width, n: 0 }));
    for (const x of v) out[Math.min(nb - 1, Math.floor(x / width))].n++;
    return out;
  }

  /* ---------- run context ---------- */
  /** 1-based rank of `value` among `values` (1 = largest when desc). */
  function rankOf(value, values, desc = true) {
    const xs = values.filter((x) => x != null && isFinite(x));
    return 1 + xs.filter((x) => (desc ? x > value : x < value)).length;
  }

  /** Seconds spent in each HR zone from a (t, hr) stream. zones: [{lo, hi}] (hi null =
   *  open). Each sample owns the time until the next one; gaps over 30 s (pauses) are
   *  capped so a stopped watch doesn't inflate a zone. */
  function hrZoneTime(t, hr, zones) {
    const out = zones.map(() => 0);
    if (!t || !hr) return out;
    for (let i = 0; i < t.length - 1; i++) {
      const h = hr[i];
      if (h == null) continue;
      const dt = Math.min(30, Math.max(0, t[i + 1] - t[i]));
      const z = zones.findIndex((zz) => h >= (zz.lo || 0) && (zz.hi == null || h < zz.hi));
      if (z >= 0) out[z] += dt;
    }
    return out;
  }

  /* ---------- comparing two runs ---------- */
  /** Linear interpolation of ys(xs) at each grid value. xs must be non-decreasing;
   *  null ys are skipped. Grid values outside [xs0, xsN] get null. */
  function resample(xs, ys, grid) {
    const px = [], py = [];
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] == null || ys[i] == null || !isFinite(ys[i])) continue;
      if (px.length && xs[i] <= px[px.length - 1]) { py[py.length - 1] = ys[i]; continue; }
      px.push(xs[i]); py.push(ys[i]);
    }
    const out = new Array(grid.length).fill(null);
    if (px.length < 2) return out;
    let j = 0;
    for (let k = 0; k < grid.length; k++) {
      const g = grid[k];
      if (g < px[0] || g > px[px.length - 1]) continue;
      while (j < px.length - 2 && px[j + 1] < g) j++;
      const x0 = px[j], x1 = px[j + 1];
      const f = x1 > x0 ? (g - x0) / (x1 - x0) : 0;
      out[k] = py[j] + f * (py[j + 1] - py[j]);
    }
    return out;
  }

  /** Align two runs' display streams on a common distance (or time) grid.
   *  a/b: {t, dist_mi, pace_s, hr, elev_ft}. `mode` "distance" | "time".
   *  -> {grid, mode, a: {t, pace_s, hr, elev_ft, dist_mi}, b: {...}, gap} where
   *  gap = t_B − t_A at equal distance (distance mode; + means B is behind) or
   *  dist_A − dist_B at equal time (time mode; + means B is behind). */
  function alignRuns(a, b, mode = "distance", step) {
    const useTime = mode === "time" || !a.dist_mi || !b.dist_mi;
    const key = useTime ? "t" : "dist_mi";
    const end = Math.min(last(a[key]), last(b[key]));
    const st = step || (useTime ? Math.max(5, end / 600) : Math.max(0.02, end / 600));
    const grid = [];
    for (let x = 0; x <= end + 1e-9; x += st) grid.push(Math.round(x * 1000) / 1000);
    const side = (s) => {
      const o = {};
      for (const k of ["t", "dist_mi", "pace_s", "hr", "elev_ft"]) o[k] = s[k] ? resample(s[key], s[k], grid) : null;
      return o;
    };
    const A = side(a), B = side(b);
    const gap = grid.map((_, i) => useTime
      ? (A.dist_mi && B.dist_mi && A.dist_mi[i] != null && B.dist_mi[i] != null ? A.dist_mi[i] - B.dist_mi[i] : null)
      : (A.t[i] != null && B.t[i] != null ? B.t[i] - A.t[i] : null));
    return { grid, mode: useTime ? "time" : "distance", a: A, b: B, gap };
  }
  const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : 0);

  /** Fraction of route A's points within `tolM` meters of route B (coords [lon, lat]
   *  as in routes.geojson). Grid-hashed, so O(n) per pair. */
  function coverage(A, B, tolM = 40) {
    if (!A || !B || !A.length || !B.length) return 0;
    const lat0 = A[0][1], k = Math.cos((lat0 * Math.PI) / 180);
    const toXY = ([lo, la]) => [lo * 111320 * k, la * 111320];
    const cell = (x) => Math.floor(x / tolM);
    const grid = new Map();
    for (const p of B) {
      const [x, y] = toXY(p), key = cell(x) + "," + cell(y);
      (grid.get(key) || grid.set(key, []).get(key)).push([x, y]);
    }
    let hit = 0;
    for (const p of A) {
      const [x, y] = toXY(p), cx = cell(x), cy = cell(y);
      let ok = false;
      for (let dx = -1; dx <= 1 && !ok; dx++) for (let dy = -1; dy <= 1 && !ok; dy++) {
        const pts = grid.get(cx + dx + "," + (cy + dy));
        if (pts) for (const q of pts) if (Math.hypot(q[0] - x, q[1] - y) <= tolM) { ok = true; break; }
      }
      if (ok) hit++;
    }
    return hit / A.length;
  }
  /** Symmetric route similarity in [0, 1]: min of the two coverages. */
  const routeSimilarity = (A, B, tolM) => Math.min(coverage(A, B, tolM), coverage(B, A, tolM));

  const api = {
    BE_DISTANCES, M_PER_MI, dayNum, isoDay, dowOf, hourOf, pad2,
    streaks, effortsByRun, paceCurve, prTimeline, superlatives, biggestPeriods,
    cumulativeByYear, yearSummary, punchCard, histogram, rankOf, hrZoneTime,
    resample, alignRuns, coverage, routeSimilarity,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Analytics = api;
})(typeof window !== "undefined" ? window : globalThis);
