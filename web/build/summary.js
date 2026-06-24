/* In-browser port of pipeline/build.py's summary builders. Produces the summary.json
 * the dashboard consumes. Runs are expected to already carry: type, decoup, and
 * best_efforts (label -> seconds, from the worker), plus the CSV-derived fields.
 */
import { median, fmtDate, weekStart, monthStart, eachDay } from "./classify.js";

// label -> meters (mirrors metrics.BEST_EFFORT_DISTANCES / build.EFFORT_M)
export const EFFORT_M = {
  "400m": 400, "1/2 mi": 805, "1k": 1000, "1 mi": 1609.344, "2 mi": 3218.688,
  "5k": 5000, "10k": 10000, "10 mi": 16093.44, Half: 21097.5, Marathon: 42195,
};
const PR_LABELS = ["1 mi", "5k", "10k", "Half", "Marathon"];
const PROJ_TARGETS = ["1 mi", "5k", "10k", "Half", "Marathon"];
const PROJ_WINDOW_DAYS = 90;
const DAY_MS = 864e5;

const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const f = (v, nd) => (v == null || !isFinite(v) ? null : nd != null ? Math.round(v * 10 ** nd) / 10 ** nd : v);

function percentile(arr, p) {
  const a = arr.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = (a.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

// EWM mean, adjust=False (pandas): y0=x0; yi = a*xi + (1-a)*y(i-1), a=2/(span+1).
function ewm(x, span) {
  const a = 2 / (span + 1), out = new Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = i === 0 ? x[0] : a * x[i] + (1 - a) * out[i - 1];
  return out;
}

function estimateLoad(runs) {
  const have = runs.filter((r) => r.rel_effort != null && r.distance_mi > 0);
  const perMi = have.length >= 5 ? median(have.map((r) => r.rel_effort / r.distance_mi)) : 8.0;
  return runs.map((r) => (r.rel_effort != null ? r.rel_effort : r.distance_mi != null ? r.distance_mi * perMi : 0));
}

/** CTL (42d) / ATL (7d) / TSB + ACWR daily training-load curve. */
export function fitnessCurve(runs) {
  const load = estimateLoad(runs);
  const byDay = new Map();
  runs.forEach((r, i) => { const k = fmtDate(r.date); byDay.set(k, (byDay.get(k) || 0) + load[i]); });
  const dates = runs.map((r) => r.date);
  const days = eachDay(new Date(Math.min(...dates)), new Date(Math.max(...dates)));
  const daily = days.map((d) => byDay.get(fmtDate(d)) || 0);
  const ctl = ewm(daily, 42), atl = ewm(daily, 7);
  const rollSum = (n, i) => { let s = 0; for (let k = Math.max(0, i - n + 1); k <= i; k++) s += daily[k]; return s; };
  return days.map((d, i) => {
    const acute = i >= 6 ? rollSum(7, i) : null;
    const chronic = i >= 27 ? rollSum(28, i) / 4 : null;
    const acwr = acute != null && chronic ? acute / chronic : null;
    return {
      date: fmtDate(d), ctl: r1(ctl[i]), atl: r1(atl[i]),
      tsb: r1(ctl[i] - atl[i]), acwr: acwr != null && isFinite(acwr) ? Math.round(acwr * 100) / 100 : null,
    };
  });
}

/** Running-best efforts over time for each tracked distance. */
export function prProgression(runs) {
  const out = Object.fromEntries(PR_LABELS.map((l) => [l, []]));
  const best = {};
  for (const r of runs) {
    if (r.exclude_prog) continue;
    const eff = r.best_efforts || {};
    for (const label of PR_LABELS) {
      const t = eff[label];
      if (t == null) continue;
      const isPr = !(label in best) || t < best[label];
      if (isPr) best[label] = t;
      out[label].push({ date: fmtDate(r.date), id: r.id, time_s: Math.round(t * 10) / 10, time: fmtTime(t), is_pr: isPr });
    }
  }
  return out;
}

const fmtTime = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};

/** Predicted race times — personalized power-law (Riegel) over best efforts, 90d window. */
function fitnessProjection(runs) {
  const recs = runs.filter((r) => !r.exclude_prog && r.best_efforts && Object.keys(r.best_efforts).length)
    .map((r) => ({ d: r.date, eff: r.best_efforts }));
  const out = Object.fromEntries(PROJ_TARGETS.map((l) => [l, []]));
  for (const { d } of recs) {
    const lo = +d - PROJ_WINDOW_DAYS * DAY_MS;
    const best = {};
    for (const rec of recs) {
      if (+rec.d >= lo && +rec.d <= +d) {
        for (const [lbl, t] of Object.entries(rec.eff)) {
          if (EFFORT_M[lbl] >= 1000 && (!(lbl in best) || t < best[lbl])) best[lbl] = t;
        }
      }
    }
    const labels = Object.keys(best);
    if (!labels.length) continue;
    let b = 1.06;
    if (labels.length >= 2) {
      const X = labels.map((l) => Math.log(EFFORT_M[l])), Y = labels.map((l) => Math.log(best[l]));
      b = Math.min(1.18, Math.max(1.0, polyfitSlope(X, Y)));
    }
    for (const tgt of PROJ_TARGETS) {
      const T = EFFORT_M[tgt];
      const equivs = labels.filter((l) => T / 4 <= EFFORT_M[l] && EFFORT_M[l] <= T * 4)
        .map((l) => best[l] * (T / EFFORT_M[l]) ** b);
      if (equivs.length) out[tgt].push({ date: fmtDate(d), proj_s: Math.round(Math.min(...equivs)) });
    }
  }
  return out;
}

// least-squares slope of y on x (np.polyfit deg 1).
function polyfitSlope(x, y) {
  const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
  return den ? num / den : 0;
}

function runPoints(runs) {
  const out = [];
  for (const r of runs) {
    if (r.pace_s == null || r.exclude_prog) continue;
    const epm = r.distance_mi ? r.elev_gain_ft / r.distance_mi : null;
    out.push({
      id: r.id, date: fmtDate(r.date), type: r.type, dist: f(r.distance_mi, 2),
      pace_s: f(r.pace_s, 1), gap_s: f(r.gap_pace_s, 1), hr: f(r.avg_hr, 0),
      ef: f(r.ef), ef_gap: f(r.ef_gap), cadence: f(r.cadence, 0), temp_f: f(r.temp_f, 0),
      elev_pm: f(epm, 0), rel_effort: f(r.rel_effort, 0), decoup: f(r.decoup, 1),
    });
  }
  return out;
}

function dailyMiles(runs) {
  const byDay = new Map();
  for (const r of runs) { const k = fmtDate(r.date); byDay.set(k, (byDay.get(k) || 0) + (r.distance_mi || 0)); }
  const dates = runs.map((r) => r.date);
  return eachDay(new Date(Math.min(...dates)), new Date(Math.max(...dates)))
    .map((d) => ({ date: fmtDate(d), miles: r1(byDay.get(fmtDate(d)) || 0) }));
}

function patterns(runs) {
  const dow = new Map(), hours = new Map();
  for (const r of runs) {
    const wd = (r.date.getDay() + 6) % 7; // 0=Mon (pandas dayofweek)
    const o = dow.get(wd) || { runs: 0, miles: 0, paces: [] };
    o.runs++; o.miles += r.distance_mi || 0; if (r.pace_s != null) o.paces.push(r.pace_s);
    dow.set(wd, o);
    const h = r.date.getHours();
    hours.set(h, (hours.get(h) || 0) + 1);
  }
  return {
    dow: [...dow.entries()].sort((a, b) => a[0] - b[0]).map(([d, o]) =>
      ({ dow: d, runs: o.runs, miles: r1(o.miles), pace_s: f(median(o.paces), 1) })),
    hours: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([h, n]) => ({ hour: h, runs: n })),
  };
}

