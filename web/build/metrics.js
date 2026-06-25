/* In-browser port of pipeline/metrics.py — derived metrics over a uniform record
 * stream ([{ t, lat, lon, ele_m, hr, dist_m, speed_ms, cad }]). Kept faithful to the
 * Python so the two implementations agree.
 */
export const M_PER_MI = 1609.344;
export const M_PER_FT = 0.3048;

const BEST_EFFORT_DISTANCES = [
  [400, "400m"], [805, "1/2 mi"], [1000, "1k"], [1609.344, "1 mi"], [3218.688, "2 mi"],
  [5000, "5k"], [10000, "10k"], [16093.44, "10 mi"], [21097.5, "Half"], [42195, "Marathon"],
];

/* Cumulative (distance, time) with paused/stopped/teleport steps removed, so best
 * efforts reflect real running. A step contributes neither distance nor time when it's
 * a recording gap (>30s), goes backwards, or implies >12 m/s (a GPS jump). */
export function cleanCumulative(t, dist) {
  const n = t.length, cdist = new Array(n), ctime = new Array(n);
  let ad = 0, at = 0;
  for (let i = 0; i < n; i++) {
    let dd = i === 0 ? 0 : (dist[i] != null && dist[i - 1] != null ? dist[i] - dist[i - 1] : 0);
    let dt = i === 0 ? 0 : t[i] - t[i - 1];
    const speed = dt > 0 ? dd / dt : 0;
    if (dt > 30 || dd < 0 || speed > 12) { dd = 0; dt = 0; }
    ad += dd; at += dt;
    cdist[i] = ad; ctime[i] = at;
  }
  return { dist: cdist, time: ctime };
}

/** Fastest moving time (seconds) covering each target distance — forward two-pointer. */
export function bestEfforts(records) {
  const s = records.filter((r) => r.dist_m != null && r.t != null).sort((a, b) => a.t - b.t);
  if (!s.length) return {};
  const { dist, time } = cleanCumulative(s.map((r) => r.t), s.map((r) => r.dist_m));
  const n = dist.length, total = dist[n - 1] - dist[0];
  const out = {};
  for (const [target, label] of BEST_EFFORT_DISTANCES) {
    if (total < target) continue;
    let best = Infinity, j = 0;
    for (let i = 0; i < n; i++) {
      if (j < i) j = i;
      while (j < n && dist[j] - dist[i] < target) j++;
      if (j >= n) break;
      best = Math.min(best, time[j] - time[i]);
    }
    if (isFinite(best) && best > 0) out[label] = best;
  }
  return out;
}

/** Per-mile splits: pace (sec/mi), avg HR, elevation change (ft). */
export function mileSplits(records) {
  const s = records.filter((r) => r.dist_m != null && r.t != null).sort((a, b) => a.t - b.t);
  if (!s.length) return [];
  const { dist, time } = cleanCumulative(s.map((r) => r.t), s.map((r) => r.dist_m));
  const splits = [];
  let mile = 1, start = 0;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] - dist[start] >= M_PER_MI) {
      const dt = time[i] - time[start], ddMi = (dist[i] - dist[start]) / M_PER_MI;
      const seg = s.slice(start, i + 1);
      const hrs = seg.map((r) => r.hr).filter((h) => h != null);
      const eles = seg.map((r) => r.ele_m).filter((e) => e != null);
      splits.push({
        mile,
        pace_s: ddMi ? dt / ddMi : null,
        hr: hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null,
        elev_ft: eles.length > 1 ? (eles[eles.length - 1] - eles[0]) / M_PER_FT : null,
      });
      mile++; start = i;
    }
  }
  return splits;
}

const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 10000) / 10000;
const r5 = (x) => Math.round(x * 100000) / 100000;

/** Compact stream for charts and maps. NOTE latlng is sampled on its own stride, so
 * (like the Python version) it does NOT line up index-for-index with t/dist/hr. */
export function downsampleStream(records, maxPoints = 600) {
  if (!records.length) return {};
  const step = Math.max(1, Math.floor(records.length / maxPoints));
  const d = [];
  for (let i = 0; i < records.length; i += step) d.push(records[i]);
  const has = (k) => d.some((r) => r[k] != null);
  const out = {};
  out.t = d.map((r) => r1(r.t));
  if (has("dist_m")) out.dist_mi = d.map((r) => (r.dist_m != null ? r3(r.dist_m / M_PER_MI) : null));
  if (has("speed_ms"))
    out.pace_s = d.map((r) => {
      if (r.speed_ms != null && r.speed_ms > 0.3) { const p = M_PER_MI / r.speed_ms; return p < 1800 ? r1(p) : null; }
      return null;
    });
  if (has("hr")) out.hr = d.map((r) => (r.hr != null ? Math.round(r.hr) : null));
  if (has("ele_m")) out.elev_ft = d.map((r) => (r.ele_m != null ? r1(r.ele_m / M_PER_FT) : null));
  if (has("cad")) out.cad = d.map((r) => (r.cad != null ? Math.round(r.cad) : null));

  const gps = records.filter((r) => r.lat != null && r.lon != null);
  if (gps.length) {
    const gstep = Math.max(1, Math.floor(gps.length / maxPoints));
    out.latlng = [];
    for (let i = 0; i < gps.length; i += gstep) out.latlng.push([r5(gps[i].lat), r5(gps[i].lon)]);
  }
  return out;
}

/** Pa:HR drift — efficiency factor (speed/HR) first half vs second half, as %.
 *  Lower is better; <5% on a long run marks strong aerobic durability. */
