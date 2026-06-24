/* In-browser port of the Strava-export pipeline.
 *
 * Goal: produce the same JSON the Python pipeline writes to data/clean/, but compute
 * it client-side from a dropped export zip so the dashboard can run with no backend
 * and no upload (the file never leaves the browser).
 *
 * Phase 1 (here): unzip + parse activities.csv → runs + the CSV-derivable summary
 * (totals / weekly / daily mileage). Track parsing (.fit/.gpx → streams, routes,
 * best efforts, segments) is a later phase; see web/build/ TODO.
 *
 * Mirrors pipeline/build.py:load_runs_csv and the CSV-only parts of build_summary so
 * the two implementations stay in agreement.
 *
 * Depends on globals loaded by the host page: `Papa` (papaparse), `fflate`.
 */

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

// Strava's activities.csv repeats column names ("Distance", "Elapsed Time", "Max
// Heart Rate", …). pandas disambiguates the 2nd+ occurrence as "Name.1"; we replicate
// that exactly so our column keys match build.py (which reads "Distance.1", etc.).
function dedupeHeaders(h) {
  const seen = {};
  return h.map((n) => {
    seen[n] = (seen[n] ?? -1) + 1;
    return seen[n] === 0 ? n : `${n}.${seen[n]}`;
  });
}

const num = (v) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : null;
};

// Strava's "Activity Date" is UTC wall-clock with no zone marker. Parse it as a true
// UTC instant; localization to the run's GPS timezone happens later (localizeDates).
function parseUtc(str) {
  let d = new Date((str || "") + " UTC");
  if (isNaN(d)) d = new Date(str);
  return d;
}
// A Date whose LOCAL fields equal the given wall-clock parts, so the rest of the
// pipeline can read it with normal getters regardless of the browser's own timezone.
const wallClock = (y, mo, d, h, mi, s) => new Date(y, mo, d, h, mi, s);

const fmtDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** activities.csv text → array of run objects (imperial), runs only, sorted by date. */
export function parseActivitiesCsv(text) {
  const rows = Papa.parse(text.replace(/^﻿/, "").trim(), { skipEmptyLines: true }).data;
  if (!rows.length) return [];
  const header = dedupeHeaders(rows[0]);
  const idx = Object.fromEntries(header.map((n, i) => [n, i]));
  const get = (r, n) => (idx[n] != null ? r[idx[n]] : undefined);

  const runs = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (get(r, "Activity Type") !== "Run") continue;

    const distM = num(get(r, "Distance.1")); // meters (the 2nd "Distance" column)
    const movingS = num(get(r, "Moving Time"));
    const distMi = distM != null ? distM / M_PER_MI : null;
    const avgHr = num(get(r, "Average Heart Rate"));
    const gap = num(get(r, "Average Grade Adjusted Pace")); // m/s
    const steps = num(get(r, "Total Steps"));
    const elevGain = num(get(r, "Elevation Gain"));
    const elevLoss = num(get(r, "Elevation Loss"));
    const tempC = num(get(r, "Weather Temperature"));

    // Cadence: the CSV's Average Cadence is empty, so derive from total steps / time
    // (Strava counts both feet), and drop implausible values — same as build.py.
    let cadence = steps && movingS ? steps / (movingS / 60) : null;
    if (cadence != null && (cadence < 120 || cadence > 240)) cadence = null;

    const utc = parseUtc(get(r, "Activity Date"));
    runs.push({
      id: String(get(r, "Activity ID")),
      _utc: utc, // true UTC instant (localized in buildAll once GPS coords are known)
      date: wallClock(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(),
        utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds()),
      name: get(r, "Activity Name") || "Run",
      description: (get(r, "Activity Description") || "").replace(/\s+/g, " ").trim(),
      distance_mi: distMi,
      moving_s: movingS,
      elapsed_s: num(get(r, "Elapsed Time.1")),
      pace_s: movingS != null && distMi ? movingS / distMi : null,
      gap_pace_s: gap ? M_PER_MI / gap : null,
      avg_hr: avgHr,
      max_hr: num(get(r, "Max Heart Rate.1")),
      elev_gain_ft: elevGain != null ? elevGain / M_PER_FT : null,
      elev_loss_ft: elevLoss != null ? elevLoss / M_PER_FT : null,
      avg_grade: num(get(r, "Average Grade")),
      cadence,
      calories: num(get(r, "Calories")),
      rel_effort: num(get(r, "Relative Effort.1")),
      temp_f: tempC != null ? (tempC * 9) / 5 + 32 : null,
      weather: get(r, "Weather Condition") || "",
      filename: get(r, "Filename") || "",
      photos: (get(r, "Media") || "").split("|").filter((p) => p.startsWith("media/")),
      // Efficiency factor: speed per heartbeat (higher = more aerobically fit).
      ef: distM && movingS && avgHr ? distM / movingS / avgHr : null,
      // Grade-adjusted EF: flat-equivalent speed per heartbeat.
      ef_gap: gap && avgHr ? gap / avgHr : null,
    });
  }
  runs.sort((a, b) => a.date - b.date);
  return runs;
}

