"""Mine repeated route segments from GPS and trend performance (EF) on each.

The Strava export ships no segment definitions, so we derive them: snap every run's
trajectory to a grid, find corridors of cells that >= MIN_RUNS runs traverse, dedupe
overlapping/nested corridors in favour of the longest, then trend each.

Geometry is **direction-agnostic** — one corridor per street stretch, no matter which
side or which way you ran it (that's what stops "up Polk" and "down Polk", or the two
sides of a street, from showing up as separate parallel segments). Direction still
matters for the *numbers*, so each corridor's efforts are split into a primary and a
reverse direction (uphill ≠ downhill); the trend/colour use the primary direction.

Headline metric is EF — efficiency factor, speed/HR, the same quantity build.py uses
per run (``(Distance/moving_s)/avg_hr``). Within a fixed segment distance is held
constant, so EF separates "faster because fitter" from "faster because fresh / sent it."

Scope: the home region only (bounds passed in from the top route cluster).
"""
from __future__ import annotations

import math

import numpy as np

from .metrics import M_PER_MI

# ---- tuning knobs (expect to adjust on real output) ----
CELL_M = 40.0          # grid cell edge; coarse enough to merge both sides of a street
MIN_RUNS = 3           # a corridor must be run >= this often (in its primary direction)
MIN_LEN_MI = 0.3       # drop trivial corridors — we want longer sections
MIN_NODES = 12         # cheap pre-filter (~MIN_LEN_MI / CELL_M) before measuring length
COVER = 0.80           # a run "did" a corridor if it hits >= this frac of its cells
ABSORB = 0.40          # drop a candidate >= this fraction of which sits inside an accepted one
GAP_PTS = 8            # bridge this many off-corridor traj points when finding the pass
MAX_SEGMENTS = 25      # keep it a handful of the most-run sections

_MPD_LAT = 111320.0    # meters per degree latitude
_DIR8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def _cell(lat, lon, coslat):
    return (int(round(lat * _MPD_LAT / CELL_M)),
            int(round(lon * _MPD_LAT * coslat / CELL_M)))


