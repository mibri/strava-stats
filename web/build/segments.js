/* In-browser port of pipeline/segments.py — mine repeated route segments from the
 * per-run trajectories (produced by the worker) and trend EF on each.
 *
 * Cells are represented as "cy,cx" strings so they work as Set keys; corridors and
 * cell-sets are JS Sets. Otherwise this mirrors the Python: traffic-ranked acceptance,
 * out-and-back pass extraction via axis projection, primary/reverse direction split.
 */
import { median } from "./classify.js";

const M_PER_MI = 1609.344;
const CELL_M = 40.0, MIN_RUNS = 3, MIN_LEN_MI = 0.3, MIN_NODES = 12;
const COVER = 0.8, ABSORB = 0.4, GAP_PTS = 8, MAX_SEGMENTS = 25;
const MPD_LAT = 111320.0;
const DIR8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const DAY_MS = 864e5;

const cell = (lat, lon, coslat) =>
  `${Math.round((lat * MPD_LAT) / CELL_M)},${Math.round((lon * MPD_LAT * coslat) / CELL_M)}`;
const dir8 = (bearing) => Math.floor((bearing + 22.5) / 45) % 8;
const interSize = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

function candidates(cellSeq, popular) {
  const out = [];
  let cur = [];
  for (const c of cellSeq) {
    if (popular.has(c)) {
      if (!cur.length || cur[cur.length - 1] !== c) cur.push(c);
    } else {
      if (cur.length >= MIN_NODES) out.push(new Set(cur));
      cur = [];
    }
  }
  if (cur.length >= MIN_NODES) out.push(new Set(cur));
  return out;
}

const coverage = (cand, trajs) =>
  trajs.filter((t) => interSize(cand, t._cellset) / cand.size >= COVER).length;

// Principal axis (north/east meters) of a corridor's cells, centroid, axis-extent.
function axisExtent(corridor) {
  const pts = [...corridor].map((k) => { const [cy, cx] = k.split(",").map(Number); return [cy * CELL_M, cx * CELL_M]; });
  const n = pts.length;
  const cen = [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  let a = 0, b = 0, c = 0;
  for (const p of pts) { const d0 = p[0] - cen[0], d1 = p[1] - cen[1]; a += d0 * d0; b += d0 * d1; c += d1 * d1; }
  const theta = 0.5 * Math.atan2(2 * b, a - c); // direction of max variance
  const axis = [Math.cos(theta), Math.sin(theta)];
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { const pr = (p[0] - cen[0]) * axis[0] + (p[1] - cen[1]) * axis[1]; if (pr < lo) lo = pr; if (pr > hi) hi = pr; }
  return { axis, cen, extent: hi - lo };
}

// Every clean traversal of a corridor by one run (one-way = 1 leg, out-and-back = 2).
function passes(traj, corridor, axis, cen, coslat, extent, meta, baseOrd) {
  const cells = traj._cells;
  const idxs = [];
  for (let i = 0; i < cells.length; i++) if (corridor.has(cells[i])) idxs.push(i);
  if (idxs.length < 2) return [];
  const proj = {};
  for (const i of idxs) proj[i] = (traj.lat[i] * MPD_LAT - cen[0]) * axis[0] + (traj.lon[i] * MPD_LAT * coslat - cen[1]) * axis[1];

  const groups = [];
  let cur = [idxs[0]];
  for (let k = 1; k < idxs.length; k++) {
    if (idxs[k] - cur[cur.length - 1] <= GAP_PTS) cur.push(idxs[k]);
    else { groups.push(cur); cur = [idxs[k]]; }
  }
  groups.push(cur);

  const efforts = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const pv = g.map((i) => proj[i]);
    const argmax = pv.indexOf(Math.max(...pv)), argmin = pv.indexOf(Math.min(...pv));
    const extPos = argmax !== 0 && argmax !== pv.length - 1 ? argmax : null;
    const extNeg = argmin !== 0 && argmin !== pv.length - 1 ? argmin : null;
    const turn = extPos != null ? extPos : extNeg;
    const spans = turn ? [[0, turn], [turn, g.length - 1]] : [[0, g.length - 1]];
    for (const [ai, bi] of spans) {
      if (Math.abs(pv[bi] - pv[ai]) < COVER * extent) continue;
      const lo = g[ai], hi = g[bi], direction = pv[bi] > pv[ai] ? 1 : -1;
      const dt = traj.t[hi] - traj.t[lo], dmi = traj.dist_mi[hi] - traj.dist_mi[lo];
      if (dt <= 0 || dmi <= 0) continue;
      const hrVals = [];
      for (let i = lo; i <= hi; i++) if (traj.hr && traj.hr[i] != null) hrVals.push(traj.hr[i]);
      const hr = hrVals.length ? hrVals.reduce((s, x) => s + x, 0) / hrVals.length : null;
      efforts.push({
        id: meta.id, date: meta.date, type: meta.type, _lo: lo, _hi: hi, _len: dmi, _dir: direction,
        _ord: Math.floor(+meta.date / DAY_MS) - baseOrd,
        time_s: Math.round(dt * 10) / 10, pace_s: Math.round((dt / dmi) * 10) / 10,
        hr: hr ? Math.round(hr * 10) / 10 : null,
        ef: hr ? Math.round(((dmi * M_PER_MI) / dt / hr) * 1e5) / 1e5 : null,
      });
    }
  }
  return efforts;
}