// Week bucket anchored to Monday (matches pandas W-SUN start_time).
function weekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return fmtDate(x);
}

/** CSV-derivable slice of summary.json: totals + weekly + daily mileage. */
export function summarize(runs) {
  const miles = runs.reduce((s, r) => s + (r.distance_mi || 0), 0);
  const totals = {
    runs: runs.length,
    miles: Math.round(miles),
    first: runs.length ? fmtDate(runs[0].date) : null,
    last: runs.length ? fmtDate(runs[runs.length - 1].date) : null,
  };

  const wk = new Map();
  for (const r of runs) {
    const k = weekStart(r.date);
    const o = wk.get(k) || { x: k, miles: 0, runs: 0 };
    o.miles += r.distance_mi || 0;
    o.runs += 1;
    wk.set(k, o);
  }
  const weekly = [...wk.values()]
    .sort((a, b) => (a.x < b.x ? -1 : 1))
    .map((o) => ({ ...o, miles: +o.miles.toFixed(1) }));

  const dy = new Map();
  for (const r of runs) {
    const k = fmtDate(r.date);
    dy.set(k, (dy.get(k) || 0) + (r.distance_mi || 0));
  }
  const daily_miles = [...dy.entries()]
    .sort()
    .map(([date, m]) => ({ date, miles: +m.toFixed(2) }));

  return { totals, weekly, daily_miles };
}

/** Find activities.csv inside an unzipped export (it may be nested in a folder). */
function findCsv(files) {
  const key = Object.keys(files).find((k) => /(^|\/)activities\.csv$/i.test(k));
  if (!key) throw new Error("activities.csv not found in the export zip");
  return fflate.strFromU8(files[key]);
}

/* Parse every run's track file in a worker. Resolves to { streams, routes }:
 *   streams[id] = { best_efforts, splits, stream, traj, decoup }
 *   routes      = GeoJSON FeatureCollection (LineString per run, lon,lat order)
 * `onProgress({done,total})` fires as files complete. */
export function buildTracks(files, runs, onProgress) {
  // Match each run's "activities/<file>" against the unzipped keys (which may carry
  // an export-folder prefix) by basename.
  const byBase = {};
  for (const k of Object.keys(files)) byBase[k.split("/").pop()] = k;
  const meta = {};
  const jobs = [];
  for (const r of runs) {
    if (!r.filename) continue;
    const key = byBase[r.filename.split("/").pop()];
    if (!key) continue;
    jobs.push({ id: r.id, filename: key, bytes: files[key] });
    meta[r.id] = r;
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || "worker error")); };
    worker.onmessage = (e) => {
      if (e.data.type === "progress") { onProgress?.(e.data); return; }
      const { streams, routes, failures } = e.data;
      const features = routes
        .filter((r) => meta[r.id])
        .map((r) => {
          const m = meta[r.id];
          return {
            type: "Feature",
            properties: { id: r.id, name: m.name, type: m.type || "run",
              date: r.date ? r.date : (m.date instanceof Date ? m.date.toISOString().slice(0, 10) : ""),
              distance_mi: m.distance_mi != null ? +m.distance_mi.toFixed(2) : null },
            geometry: { type: "LineString", coordinates: r.latlng.map(([la, lo]) => [lo, la]) },
          };
        });
      worker.terminate();
      resolve({ streams, routes: { type: "FeatureCollection", features }, failures });
    };
    worker.postMessage({ jobs });
  });
}

/** Top-level entry: export zip (ArrayBuffer) → { runs, summary, files }.
 *  `files` (the raw unzipped map) is returned so callers can parse tracks via buildTracks. */
export async function buildFromZip(arrayBuffer) {
  const files = fflate.unzipSync(new Uint8Array(arrayBuffer));
  const runs = parseActivitiesCsv(findCsv(files));
  return { runs, summary: summarize(runs), files };
}

const fmtPaceStr = (s) =>
  s == null || !isFinite(s) ? null : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const fmtDateTime = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// One row per run for the runs table (mirrors build.py's runs.json columns the UI uses).
function runsTable(runs, gpsIds) {
  return runs.map((r) => ({
    id: r.id, date: fmtDateTime(r.date), name: String(r.name), type: r.type,
    description: r.description || "", distance_mi: round(r.distance_mi, 2),
    moving_s: r.moving_s, elapsed_s: r.elapsed_s, pace_s: round(r.pace_s, 1), pace: fmtPaceStr(r.pace_s),
    gap_pace_s: round(r.gap_pace_s, 1), gap_pace: fmtPaceStr(r.gap_pace_s),
    avg_hr: r.avg_hr, max_hr: r.max_hr, ef: round(r.ef, 4),
    elev_gain_ft: round(r.elev_gain_ft, 0), elev_loss_ft: round(r.elev_loss_ft, 0),
    avg_grade: r.avg_grade, cadence: round(r.cadence, 0), calories: r.calories, rel_effort: r.rel_effort,
    temp_f: round(r.temp_f, 0), weather: r.weather || "", n_photos: (r.photos || []).length,
    exclude_prog: false, has_gps: gpsIds.has(r.id),
  }));
}
const round = (v, nd) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** nd) / 10 ** nd);