def _dir8(bearing):
    return int((bearing + 22.5) // 45) % 8


def _cells_for_run(traj, coslat):
    return [_cell(traj["lat"][i], traj["lon"][i], coslat) for i in range(len(traj["lat"]))]


def _candidates(cell_seq, popular):
    """Maximal contiguous stretches of popular cells, as frozensets."""
    out, cur = [], []
    for c in cell_seq:
        if c in popular:
            if not cur or cur[-1] != c:    # collapse consecutive repeats
                cur.append(c)
        else:
            if len(cur) >= MIN_NODES:
                out.append(frozenset(cur))
            cur = []
    if len(cur) >= MIN_NODES:
        out.append(frozenset(cur))
    return out


def _coverage(cand, trajs):
    """How many runs cover >= COVER of a candidate's cells (its real traffic)."""
    return sum(1 for t in trajs.values()
               if len(cand & t["_cellset"]) / len(cand) >= COVER)


def _axis_extent(corridor, coslat):
    """Principal axis (in north/east meters) of a corridor's cells, its centroid, and
    how far the corridor runs along that axis."""
    pts = np.array([[cy * CELL_M, cx * CELL_M] for (cy, cx) in corridor], float)
    cen = pts.mean(0)
    d = pts - cen
    _, vecs = np.linalg.eigh(d.T @ d)
    axis = vecs[:, -1]                  # eigenvector of the largest eigenvalue
    proj = d @ axis
    return axis, cen, float(proj.max() - proj.min())


def _passes(traj, corridor, axis, cen, coslat, extent, meta):
    """Every clean traversal of a corridor by one run. Projecting each matched point
    onto the corridor axis turns a one-way run into a single monotonic leg and an
    out-and-back into two opposite legs (split at the turnaround), so both directions
    are measured. Returns a list of effort dicts (dir = +1 / -1 along the axis)."""
    cells = traj["_cells"]
    idxs = [i for i, c in enumerate(cells) if c in corridor]
    if len(idxs) < 2:
        return []
    proj = {i: (traj["lat"][i] * _MPD_LAT - cen[0]) * axis[0]
              + (traj["lon"][i] * _MPD_LAT * coslat - cen[1]) * axis[1] for i in idxs}

    # group by index gaps (separate visits), then split each group at its turnaround
    groups, cur = [], [idxs[0]]
    for k in idxs[1:]:
        if k - cur[-1] <= GAP_PTS:
            cur.append(k)
        else:
            groups.append(cur); cur = [k]
    groups.append(cur)

    legs = []
    for g in groups:
        if len(g) < 2:
            continue
        pv = [proj[i] for i in g]
        ext_pos = pv.index(max(pv)) if pv.index(max(pv)) not in (0, len(pv) - 1) else None
        ext_neg = pv.index(min(pv)) if pv.index(min(pv)) not in (0, len(pv) - 1) else None
        turn = ext_pos if ext_pos is not None else ext_neg   # interior extreme = turnaround
        spans = [(0, turn), (turn, len(g) - 1)] if turn else [(0, len(g) - 1)]
        for a, b in spans:
            if abs(pv[b] - pv[a]) >= COVER * extent:          # leg covers most of the corridor
                legs.append((g[a], g[b], 1 if pv[b] > pv[a] else -1))

    efforts = []
    for lo, hi, direction in legs:
        dt = traj["t"][hi] - traj["t"][lo]
        dmi = traj["dist_mi"][hi] - traj["dist_mi"][lo]
        if dt <= 0 or dmi <= 0:
            continue
        hr_vals = [traj["hr"][i] for i in range(lo, hi + 1)
                   if traj.get("hr") and traj["hr"][i] is not None]
        hr = float(np.mean(hr_vals)) if hr_vals else None
        efforts.append({
            "id": meta["id"], "date": meta["date"], "type": meta["type"],
            "_lo": lo, "_hi": hi, "_len": dmi, "_dir": direction,
            "time_s": round(dt, 1), "pace_s": round(dt / dmi, 1),
            "hr": round(hr, 1) if hr else None,
            "ef": round((dmi * M_PER_MI / dt) / hr, 5) if hr else None,
        })
    return efforts


def _trend(efforts):
    """Linear EF-vs-time fit → label. Higher EF = better, so positive slope improves."""
    pts = [(e["_ord"], e["ef"]) for e in efforts if e["ef"] is not None]
    if len(pts) < 4:
        return {"metric": "ef", "slope": None, "label": "flat"}
    xs = np.array([p[0] for p in pts], float)
    ys = np.array([p[1] for p in pts], float)
    slope = float(np.polyfit(xs, ys, 1)[0])
    span, mean = xs.max() - xs.min(), ys.mean()
    rel = slope * span / mean if (span and mean) else 0.0
    label = "improving" if rel > 0.03 else "declining" if rel < -0.03 else "flat"
    return {"metric": "ef", "slope": round(slope, 7), "label": label}


def _public(e):
    """Effort record minus the internal _-prefixed fields."""
    return {"id": e["id"], "date": e["date"].strftime("%Y-%m-%d"), "type": e["type"],
            "time_s": e["time_s"], "pace_s": e["pace_s"], "hr": e["hr"], "ef": e["ef"]}


def _axis_label(axis, sign):
    """Compass label for travelling along `axis` in the +/- `sign` direction."""
    bearing = math.degrees(math.atan2(axis[1] * sign, axis[0] * sign)) % 360.0
    return _DIR8[_dir8(bearing)]


def _direction(efforts, axis):
    """Split efforts by which way they ran the corridor (+/- along its axis) and dress
    each side with a label + trend. Returns (primary, reverse|None), larger group first."""
    fwd = [e for e in efforts if e["_dir"] > 0]
    rev = [e for e in efforts if e["_dir"] < 0]
    groups = sorted([(fwd, 1), (rev, -1)], key=lambda g: len(g[0]), reverse=True)

    def dress(g, sign):
        if not g:
            return None
        g.sort(key=lambda e: e["date"])
        return {"dir_label": _axis_label(axis, sign), "n_runs": len(g),
                "trend": _trend(g), "_efforts": g, "efforts": [_public(e) for e in g]}

    return dress(*groups[0]), dress(*groups[1])


def build_segments(parsed: dict, runs, home_bounds) -> list[dict]:
    if not home_bounds:
        return []
    (s, w), (n, e) = home_bounds
    coslat = math.cos(math.radians((s + n) / 2))

    meta = {r["id"]: {"id": r["id"], "date": r["date"], "type": r["type"]}
            for _, r in runs.iterrows()}
    base_ord = min((m["date"].toordinal() for m in meta.values()), default=0)

    # ---- per-run cells, restricted to the home region ----
    trajs: dict[str, dict] = {}
    support: dict = {}
    for rid, p in parsed.items():
        traj = p.get("traj")
        if not traj or len(traj.get("lat", [])) < MIN_NODES:
            continue
        mid = len(traj["lat"]) // 2
        if not (s <= traj["lat"][mid] <= n and w <= traj["lon"][mid] <= e):
            continue
        cells = _cells_for_run(traj, coslat)
        traj = dict(traj); traj["_cells"] = cells; traj["_cellset"] = set(cells)
        trajs[rid] = traj
        for c in traj["_cellset"]:
            support.setdefault(c, set()).add(rid)

    popular = {c for c, rs in support.items() if len(rs) >= MIN_RUNS}
    if not popular:
        return []

    # ---- candidate corridors ----
    seen, cands = set(), []
    for traj in trajs.values():
        for c in _candidates(traj["_cells"], popular):
            if c not in seen:
                seen.add(c); cands.append(c)

    # Accept by *traffic* (runs covering it x length), not raw length: a long route
    # that only a couple of runs did in full must not outrank — or absorb — a shorter
    # corridor that dozens of runs actually share (e.g. the Embarcadero waterfront).
    # Then drop any later candidate that sits mostly inside one already accepted.
    sup = {c: _coverage(c, trajs) for c in cands}
    valid = [c for c in cands if sup[c] >= MIN_RUNS]
    valid.sort(key=lambda c: sup[c] * len(c), reverse=True)

    accepted: list[frozenset] = []
    for c in valid:
        if any(len(c & a) / len(c) >= ABSORB for a in accepted):
            continue
        accepted.append(c)

    # ---- measure each corridor ----
    segments = []
    for corridor in accepted:
        axis, cen, extent = _axis_extent(corridor, coslat)
        if extent <= 0:
            continue
        efforts = []
        for rid, traj in trajs.items():
            for ef in _passes(traj, corridor, axis, cen, coslat, extent, meta[rid]):
                ef["_ord"] = ef["date"].toordinal() - base_ord
                efforts.append(ef)
        if len(efforts) < MIN_RUNS:
            continue

        primary, reverse = _direction(efforts, axis)
        if not primary or primary["n_runs"] < MIN_RUNS:
            continue
        length_mi = float(np.median([e["_len"] for e in primary["_efforts"]]))
        if length_mi < MIN_LEN_MI:
            continue

        rep = min(primary["_efforts"], key=lambda e: abs(e["_len"] - length_mi))
        rtraj = trajs[rep["id"]]
        polyline = [[rtraj["lat"][i], rtraj["lon"][i]] for i in range(rep["_lo"], rep["_hi"] + 1)]

        seg = {
            "dir_label": primary["dir_label"], "n_runs": primary["n_runs"],
            "length_mi": round(length_mi, 2), "polyline": polyline,
            "trend": primary["trend"], "efforts": primary["efforts"],
            "reverse": None,
        }
        if reverse and reverse["n_runs"] >= MIN_RUNS:
            seg["reverse"] = {"dir_label": reverse["dir_label"], "n_runs": reverse["n_runs"],
                              "trend": reverse["trend"], "efforts": reverse["efforts"]}
        segments.append(seg)

    segments.sort(key=lambda s: (s["n_runs"], s["length_mi"]), reverse=True)
    segments = segments[:MAX_SEGMENTS]
    for i, s in enumerate(segments):
        s["id"] = f"seg{i + 1}"
        s["name"] = f"Segment {i + 1} ({s['dir_label']})"
    return segments
