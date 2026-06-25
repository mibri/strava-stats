"""Derived running metrics computed from track streams."""
from __future__ import annotations

import numpy as np
import pandas as pd

M_PER_MI = 1609.344
M_PER_FT = 0.3048

# Distances (meters) for which we extract fastest efforts, with display labels.
BEST_EFFORT_DISTANCES = [
    (400, "400m"),
    (805, "1/2 mi"),
    (1000, "1k"),
    (1609.344, "1 mi"),
    (3218.688, "2 mi"),
    (5000, "5k"),
    (10000, "10k"),
    (16093.44, "10 mi"),
    (21097.5, "Half"),
    (42195, "Marathon"),
]


def clean_cumulative(t, dist):
    """Cumulative (distance, time) with paused/stopped/teleport steps removed, so
    best efforts reflect real running. A step is dropped — contributing neither
    distance NOR time — when it's a recording gap (>30s), goes backwards, or implies
    an impossible speed (>12 m/s ≈ a GPS jump). Dropping both keeps them consistent."""
    dt = np.diff(t, prepend=t[0])
    dd = np.nan_to_num(np.diff(dist, prepend=dist[0]), nan=0.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        speed = np.where(dt > 0, dd / dt, 0.0)
    bad = (dt > 30) | (dd < 0) | (speed > 12.0)
    dd = np.where(bad, 0.0, dd); dd[0] = 0.0
    dt = np.where(bad, 0.0, dt); dt[0] = 0.0
    return np.cumsum(dd), np.cumsum(dt)


def best_efforts(stream: pd.DataFrame) -> dict[str, float]:
    """Fastest *moving* time (seconds) covering each target distance.

    Forward two-pointer sweep over cleaned cumulative distance vs. time.
    """
    if stream.empty or stream["dist_m"].isna().all():
        return {}
    s = stream.dropna(subset=["dist_m", "t"]).sort_values("t")
    dist, t = clean_cumulative(s["t"].to_numpy(), s["dist_m"].to_numpy())
    n = len(dist)
    total = dist[-1] - dist[0]
    out: dict[str, float] = {}
    for target, label in BEST_EFFORT_DISTANCES:
        if total < target:
            continue
        best = np.inf
        j = 0
        for i in range(n):
            if j < i:
                j = i
            while j < n and dist[j] - dist[i] < target:
                j += 1
            if j >= n:
                break
            best = min(best, t[j] - t[i])
        if np.isfinite(best) and best > 0:
            out[label] = float(best)
    return out


def mile_splits(stream: pd.DataFrame) -> list[dict]:
    """Per-mile splits: pace (sec/mi), avg HR, elevation change (ft)."""
    if stream.empty or stream["dist_m"].isna().all():
        return []
    s = stream.dropna(subset=["dist_m", "t"]).sort_values("t").reset_index(drop=True)
    dist, mt = clean_cumulative(s["t"].to_numpy(), s["dist_m"].to_numpy())  # moving distance/time
    splits = []
    mile = 1
    start_idx = 0
    for i in range(len(dist)):
        if dist[i] - dist[start_idx] >= M_PER_MI:
            seg = s.iloc[start_idx : i + 1]
            dt = mt[i] - mt[start_idx]
            dd_mi = (dist[i] - dist[start_idx]) / M_PER_MI
            ele = seg["ele_m"].dropna()
            splits.append(
                {
                    "mile": mile,
                    "pace_s": float(dt / dd_mi) if dd_mi else None,
                    "hr": float(seg["hr"].mean()) if seg["hr"].notna().any() else None,
                    "elev_ft": float((ele.iloc[-1] - ele.iloc[0]) / M_PER_FT)
                    if len(ele) > 1
                    else None,
                }
            )
            mile += 1
            start_idx = i
    return splits


def downsample_stream(stream: pd.DataFrame, max_points: int = 600) -> dict:
    """Compact stream for charts and maps: time/dist/pace/hr/elev + lat-lon polyline."""
    if stream.empty:
        return {}
    s = stream.copy()
    step = max(1, len(s) // max_points)
    d = s.iloc[::step].copy()

    out: dict[str, list] = {}
    out["t"] = [round(float(x), 1) for x in d["t"]]
    if d["dist_m"].notna().any():
        out["dist_mi"] = [round(float(x) / M_PER_MI, 3) if pd.notna(x) else None for x in d["dist_m"]]
    if d["speed_ms"].notna().any():
        # pace in seconds per mile; clamp absurd values (GPS noise / stops).
        pace = []
        for v in d["speed_ms"]:
            if pd.notna(v) and v > 0.3:
                p = M_PER_MI / v
                pace.append(round(p, 1) if p < 1800 else None)
            else:
                pace.append(None)
        out["pace_s"] = pace
    if d["hr"].notna().any():
        out["hr"] = [int(x) if pd.notna(x) else None for x in d["hr"]]
    if d["ele_m"].notna().any():
        out["elev_ft"] = [round(float(x) / M_PER_FT, 1) if pd.notna(x) else None for x in d["ele_m"]]
    if d["cad"].notna().any():
        out["cad"] = [int(x) if pd.notna(x) else None for x in d["cad"]]

    # Route polyline (lat,lon pairs, rounded to ~1m precision).
    gps = stream.dropna(subset=["lat", "lon"])
    if not gps.empty:
        gstep = max(1, len(gps) // max_points)
        out["latlng"] = [
            [round(float(la), 5), round(float(lo), 5)]
            for la, lo in zip(gps["lat"].iloc[::gstep], gps["lon"].iloc[::gstep])
        ]
    return out


def build_trajectory(stream: pd.DataFrame, every_m: float = 12.0) -> dict:
    """Index-aligned GPS trajectory, resampled to ~every_m spacing, for segment
    matching.

    Unlike downsample_stream — whose `latlng` is sampled on its own stride and so
    does NOT line up with `t`/`dist_mi`/`hr` — every list here shares one index:
    lat[k] was recorded at t[k], dist_mi[k], hr[k]. That alignment is what lets us
    pull the elapsed time / HR over an arbitrary stretch of route.
    """
    if stream.empty or stream["dist_m"].isna().all():
        return {}
    s = stream.dropna(subset=["lat", "lon", "dist_m", "t"]).sort_values("t")
    if len(s) < 2:
        return {}
    lat = s["lat"].to_numpy(); lon = s["lon"].to_numpy()
    dist = s["dist_m"].to_numpy(); t = s["t"].to_numpy()
    hr = s["hr"].to_numpy() if s["hr"].notna().any() else None
    spd = s["speed_ms"].to_numpy() if s["speed_ms"].notna().any() else None

    keep = [0]
    last = dist[0]
    for i in range(1, len(dist)):
        if dist[i] - last >= every_m:
            keep.append(i); last = dist[i]
    if keep[-1] != len(dist) - 1:
        keep.append(len(dist) - 1)

    out: dict[str, list] = {
        "lat": [round(float(lat[i]), 5) for i in keep],
        "lon": [round(float(lon[i]), 5) for i in keep],
        "t": [round(float(t[i]), 1) for i in keep],
        "dist_mi": [round(float(dist[i]) / M_PER_MI, 4) for i in keep],
    }
    if hr is not None:
        out["hr"] = [int(hr[i]) if pd.notna(hr[i]) else None for i in keep]
    if spd is not None:
        out["pace_s"] = [round(M_PER_MI / spd[i], 1) if pd.notna(spd[i]) and spd[i] > 0.3 else None
                         for i in keep]
    return out


def riegel_predict(known_dist_m: float, known_time_s: float, target_m: float, exp: float = 1.06) -> float:
    """Riegel race-time prediction: T2 = T1 * (D2/D1)^exp."""
    return known_time_s * (target_m / known_dist_m) ** exp


def aerobic_decoupling(stream: dict) -> float | None:
    """Pa:HR drift — efficiency factor (speed/HR) first half vs second half, as %.
    Lower is better; <5% on a long run is a marker of strong aerobic durability."""
    pace, hr = stream.get("pace_s"), stream.get("hr")
    if not pace or not hr:
        return None
    n = min(len(pace), len(hr))
    half = n // 2
    if half < 30:
        return None

    def ef(ps, hs):
        sp = [1.0 / p for p, h in zip(ps, hs) if p and h and p > 0]
        hh = [h for p, h in zip(ps, hs) if p and h and p > 0]
        if len(sp) < 10:
            return None
        return (sum(sp) / len(sp)) / (sum(hh) / len(hh))

    e1, e2 = ef(pace[:half], hr[:half]), ef(pace[half:n], hr[half:n])
    if not e1 or not e2:
        return None
    return round((e1 - e2) / e1 * 100, 1)


def stride_form(stream: pd.DataFrame, cadence, dist_m, total_steps) -> dict:
    """Stride length (distance per step) and within-run stride fade.

    Average stride = distance / total steps, which is unit-robust. Both stride and
    cadence come from Total Steps, so they're trusted only when the caller's already-
    validated cadence is physiologically sane (a few runs have a corrupt step count
    that doubles it). The per-sample fade series (speed ÷ cadence) is used only as a
    *ratio*, so it doesn't matter that FIT records cadence per leg — the unit cancels.
    Fade compares the last quarter of the run to the first: negative means your stride
    shortened as you tired (often the first thing to go), holding cadence."""
    out: dict = {}
    try:
        cad = float(cadence); ts = float(total_steps); dm = float(dist_m)
    except (TypeError, ValueError):
        cad = ts = dm = float("nan")
    cad_ok = cad == cad and 120 <= cad <= 240          # NaN-safe sanity gate
    if cad_ok and ts > 0 and dm > 0:
        stride_m = dm / ts
        if 0.5 < stride_m < 2.5:                        # sane running/walking stride
            out["stride_ft"] = round(stride_m / M_PER_FT, 2)
            out["stride_m"] = round(stride_m, 2)
            out["cadence_spm"] = round(cad, 0)
    if stream is not None and not stream.empty and \
            stream["speed_ms"].notna().any() and stream["cad"].notna().any():
        s = stream.dropna(subset=["speed_ms", "cad"])
        s = s[(s["speed_ms"] > 0.5) & (s["cad"] > 0)]
        if len(s) >= 60:
            stride = (s["speed_ms"].to_numpy() / s["cad"].to_numpy())
            q = len(stride) // 4
            first, last = float(np.mean(stride[:q])), float(np.mean(stride[-q:]))
            if first > 0:
                out["stride_fade_pct"] = round((last - first) / first * 100, 1)
    return out


def climb_metrics(stream: pd.DataFrame, smooth_m: float = 30.0, steep: float = 8.0,
                  mod: float = 3.0, sustain_m: float = 160.0) -> dict:
    """Climbing detail from the elevation profile: VAM (vertical ft/hr while climbing),
    share of time spent climbing / flat / descending, grade distribution by distance,
    and the steepest grade sustained over ~0.1 mi. Elevation is resampled to even
    distance steps (smoothing baro/GPS noise) before grades are taken."""
    if stream is None or stream.empty or stream["ele_m"].isna().all() or stream["dist_m"].isna().all():
        return {}
    s = stream.dropna(subset=["dist_m", "t", "ele_m"]).sort_values("t").reset_index(drop=True)
    if len(s) < 10:
        return {}
    dist, mt = clean_cumulative(s["t"].to_numpy(), s["dist_m"].to_numpy())   # moving dist/time
    ele = s["ele_m"].to_numpy()
    if dist[-1] - dist[0] < 200:                       # too short to characterize
        return {}

    edges = np.arange(dist[0], dist[-1], smooth_m)
    if len(edges) < 3:
        return {}
    ele_i = np.interp(edges, dist, ele)
    t_i = np.interp(edges, dist, mt)
    d_ele, d_dist, d_time = np.diff(ele_i), np.diff(edges), np.diff(t_i)
    grade = np.where(d_dist > 0, d_ele / d_dist * 100.0, 0.0)

    climb, desc = grade > mod, grade < -mod
    flat = ~climb & ~desc
    tt = d_time.sum() or 1.0
    asc_ft = d_ele[d_ele > 0].sum() / M_PER_FT
    climb_hrs = d_time[climb].sum() / 3600.0
    # VAM only when there's enough sustained climbing to be a stable rate (≥2 min,
    # ≥100 ft) — otherwise a brief steep pitch produces an absurd extrapolated figure.
    vam = asc_ft / climb_hrs if (climb_hrs >= 0.033 and asc_ft >= 100) else None

    bands = [(-1e9, -steep, "steep ↓"), (-steep, -mod, "↓"), (-mod, mod, "flat"),
             (mod, steep, "↑"), (steep, 1e9, "steep ↑")]
    dd = d_dist.sum() or 1.0
    grade_bands = [{"label": lab,
                    "pct": round(float(d_dist[(grade >= lo) & (grade < hi)].sum() / dd * 100), 0)}
                   for lo, hi, lab in bands]

    win = max(1, int(round(sustain_m / smooth_m)))
    steepest = 0.0
    for i in range(len(ele_i) - win):
        g = (ele_i[i + win] - ele_i[i]) / (smooth_m * win) * 100.0
        if g > steepest:
            steepest = g
    return {
        "vam_ft_hr": int(round(vam)) if vam else None,
        "pct_climb": round(float(d_time[climb].sum() / tt * 100), 0),
        "pct_flat": round(float(d_time[flat].sum() / tt * 100), 0),
        "pct_descend": round(float(d_time[desc].sum() / tt * 100), 0),
        "steepest_grade": round(float(steepest), 1),
        "grade_bands": grade_bands,
    }
