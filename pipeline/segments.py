"""Mine repeated route segments from GPS and trend performance on each.

The Strava export ships no segment definitions, so we derive them: snap every run's
trajectory to a ~30 m grid, find corridors of cells that >= MIN_RUNS runs traverse in
the *same direction*, dedupe nested/near-duplicate corridors, then for each surviving
corridor compute a per-run effort (time / pace / HR / EF) and a fitness trend.

Headline metric is EF — efficiency factor, speed/HR, the same quantity build.py uses
per run (``(Distance/moving_s)/avg_hr``). Within a fixed segment the distance is held
constant, so EF separates "faster because fitter" from "faster because fresh / sent it."

Scope: San Francisco only for now (see SF_BBOX).
"""
from __future__ import annotations

import json
import math
import ssl
import time
import urllib.parse
import urllib.request

import numpy as np

from .metrics import M_PER_MI
from .regions import CACHE, _load_cache  # reuse the geocode cache file + helper

# ---- tuning knobs (expect to adjust on real output) ----
CELL_M = 30.0                                  # grid cell edge
MIN_RUNS = 3                                   # corridor must be run >= this often
MIN_LEN_MI = 0.2                               # drop trivial corridors
MIN_NODES = 8                                  # cheap pre-filter before measuring length
COVER = 0.85                                   # a run "did" a corridor if it hits >= this frac of cells
DEDUPE = 0.6                                   # drop a candidate >= this fraction inside an accepted one
GAP_PTS = 8                                    # bridge this many off-corridor traj points when finding the pass
MAX_SEGMENTS = 50                              # keep it a handful
SF_BBOX = (37.70, -122.52, 37.84, -122.34)     # s, w, n, e

_MPD_LAT = 111320.0                             # meters per degree latitude
_COSLAT = math.cos(math.radians(37.77))         # lon scaling at SF latitude
_DIR8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def _in_sf(lat, lon):
    s, w, n, e = SF_BBOX
    return s <= lat <= n and w <= lon <= e


def _cell(lat, lon):
    return (int(round(lat * _MPD_LAT / CELL_M)),
            int(round(lon * _MPD_LAT * _COSLAT / CELL_M)))