// Localize each run's UTC instant to its GPS-start timezone (mirrors build.py's
// localize_dates), so time-of-day, weekly/daily buckets and the fitness curve are
// correct even on trips. GPS-less runs fall back to the most common timezone.
async function localizeDates(runs, routes) {
  let tzlookup = null;
  try {
    const ns = await import("https://cdn.jsdelivr.net/npm/tz-lookup@6.1.25/+esm");
    tzlookup = ns.default?.default || ns.default || ns;
  } catch (e) { /* offline: keep UTC wall-clock */ }
  if (typeof tzlookup !== "function") return;

  const startById = {};
  for (const f of routes.features) {
    const c = f.geometry.coordinates[0];
    if (c) startById[f.properties.id] = [c[1], c[0]]; // [lat, lon]
  }
  const tzById = {}, counts = {};
  for (const r of runs) {
    const ll = startById[r.id];
    let tz = null;
    if (ll) { try { tz = tzlookup(ll[0], ll[1]); } catch (e) { /* ignore */ } }
    tzById[r.id] = tz;
    if (tz) counts[tz] = (counts[tz] || 0) + 1;
  }
  const home = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "UTC";
  for (const r of runs) {
    const tz = tzById[r.id] || home;
    try {
      const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const p = {};
      for (const x of f.formatToParts(r._utc)) p[x.type] = x.value;
      r.date = wallClock(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    } catch (e) { /* keep UTC wall-clock */ }
  }
}

/** Full in-browser build: export zip → the complete dataset the dashboard consumes
 *  ({ summary, runs, routes, segments, streams }), matching the Python clean/ output.
 *  onProgress({phase, done, total}) reports track-parsing progress. */
export async function buildAll(arrayBuffer, onProgress) {
  const [{ buildSummary, fitnessCurve, prProgression }, classify, { buildRegions }, { buildSegments }] =
    await Promise.all([import("./summary.js"), import("./classify.js"), import("./regions.js"), import("./segments.js")]);

  onProgress?.({ phase: "unzip" });
  const files = fflate.unzipSync(new Uint8Array(arrayBuffer));
  const runs = parseActivitiesCsv(findCsv(files));

  onProgress?.({ phase: "tracks", done: 0, total: runs.length });
  const { streams, routes } = await buildTracks(files, runs, (p) => onProgress?.({ phase: "tracks", ...p }));

  onProgress?.({ phase: "summary" });
  await localizeDates(runs, routes); // UTC → GPS-local wall-clock before any date bucketing
  // Attach track-derived fields, then classify (data-driven, needs split stats + week flag).
  for (const r of runs) {
    const st = streams[r.id];
    r.best_efforts = st?.best_efforts || {};
    r.decoup = st?.decoup ?? null;
    const ss = classify.splitStats(st?.splits || []);
    r.split_spread = ss.split_spread; r.min_split = ss.min_split;
  }
  classify.addWeekLong(runs);
  classify.classifyRuns(runs);

  const summary = buildSummary(runs);
  summary.fitness = fitnessCurve(runs);
  summary.pr_progression = prProgression(runs);
  summary.regions = buildRegions(routes.features);

  onProgress?.({ phase: "segments" });
  const trajsById = {};
  for (const [id, st] of Object.entries(streams)) if (st.traj) trajsById[id] = st.traj;
  const homeBounds = summary.regions[0]?.bounds || null;
  const segments = buildSegments(trajsById, runs, homeBounds);

  // Per-run detail files (drop the internal trajectory), keyed by id.
  const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
  const streamDetails = {};
  for (const [id, st] of Object.entries(streams)) {
    const r = byId[id];
    streamDetails[id] = {
      id, name: r?.name, type: r?.type, date: r ? fmtDateTime(r.date) : null,
      distance_mi: round(r?.distance_mi, 2), photos: r?.photos || [],
      splits: st.splits, best_efforts: Object.fromEntries(Object.entries(st.best_efforts).map(([k, v]) =>
        [k, { s: Math.round(v * 10) / 10, t: fmtTimeStr(v) }])),
      stream: st.stream,
    };
  }

  const gpsIds = new Set(routes.features.map((f) => f.properties.id));
  return { summary, runs: runsTable(runs, gpsIds), routes, segments, streams: streamDetails };
}

const fmtTimeStr = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