function trend(efforts) {
  const pts = efforts.filter((e) => e.ef != null).map((e) => [e._ord, e.ef]);
  if (pts.length < 4) return { metric: "ef", slope: null, label: "flat" };
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  const spanX = Math.max(...xs) - Math.min(...xs);
  const rel = spanX && my ? (slope * spanX) / my : 0;
  const label = rel > 0.03 ? "improving" : rel < -0.03 ? "declining" : "flat";
  return { metric: "ef", slope: Math.round(slope * 1e7) / 1e7, label };
}

const pub = (e) => ({ id: e.id, date: fmtDate(e.date), type: e.type, time_s: e.time_s, pace_s: e.pace_s, hr: e.hr, ef: e.ef });
const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const axisLabel = (axis, sign) => DIR8[dir8(((Math.atan2(axis[1] * sign, axis[0] * sign) * 180) / Math.PI + 360) % 360)];

function direction(efforts, axis) {
  const fwd = efforts.filter((e) => e._dir > 0), rev = efforts.filter((e) => e._dir < 0);
  const groups = [[fwd, 1], [rev, -1]].sort((a, b) => b[0].length - a[0].length);
  const dress = ([g, sign]) => {
    if (!g.length) return null;
    g.sort((a, b) => a.date - b.date);
    return { dir_label: axisLabel(axis, sign), n_runs: g.length, trend: trend(g), _efforts: g, efforts: g.map(pub) };
  };
  return [dress(groups[0]), dress(groups[1])];
}

/** trajsById: { id: { lat, lon, t, dist_mi, hr } }, runs: [{id,date,type}], home_bounds. */
export function buildSegments(trajsById, runs, homeBounds) {
  if (!homeBounds) return [];
  const [[s, w], [n, e]] = homeBounds;
  const coslat = Math.cos((((s + n) / 2) * Math.PI) / 180);
  const meta = Object.fromEntries(runs.map((r) => [r.id, { id: r.id, date: r.date, type: r.type }]));
  const baseOrd = Math.min(...runs.map((r) => Math.floor(+r.date / DAY_MS)));

  const trajs = [];
  const support = new Map();
  for (const [rid, traj] of Object.entries(trajsById)) {
    if (!traj || !traj.lat || traj.lat.length < MIN_NODES || !meta[rid]) continue;
    const mid = traj.lat.length >> 1;
    if (!(traj.lat[mid] >= s && traj.lat[mid] <= n && traj.lon[mid] >= w && traj.lon[mid] <= e)) continue;
    const cells = traj.lat.map((_, i) => cell(traj.lat[i], traj.lon[i], coslat));
    const t = { ...traj, id: rid, _cells: cells, _cellset: new Set(cells) };
    trajs.push(t);
    for (const c of t._cellset) { if (!support.has(c)) support.set(c, new Set()); support.get(c).add(rid); }
  }
  const popular = new Set([...support.entries()].filter(([, rs]) => rs.size >= MIN_RUNS).map(([c]) => c));
  if (!popular.size) return [];

  // candidates (deduped by canonical key)
  const seen = new Set(), cands = [];
  for (const t of trajs) {
    for (const c of candidates(t._cells, popular)) {
      const key = [...c].sort().join("|");
      if (!seen.has(key)) { seen.add(key); cands.push(c); }
    }
  }

  // traffic-ranked acceptance, then absorb candidates mostly inside an accepted one
  const sup = new Map(cands.map((c) => [c, coverage(c, trajs)]));
  const valid = cands.filter((c) => sup.get(c) >= MIN_RUNS).sort((a, b) => sup.get(b) * b.size - sup.get(a) * a.size);
  const accepted = [];
  for (const c of valid) {
    if (accepted.some((a) => interSize(c, a) / c.size >= ABSORB)) continue;
    accepted.push(c);
  }

  const segments = [];
  for (const corridor of accepted) {
    const { axis, cen, extent } = axisExtent(corridor);
    if (extent <= 0) continue;
    const efforts = [];
    for (const t of trajs) for (const ef of passes(t, corridor, axis, cen, coslat, extent, meta[t.id], baseOrd)) efforts.push(ef);
    if (efforts.length < MIN_RUNS) continue;

    const [primary, reverse] = direction(efforts, axis);
    if (!primary || primary.n_runs < MIN_RUNS) continue;
    const lengthMi = median(primary._efforts.map((e) => e._len));
    if (lengthMi < MIN_LEN_MI) continue;

    const rep = primary._efforts.reduce((best, e) => (Math.abs(e._len - lengthMi) < Math.abs(best._len - lengthMi) ? e : best));
    const rtraj = trajs.find((t) => t.id === rep.id);
    const polyline = [];
    for (let i = rep._lo; i <= rep._hi; i++) polyline.push([rtraj.lat[i], rtraj.lon[i]]);

    const seg = {
      dir_label: primary.dir_label, n_runs: primary.n_runs, length_mi: Math.round(lengthMi * 100) / 100,
      polyline, trend: primary.trend, efforts: primary.efforts, reverse: null,
    };
    if (reverse && reverse.n_runs >= MIN_RUNS) {
      seg.reverse = { dir_label: reverse.dir_label, n_runs: reverse.n_runs, trend: reverse.trend, efforts: reverse.efforts };
    }
    segments.push(seg);
  }

  segments.sort((a, b) => b.n_runs - a.n_runs || b.length_mi - a.length_mi);
  const top = segments.slice(0, MAX_SEGMENTS);
  top.forEach((seg, i) => { seg.id = `seg${i + 1}`; seg.name = `Segment ${i + 1} (${seg.dir_label})`; });
  return top;
}