function hrZones(runs) {
  const hrs = runs.map((r) => r.avg_hr).filter((h) => h != null);
  if (!hrs.length) return {};
  const maxHrs = runs.map((r) => r.max_hr).filter((h) => h != null);
  const hrmax = maxHrs.length ? percentile(maxHrs, 0.99) : Math.max(...hrs) / 0.9;
  const bands = [["Z1", "Recovery", 0, 0.6], ["Z2", "Easy", 0.6, 0.7], ["Z3", "Aerobic", 0.7, 0.8],
    ["Z4", "Threshold", 0.8, 0.9], ["Z5", "Max", 0.9, 2.0]];
  const zones = bands.map(([z, lbl, lo, hi]) => {
    const m = runs.filter((r) => r.avg_hr != null && r.avg_hr >= lo * hrmax && r.avg_hr < hi * hrmax);
    return { zone: z, label: lbl, runs: m.length, time_h: r1(sum(m, (r) => r.moving_s) / 3600),
      lo: Math.floor(lo * hrmax), hi: hi < 2 ? Math.floor(hi * hrmax) : null };
  });
  return { hrmax: Math.round(hrmax), zones };
}

// Group runs into time buckets, fill gaps, emit [{x, ...aggregates}].
function bucketSeries(runs, keyFn, fields, fill) {
  const groups = new Map();
  for (const r of runs) {
    const k = keyFn(r.date);
    const g = groups.get(k) || {};
    for (const [name, fn] of Object.entries(fields)) g[name] = (g[name] || 0) + (fn(r) || 0);
    groups.set(k, g);
  }
  let keys = [...groups.keys()].sort();
  if (fill) keys = fill(keys);
  return keys.map((x) => ({ x, ...Object.fromEntries(Object.keys(fields).map((n) => [n, r1(groups.get(x)?.[n] || 0)])) }));
}