def _dir8(lat1, lon1, lat2, lon2):
    dy = lat2 - lat1
    dx = (lon2 - lon1) * _COSLAT
    ang = math.degrees(math.atan2(dx, dy)) % 360.0   # 0 = N, 90 = E
    return int((ang + 22.5) // 45) % 8


def _nodes_for_run(traj):
    """Per-point list of (cell, dir8) 'nodes' aligned to the trajectory index."""
    lat, lon = traj["lat"], traj["lon"]
    n = len(lat)
    nodes = []
    for i in range(n):
        j = min(i + 1, n - 1)
        d = _dir8(lat[i], lon[i], lat[j], lon[j]) if j > i else (nodes[-1][1] if nodes else 0)
        nodes.append((_cell(lat[i], lon[i]), d))
    return nodes


def _candidates(node_seq, popular):
    """Maximal contiguous stretches of popular nodes (as frozensets of nodes)."""
    out, cur = [], []
    for nd in node_seq:
        if nd in popular:
            if not cur or cur[-1] != nd:    # collapse consecutive repeats
                cur.append(nd)
        else:
            if len(cur) >= MIN_NODES:
                out.append(frozenset(cur))
            cur = []
    if len(cur) >= MIN_NODES:
        out.append(frozenset(cur))
    return out


def _best_window(idxs):
    """Longest near-contiguous block of matching trajectory indices (handles GPS
    dropouts and runs that pass a corridor twice)."""
    if not idxs:
        return None
    groups, cur = [], [idxs[0]]
    for k in idxs[1:]:
        if k - cur[-1] <= GAP_PTS:
            cur.append(k)
        else:
            groups.append(cur); cur = [k]
    groups.append(cur)
    best = max(groups, key=lambda g: g[-1] - g[0])
    return best[0], best[-1]


def _effort(traj, corridor, meta):
    """Time / pace / HR / EF for one run over a corridor, or None if it doesn't
    cleanly cover it."""
    nodes = traj["_nodes"]
    idxs = [i for i, nd in enumerate(nodes) if nd in corridor]
    win = _best_window(idxs)
    if not win:
        return None
    lo, hi = win
    covered = {nodes[i] for i in range(lo, hi + 1)} & corridor
    if len(covered) / len(corridor) < COVER:
        return None
    dt = traj["t"][hi] - traj["t"][lo]
    dmi = traj["dist_mi"][hi] - traj["dist_mi"][lo]
    if dt <= 0 or dmi <= 0:
        return None
    hr_vals = [traj["hr"][i] for i in range(lo, hi + 1)
               if traj.get("hr") and traj["hr"][i] is not None]
    hr = float(np.mean(hr_vals)) if hr_vals else None
    ef = (dmi * M_PER_MI / dt) / hr if hr else None   # speed (m/s) per beat
    return {
        "id": meta["id"], "date": meta["date"], "type": meta["type"],
        "_lo": lo, "_hi": hi, "_len": dmi,
        "time_s": round(dt, 1), "pace_s": round(dt / dmi, 1),
        "hr": round(hr, 1) if hr else None,
        "ef": round(ef, 5) if ef else None,
    }


def _trend(efforts):
    """Linear EF-vs-time fit → label. Higher EF = better, so positive slope improves."""
    pts = [(e["_ord"], e["ef"]) for e in efforts if e["ef"] is not None]
    if len(pts) < 4:
        return {"metric": "ef", "slope": None, "label": "flat"}
    xs = np.array([p[0] for p in pts], float)
    ys = np.array([p[1] for p in pts], float)
    slope = float(np.polyfit(xs, ys, 1)[0])
    span = xs.max() - xs.min()
    mean = ys.mean()
    rel = slope * span / mean if (span and mean) else 0.0   # fractional change over the span
    label = "improving" if rel > 0.03 else "declining" if rel < -0.03 else "flat"
    return {"metric": "ef", "slope": round(slope, 7), "label": label}


def _street_name(lat, lon, cache):
    """Street-level reverse geocode (Nominatim), cached. Separate key namespace and
    finer rounding than regions.py's city-level lookups."""
    key = f"street:{round(lat, 4)},{round(lon, 4)}"
    if key in cache:
        return cache[key]
    name = None
    try:
        try:
            import certifi
            ctx = ssl.create_default_context(cafile=certifi.where())
        except Exception:
            ctx = ssl.create_default_context()
        q = urllib.parse.urlencode({"lat": lat, "lon": lon, "format": "json", "zoom": "17"})
        url = f"https://nominatim.openstreetmap.org/reverse?{q}"
        req = urllib.request.Request(url, headers={
            "User-Agent": "strava-stats/1.0", "Accept-Language": "en"})
        d = json.load(urllib.request.urlopen(req, timeout=10, context=ctx))
        a = d.get("address", {})
        name = (a.get("road") or a.get("pedestrian") or a.get("footway") or a.get("path")
                or a.get("cycleway") or a.get("neighbourhood") or a.get("suburb"))
        time.sleep(1.1)  # Nominatim: max 1 req/s
    except Exception as e:
        print(f"  street geocode failed for {key}: {e}")
    cache[key] = name
    return name


def build_segments(parsed: dict, runs) -> list[dict]:
    meta = {r["id"]: {"id": r["id"], "date": r["date"], "type": r["type"]}
            for _, r in runs.iterrows()}
    base_ord = min((m["date"].toordinal() for m in meta.values()), default=0)

    # ---- per-run nodes, restricted to SF ----
    trajs: dict[str, dict] = {}
    support: dict = {}
    for rid, p in parsed.items():
        traj = p.get("traj")
        if not traj or len(traj.get("lat", [])) < MIN_NODES:
            continue
        if not _in_sf(traj["lat"][len(traj["lat"]) // 2], traj["lon"][len(traj["lon"]) // 2]):
            continue
        nodes = _nodes_for_run(traj)
        traj = dict(traj); traj["_nodes"] = nodes
        trajs[rid] = traj
        for nd in set(nodes):
            support.setdefault(nd, set()).add(rid)

    popular = {nd for nd, rs in support.items() if len(rs) >= MIN_RUNS}
    if not popular:
        return []

    # ---- candidate corridors, longest first, deduped against accepted ones ----
    seen, cands = set(), []
    for traj in trajs.values():
        for c in _candidates(traj["_nodes"], popular):
            if c not in seen:
                seen.add(c); cands.append(c)
    cands.sort(key=len, reverse=True)

    accepted: list[frozenset] = []
    for c in cands:
        if any(len(c & a) / len(c) >= DEDUPE for a in accepted):
            continue
        accepted.append(c)

    # ---- measure each corridor ----
    cache = _load_cache()
    segments = []
    for corridor in accepted:
        efforts = []
        for rid, traj in trajs.items():
            e = _effort(traj, corridor, meta[rid])
            if e:
                e["_ord"] = e["date"].toordinal() - base_ord
                efforts.append(e)
        if len(efforts) < MIN_RUNS:
            continue
        efforts.sort(key=lambda e: e["date"])
        length_mi = float(np.median([e["_len"] for e in efforts]))
        if length_mi < MIN_LEN_MI:
            continue

        # geometry + direction from the member whose length is closest to the median
        rep = min(efforts, key=lambda e: abs(e["_len"] - length_mi))
        rtraj = trajs[rep["id"]]
        lo, hi = rep["_lo"], rep["_hi"]
        polyline = [[rtraj["lat"][i], rtraj["lon"][i]] for i in range(lo, hi + 1)]
        dirs = [rtraj["_nodes"][i][1] for i in range(lo, hi + 1)]
        dir_bin = int(np.bincount(dirs, minlength=8).argmax())

        mid = polyline[len(polyline) // 2]
        name = _street_name(mid[0], mid[1], cache) or "Segment"

        segments.append({
            "name": name, "dir_label": _DIR8[dir_bin],
            "n_runs": len(efforts), "length_mi": round(length_mi, 2),
            "polyline": polyline,
            "trend": _trend(efforts),
            "efforts": [{"id": e["id"], "date": e["date"].strftime("%Y-%m-%d"),
                         "type": e["type"], "time_s": e["time_s"], "pace_s": e["pace_s"],
                         "hr": e["hr"], "ef": e["ef"]} for e in efforts],
        })

    CACHE.write_text(json.dumps(cache, indent=1))
    segments.sort(key=lambda s: s["n_runs"], reverse=True)
    segments = segments[:MAX_SEGMENTS]
    for i, s in enumerate(segments):
        s["id"] = f"seg{i + 1}"
        if s["name"] != "Segment":
            s["name"] = f"{s['name']} ({s['dir_label']})"
        else:
            s["name"] = f"Segment {i + 1} ({s['dir_label']})"
    return segments