export function aerobicDecoupling(stream) {
  const pace = stream.pace_s, hr = stream.hr;
  if (!pace || !hr) return null;
  const n = Math.min(pace.length, hr.length), half = Math.floor(n / 2);
  if (half < 30) return null;
  const ef = (ps, hs) => {
    const sp = [], hh = [];
    for (let i = 0; i < ps.length; i++) if (ps[i] && hs[i] && ps[i] > 0) { sp.push(1 / ps[i]); hh.push(hs[i]); }
    if (sp.length < 10) return null;
    return sp.reduce((a, b) => a + b, 0) / sp.length / (hh.reduce((a, b) => a + b, 0) / hh.length);
  };
  const e1 = ef(pace.slice(0, half), hr.slice(0, half));
  const e2 = ef(pace.slice(half, n), hr.slice(half, n));
  if (!e1 || !e2) return null;
  return Math.round(((e1 - e2) / e1) * 100 * 10) / 10;
}

/** Climbing detail from the elevation profile — VAM (vertical ft/hr while climbing),
 *  time climbing/flat/descending, grade distribution by distance, steepest sustained
 *  grade. Elevation is resampled to even distance steps to smooth noise. Mirrors
 *  climb_metrics in metrics.py. */
export function climbMetrics(records, smoothM = 30, steep = 8, mod = 3, sustainM = 160) {
  const s = records.filter((r) => r.dist_m != null && r.t != null && r.ele_m != null)
    .sort((a, b) => a.t - b.t);
  if (s.length < 10) return {};
  const { dist, time } = cleanCumulative(s.map((r) => r.t), s.map((r) => r.dist_m));
  const ele = s.map((r) => r.ele_m);
  if (dist[dist.length - 1] - dist[0] < 200) return {};

  const edges = [];
  for (let x = dist[0]; x < dist[dist.length - 1]; x += smoothM) edges.push(x);
  if (edges.length < 3) return {};
  // linear interpolation of (cumulative dist → value) at each edge
  const interp = (xs, ys, x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    const t0 = xs[lo], t1 = xs[hi];
    return t1 === t0 ? ys[lo] : ys[lo] + ((x - t0) / (t1 - t0)) * (ys[hi] - ys[lo]);
  };
  const eleI = edges.map((x) => interp(dist, ele, x));
  const tI = edges.map((x) => interp(dist, time, x));

  const n = edges.length - 1;
  const grades = new Array(n), dDist = new Array(n);
  let ttSum = 0, ddSum = 0, ascFt = 0, climbT = 0, flatT = 0, descT = 0;
  for (let i = 0; i < n; i++) {
    const de = eleI[i + 1] - eleI[i], dd = edges[i + 1] - edges[i], dt = tI[i + 1] - tI[i];
    const g = dd > 0 ? (de / dd) * 100 : 0;
    grades[i] = g; dDist[i] = dd; ttSum += dt; ddSum += dd;
    if (de > 0) ascFt += de / M_PER_FT;
    if (g > mod) climbT += dt; else if (g < -mod) descT += dt; else flatT += dt;
  }
  const tt = ttSum || 1, ddTot = ddSum || 1, climbHrs = climbT / 3600;
  const vam = (climbHrs >= 0.033 && ascFt >= 100) ? ascFt / climbHrs : null;
  const bands = [[-1e9, -steep, "steep ↓"], [-steep, -mod, "↓"], [-mod, mod, "flat"],
    [mod, steep, "↑"], [steep, 1e9, "steep ↑"]];
  const grade_bands = bands.map(([lo, hi, label]) => {
    let sum = 0;
    for (let i = 0; i < n; i++) if (grades[i] >= lo && grades[i] < hi) sum += dDist[i];
    return { label, pct: Math.round((sum / ddTot) * 100) };
  });
  const win = Math.max(1, Math.round(sustainM / smoothM));
  let steepest = 0;
  for (let i = 0; i < eleI.length - win; i++) {
    const g = ((eleI[i + win] - eleI[i]) / (smoothM * win)) * 100;
    if (g > steepest) steepest = g;
  }
  return {
    vam_ft_hr: vam != null ? Math.round(vam) : null,
    pct_climb: Math.round((climbT / tt) * 100), pct_flat: Math.round((flatT / tt) * 100),
    pct_descend: Math.round((descT / tt) * 100), steepest_grade: Math.round(steepest * 10) / 10,
    grade_bands,
  };
}

/** Index-aligned GPS trajectory resampled to ~every_m spacing (for segment matching). */
export function buildTrajectory(records, everyM = 12) {
  const s = records
    .filter((r) => r.lat != null && r.lon != null && r.dist_m != null && r.t != null)
    .sort((a, b) => a.t - b.t);
  if (s.length < 2) return {};
  const keep = [0];
  let last = s[0].dist_m;
  for (let i = 1; i < s.length; i++) if (s[i].dist_m - last >= everyM) { keep.push(i); last = s[i].dist_m; }
  if (keep[keep.length - 1] !== s.length - 1) keep.push(s.length - 1);
  const out = {
    lat: keep.map((i) => r5(s[i].lat)), lon: keep.map((i) => r5(s[i].lon)),
    t: keep.map((i) => r1(s[i].t)), dist_mi: keep.map((i) => r4(s[i].dist_m / M_PER_MI)),
  };
  if (s.some((r) => r.hr != null)) out.hr = keep.map((i) => (s[i].hr != null ? Math.round(s[i].hr) : null));
  if (s.some((r) => r.speed_ms != null))
    out.pace_s = keep.map((i) => (s[i].speed_ms != null && s[i].speed_ms > 0.3 ? r1(M_PER_MI / s[i].speed_ms) : null));
  return out;
}