export function buildSummary(runs) {
  const totalMi = sum(runs, (r) => r.distance_mi), totalElev = sum(runs, (r) => r.elev_gain_ft);
  const dates = runs.map((r) => r.date);
  const fields = { miles: (r) => r.distance_mi, runs: () => 1, time_s: (r) => r.moving_s, elev_ft: (r) => r.elev_gain_ft, load: (r) => r.rel_effort };

  // weekly: fill every Monday between first and last week
  const weekly = bucketSeries(runs, (d) => fmtDate(weekStart(d)), fields, (keys) => {
    const all = []; const start = weekStart(dates.reduce((a, b) => (a < b ? a : b)));
    const end = weekStart(dates.reduce((a, b) => (a > b ? a : b)));
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 7)) all.push(fmtDate(d));
    return all;
  });
  const monthly = bucketSeries(runs, monthStart, { miles: (r) => r.distance_mi, runs: () => 1, time_s: (r) => r.moving_s });

  const easy = runs.filter((r) => ["easy", "recovery", "long"].includes(r.type)).length;
  const hard = runs.filter((r) => ["workout", "race"].includes(r.type)).length;

  const photos = [];
  for (const r of runs) for (const file of r.photos || []) photos.push({ id: r.id, date: fmtDate(r.date), name: String(r.name), file });

  return {
    totals: {
      runs: runs.length, miles: r1(totalMi), hours: Math.round((sum(runs, (r) => r.moving_s) / 3600) * 10) / 10,
      elev_ft: Math.round(totalElev), elev_everest: Math.round((totalElev / 29032) * 100) / 100,
      earth_pct: Math.round((totalMi / 24901) * 100 * 100) / 100, calories: Math.round(sum(runs, (r) => r.calories)),
      first: fmtDate(new Date(Math.min(...dates))), last: fmtDate(new Date(Math.max(...dates))),
    },
    weekly, monthly,
    easy_hard_split: { easy, hard },
    points: runPoints(runs),
    daily_miles: dailyMiles(runs),
    patterns: patterns(runs),
    hr_zones: hrZones(runs),
    projections: fitnessProjection(runs),
    photos,
  };
}
