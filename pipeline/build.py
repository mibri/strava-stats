"""Build cleaned, run-only datasets + derived analytics from a Strava export.

Reads:   data/activities.csv  + data/activities/<track files>
Writes:  data/clean/runs.json, runs.parquet
         data/clean/streams/<id>.json   (one per run with GPS/HR/pace)
         data/clean/routes.geojson
         data/clean/summary.json        (aggregates for the dashboard)
         coach/coach_context.md         (compact training brief for the LLM coach)

Run:     python -m pipeline.build
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

from .metrics import (
    BEST_EFFORT_DISTANCES,
    M_PER_FT,
    M_PER_MI,
    aerobic_decoupling,
    best_efforts,
    downsample_stream,
    mile_splits,
    riegel_predict,
)

EFFORT_M = {label: m for m, label in BEST_EFFORT_DISTANCES}
from .tracks import load_track

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CLEAN = DATA / "clean"
STREAMS = CLEAN / "streams"

# Distances we track for PR progression.
PR_LABELS = ["1 mi", "5k", "10k", "Half", "Marathon"]


def load_excludes() -> set[str]:
    """Activity IDs to drop from progression charts (kept in totals/map)."""
    f = ROOT / "progression_excludes.json"
    if not f.exists():
        return set()
    try:
        return set(str(i) for i in json.loads(f.read_text()).get("ids", []))
    except Exception as e:
        print(f"  ! could not read progression_excludes.json: {e}")
        return set()


def fmt_pace(sec_per_mi: float | None) -> str | None:
    if sec_per_mi is None or not math.isfinite(sec_per_mi):
        return None
    m, s = divmod(int(round(sec_per_mi)), 60)
    return f"{m}:{s:02d}"


def fmt_time(sec: float | None) -> str | None:
    if sec is None or not math.isfinite(sec):
        return None
    sec = int(round(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _name_override(name: str, desc: str = "") -> str | None:
    """Explicit run-name keywords win over the data-driven classifier."""
    n = (name or "").lower()
    # High-precision keywords are also trusted in the freeform description.
    text = n + " " + (desc or "").lower()
    if any(k in n for k in ["race", "parkrun"]):
        return "race"
    if any(k in text for k in ["tempo", "interval", "fartlek", "threshold", "repeats"]):
        return "workout"
    if any(k in n for k in ["track", "workout", "speed", "× ", " x "]):
        return "workout"
    if any(k in n for k in ["recovery", "shakeout"]):
        return "recovery"
    return None


def classify_runs(runs: pd.DataFrame) -> pd.Series:
    """Label each run easy / long / workout / recovery / race.

    Strava's default names are generic, so this leans on the data: a trailing
    easy-pace baseline plus within-run surge detection (the `split_spread`
    column, % the fastest mile beats the run's median mile).
    """
    runs = runs.sort_values("date")
    # Seed the easy-pace baseline with the global median of mid-distance runs.
    seed = runs[(runs["distance_mi"] >= 4) & (runs["distance_mi"] < 13)]["pace_s"].median()
    types: dict[int, str] = {}
    baseline = []  # trailing paces of runs treated as easy/steady
    for idx, r in runs.iterrows():
        dist, dur_min, pace = r["distance_mi"], r["moving_s"] / 60, r["pace_s"]
        spread = r.get("split_spread", float("nan"))
        min_split = r.get("min_split", float("nan"))

        override = _name_override(r["name"], r.get("description", ""))
        base = np.median(baseline[-12:]) if len(baseline) >= 4 else seed

        if override:
            t = override
        elif dist >= 13 or dur_min >= 95 or (r["is_week_long"] and dist >= 10):
            t = "long"
        elif pd.notna(pace) and pace <= base - 45:
            t = "workout"  # sustained tempo: avg pace well under easy
        elif (pd.notna(min_split) and min_split <= base - 90 and pd.notna(spread)
              and spread >= 18 and 2.5 <= dist <= 10):
            t = "workout"  # intervals: a genuinely fast mile amid recovery jogs
        elif pd.notna(pace) and pace >= base + 50 and dist < 6:
            t = "recovery"
        else:
            t = "easy"

        types[idx] = t
        if t in ("easy", "recovery") and pd.notna(pace):
            baseline.append(pace)
    return pd.Series(types).reindex(runs.index)


def load_runs_csv() -> pd.DataFrame:
    df = pd.read_csv(DATA / "activities.csv")
    runs = df[df["Activity Type"] == "Run"].copy()

    runs["date"] = pd.to_datetime(runs["Activity Date"], format="%b %d, %Y, %I:%M:%S %p")
    runs["id"] = runs["Activity ID"].astype(str)
    runs["name"] = runs["Activity Name"].fillna("Run")
    runs["description"] = (
        runs["Activity Description"].fillna("").astype(str).str.replace(r"\s+", " ", regex=True).str.strip()
    )

    # Imperial conversions. "Distance.1" is meters; "Average Speed" is m/s.
    runs["distance_mi"] = runs["Distance.1"] / M_PER_MI
    runs["moving_s"] = runs["Moving Time"]
    runs["elapsed_s"] = runs["Elapsed Time.1"]
    runs["pace_s"] = runs["moving_s"] / runs["distance_mi"]
    runs["gap_pace_s"] = M_PER_MI / runs["Average Grade Adjusted Pace"]
    runs["avg_hr"] = runs["Average Heart Rate"]
    runs["max_hr"] = runs["Max Heart Rate.1"]
    runs["elev_gain_ft"] = runs["Elevation Gain"] / M_PER_FT
    runs["elev_loss_ft"] = runs["Elevation Loss"] / M_PER_FT
    runs["avg_grade"] = runs["Average Grade"]
    runs["max_grade"] = runs["Max Grade"]
    # Cadence (steps/min) — the CSV's Average Cadence is empty, so derive it from
    # Total Steps over moving time (Strava convention is total steps, both feet).
    runs["cadence"] = (runs["Total Steps"] / (runs["moving_s"] / 60)).where(runs["moving_s"] > 0)
    runs.loc[(runs["cadence"] < 120) | (runs["cadence"] > 240), "cadence"] = np.nan
    runs["calories"] = runs["Calories"]
    runs["rel_effort"] = runs["Relative Effort.1"]
    runs["temp_f"] = runs["Weather Temperature"] * 9 / 5 + 32
    runs["weather"] = runs["Weather Condition"].fillna("")
    runs["filename"] = runs["Filename"].fillna("")
    # Photos: the Media column is a "|"-delimited list of media/<file> paths.
    runs["photos"] = runs["Media"].fillna("").apply(
        lambda s: [p for p in str(s).split("|") if p.startswith("media/")])

    runs = runs.sort_values("date").reset_index(drop=True)

    # Efficiency factor: speed per heartbeat (higher = more aerobically fit).
    runs["ef"] = (runs["Distance.1"] / runs["moving_s"]) / runs["avg_hr"]
    # Grade-adjusted EF: flat-equivalent speed per heartbeat — isolates fitness on
    # hilly runs (rising = same HR, faster grade-adjusted pace = fitter on hills).
    runs["ef_gap"] = runs["Average Grade Adjusted Pace"] / runs["avg_hr"]

    return add_week_cols(runs)


def add_week_cols(runs: pd.DataFrame) -> pd.DataFrame:
    """ISO-week columns + 'long run of the week' flag (recomputed after localizing)."""
    runs["iso_year"] = runs["date"].dt.isocalendar().year
    runs["iso_week"] = runs["date"].dt.isocalendar().week
    week_max = runs.groupby(["iso_year", "iso_week"])["distance_mi"].transform("max")
    runs["is_week_long"] = runs["distance_mi"] >= week_max - 1e-6
    return runs


def localize_dates(runs: pd.DataFrame, start_coords: dict) -> pd.DataFrame:
    """Strava's Activity Date is UTC. Convert each run to its local wall-clock time
    using the timezone of its GPS start (so 'time of day' is correct even on trips).
    Falls back to the home timezone for runs without GPS."""
    from timezonefinder import TimezoneFinder
    HOME = "America/Los_Angeles"
    tf = TimezoneFinder()
    tz_cache: dict = {}
    local = []
    for _, r in runs.iterrows():
        ll = start_coords.get(r["id"])
        tz = HOME
        if ll:
            key = (round(ll[0], 1), round(ll[1], 1))
            tz = tz_cache.get(key) or tf.timezone_at(lat=ll[0], lng=ll[1]) or HOME
            tz_cache[key] = tz
        ldt = pd.Timestamp(r["date"]).tz_localize("UTC").tz_convert(tz).tz_localize(None)
        local.append(ldt)
    runs["date"] = local
    return runs


def estimate_load(runs: pd.DataFrame) -> pd.Series:
    """Per-run training load. Prefer Strava Relative Effort; estimate the rest
    from a distance-based fit so all runs share one scale."""
    re = runs["rel_effort"].copy()
    have = re.notna() & runs["distance_mi"].notna() & (runs["distance_mi"] > 0)
    if have.sum() >= 5:
        per_mi = (re[have] / runs.loc[have, "distance_mi"]).median()
    else:
        per_mi = 8.0
    est = runs["distance_mi"] * per_mi
    return re.fillna(est).fillna(0.0)


def fitness_curve(runs: pd.DataFrame) -> list[dict]:
    """CTL (42d) / ATL (7d) / TSB exponentially-weighted daily training load."""
    load = estimate_load(runs)
    daily = (
        pd.DataFrame({"date": runs["date"].dt.normalize(), "load": load})
        .groupby("date")["load"]
        .sum()
    )
    idx = pd.date_range(daily.index.min(), daily.index.max(), freq="D")
    daily = daily.reindex(idx, fill_value=0.0)
    ctl = daily.ewm(span=42, adjust=False).mean()
    atl = daily.ewm(span=7, adjust=False).mean()
    # Acute:chronic workload ratio (7d sum / 28d-avg-week). Sweet spot ~0.8–1.3;
    # >1.5 flags a spike in load — relevant to the athlete's IT band history.
    acute = daily.rolling(7).sum()
    chronic = daily.rolling(28).sum() / 4
    acwr = (acute / chronic).replace([float("inf")], None)
    return [
        {
            "date": d.strftime("%Y-%m-%d"),
            "ctl": round(float(c), 1),
            "atl": round(float(a), 1),
            "tsb": round(float(c - a), 1),
            "acwr": round(float(r), 2) if r == r else None,
        }
        for d, c, a, r in zip(idx, ctl, atl, acwr)
    ]


def pr_progression(runs: pd.DataFrame) -> dict[str, list[dict]]:
    """Running-best efforts over time for each tracked distance."""
    out: dict[str, list[dict]] = {label: [] for label in PR_LABELS}
    best: dict[str, float] = {}
    for _, r in runs.iterrows():
        if r.get("exclude_prog"):
            continue
        efforts = r.get("_best_efforts") or {}
        for label in PR_LABELS:
            t = efforts.get(label)
            if t is None:
                continue
            is_pr = label not in best or t < best[label]
            if is_pr:
                best[label] = t
            out[label].append(
                {
                    "date": r["date"].strftime("%Y-%m-%d"),
                    "id": r["id"],
                    "time_s": round(t, 1),
                    "time": fmt_time(t),
                    "is_pr": bool(is_pr),
                }
            )
    return out


def build():
    CLEAN.mkdir(parents=True, exist_ok=True)
    STREAMS.mkdir(parents=True, exist_ok=True)

    runs = load_runs_csv()
    print(f"Loaded {len(runs)} runs ({runs['date'].min().date()} → {runs['date'].max().date()})")

    # ---- Pass 1: parse every track, collect per-run artifacts ----
    parsed: dict[str, dict] = {}
    for _, r in runs.iterrows():
        rid = r["id"]
        track_path = DATA / r["filename"] if r["filename"] else None
        efforts: dict[str, float] = {}
        splits: list[dict] = []
        stream_compact: dict = {}

        if track_path and track_path.exists():
            try:
                stream = load_track(track_path)
                efforts = best_efforts(stream)
                splits = mile_splits(stream)
                stream_compact = downsample_stream(stream)
            except Exception as e:  # keep going; a bad file shouldn't kill the build
                print(f"  ! {rid} track parse failed: {e}")

        # Surge signals: within-run pace spread and the single fastest mile.
        paces = [s["pace_s"] for s in splits if s.get("pace_s")]
        spread = (np.median(paces) - min(paces)) / np.median(paces) * 100 if len(paces) >= 3 else np.nan
        min_split = min(paces) if paces else np.nan
        parsed[rid] = {"efforts": efforts, "splits": splits, "stream": stream_compact,
                       "spread": spread, "min_split": min_split,
                       "decoup": aerobic_decoupling(stream_compact)}

    runs["_best_efforts"] = runs["id"].map(lambda i: parsed[i]["efforts"])
    runs["split_spread"] = runs["id"].map(lambda i: parsed[i]["spread"])
    runs["min_split"] = runs["id"].map(lambda i: parsed[i]["min_split"])
    runs["decoup"] = runs["id"].map(lambda i: parsed[i]["decoup"])

    # ---- Localize timestamps (UTC → local) then refresh week columns ----
    start_coords = {rid: (p["stream"]["latlng"][0] if p["stream"].get("latlng") else None)
                    for rid, p in parsed.items()}
    runs = localize_dates(runs, start_coords)
    runs = add_week_cols(runs).sort_values("date").reset_index(drop=True)

    # ---- Classify (needs split_spread + chronological baseline) ----
    runs["type"] = classify_runs(runs)
    runs["exclude_prog"] = runs["id"].isin(load_excludes())

    # ---- Pass 2: write per-run detail files + route geometry ----
    features = []  # geojson route features
    for _, r in runs.iterrows():
        rid = r["id"]
        p = parsed[rid]
        detail = {
            "id": rid, "name": r["name"], "type": r["type"],
            "date": r["date"].strftime("%Y-%m-%d %H:%M"),
            "distance_mi": round(r["distance_mi"], 2),
            "photos": list(r["photos"]),
            "splits": p["splits"],
            "best_efforts": {k: {"s": round(v, 1), "t": fmt_time(v)} for k, v in p["efforts"].items()},
            "stream": p["stream"],
        }
        (STREAMS / f"{rid}.json").write_text(json.dumps(detail))

        latlng = p["stream"].get("latlng")  # GeoJSON is lon,lat order
        if latlng:
            features.append(
                {
                    "type": "Feature",
                    "properties": {"id": rid, "name": r["name"], "type": r["type"],
                                   "date": r["date"].strftime("%Y-%m-%d"),
                                   "distance_mi": round(r["distance_mi"], 2)},
                    "geometry": {"type": "LineString", "coordinates": [[lo, la] for la, lo in latlng]},
                }
            )

    # ---- runs table (one row per run) ----
    table_cols = {
        "id": runs["id"], "date": runs["date"].dt.strftime("%Y-%m-%d %H:%M"),
        "name": runs["name"].astype(str), "type": runs["type"],
        "description": runs["description"].astype(str),
        "distance_mi": runs["distance_mi"].round(2),
        "moving_s": runs["moving_s"], "elapsed_s": runs["elapsed_s"],
        "pace_s": runs["pace_s"].round(1), "pace": runs["pace_s"].map(fmt_pace),
        "gap_pace_s": runs["gap_pace_s"].round(1), "gap_pace": runs["gap_pace_s"].map(fmt_pace),
        "avg_hr": runs["avg_hr"], "max_hr": runs["max_hr"],
        "ef": runs["ef"].round(4),
        "elev_gain_ft": runs["elev_gain_ft"].round(0), "elev_loss_ft": runs["elev_loss_ft"].round(0),
        "avg_grade": runs["avg_grade"], "cadence": runs["cadence"].round(0),
        "calories": runs["calories"], "rel_effort": runs["rel_effort"],
        "temp_f": runs["temp_f"].round(0), "weather": runs["weather"].astype(str),
        "n_photos": runs["photos"].map(len),
        "exclude_prog": runs["exclude_prog"],
        "has_gps": [bool(f) for f in [runs["id"].iloc[i] in
                    {ft["properties"]["id"] for ft in features} for i in range(len(runs))]],
    }
    table = pd.DataFrame(table_cols)
    table.to_parquet(CLEAN / "runs.parquet", index=False)
    table.to_json(CLEAN / "runs.json", orient="records")

    # ---- routes geojson ----
    (CLEAN / "routes.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": features})
    )

    # ---- aggregates ----
    summary = build_summary(runs)
    summary["fitness"] = fitness_curve(runs)
    summary["pr_progression"] = pr_progression(runs)

    from .regions import build_regions
    print("Geocoding route regions…")
    summary["regions"] = build_regions(features)

    (CLEAN / "summary.json").write_text(json.dumps(summary))

    print(f"Wrote runs.json, {len(features)} routes, {len(list(STREAMS.glob('*.json')))} stream files")

    # ---- coach context ----
    from .coach_context import write_coach_context
    write_coach_context(runs, summary)
    print("Wrote coach/coach_context.md")
    return runs, summary


def build_summary(runs: pd.DataFrame) -> dict:
    weekly = (
        runs.assign(week=runs["date"].dt.to_period("W-SUN").dt.start_time)
        .groupby("week")
        .agg(miles=("distance_mi", "sum"), runs=("id", "count"),
             time_s=("moving_s", "sum"), elev_ft=("elev_gain_ft", "sum"),
             load=("rel_effort", "sum"))
        .reset_index()
    )
    weekly_idx = pd.date_range(weekly["week"].min(), weekly["week"].max(), freq="W-MON")
    weekly = weekly.set_index("week").reindex(weekly_idx, fill_value=0).reset_index(names="week")

    monthly = (
        runs.assign(month=runs["date"].dt.to_period("M").dt.start_time)
        .groupby("month")
        .agg(miles=("distance_mi", "sum"), runs=("id", "count"), time_s=("moving_s", "sum"))
        .reset_index()
    )

    def series(df, xcol):
        return [
            {"x": x.strftime("%Y-%m-%d"), **{k: round(float(df.iloc[i][k]), 1) for k in df.columns if k != xcol}}
            for i, x in enumerate(df[xcol])
        ]

    easy = runs[runs["type"].isin(["easy", "recovery", "long"])]
    hard = runs[runs["type"].isin(["workout", "race"])]

    return {
        "totals": {
            "runs": int(len(runs)),
            "miles": round(float(runs["distance_mi"].sum()), 1),
            "hours": round(float(runs["moving_s"].sum()) / 3600, 1),
            "elev_ft": round(float(runs["elev_gain_ft"].sum()), 0),
            "elev_everest": round(float(runs["elev_gain_ft"].sum()) / 29032, 2),
            "earth_pct": round(float(runs["distance_mi"].sum()) / 24901 * 100, 2),
            "calories": round(float(runs["calories"].sum(skipna=True)), 0),
            "first": runs["date"].min().strftime("%Y-%m-%d"),
            "last": runs["date"].max().strftime("%Y-%m-%d"),
        },
        "weekly": series(weekly, "week"),
        "monthly": series(monthly, "month"),
        "easy_hard_split": {"easy": int(len(easy)), "hard": int(len(hard))},
        # One rich per-run point feeds every progression scatter (each carries `id`
        # so the dashboard can open the run on click).
        "points": _run_points(runs),
        "daily_miles": _daily_miles(runs),
        "patterns": _patterns(runs),
        "hr_zones": _hr_zones(runs),
        "projections": _fitness_projection(runs),
        "photos": [
            {"id": r["id"], "date": r["date"].strftime("%Y-%m-%d"), "name": str(r["name"]), "file": f}
            for _, r in runs.iterrows() for f in r["photos"]
        ],
    }


def _f(v, nd=None):
    if not pd.notna(v):
        return None
    return round(float(v), nd) if nd is not None else float(v)


def _run_points(runs: pd.DataFrame) -> list[dict]:
    out = []
    for _, r in runs.iterrows():
        if not pd.notna(r["pace_s"]) or r.get("exclude_prog"):
            continue
        epm = r["elev_gain_ft"] / r["distance_mi"] if r["distance_mi"] else None
        out.append({
            "id": r["id"], "date": r["date"].strftime("%Y-%m-%d"),
            "type": r["type"], "dist": _f(r["distance_mi"], 2),
            "pace_s": _f(r["pace_s"], 1), "gap_s": _f(r["gap_pace_s"], 1),
            "hr": _f(r["avg_hr"], 0), "ef": _f(r["ef"]), "ef_gap": _f(r["ef_gap"]),
            "cadence": _f(r["cadence"], 0), "temp_f": _f(r["temp_f"], 0),
            "elev_pm": _f(epm, 0), "rel_effort": _f(r["rel_effort"], 0),
            "decoup": _f(r["decoup"], 1),
        })
    return out


def _daily_miles(runs: pd.DataFrame) -> list[dict]:
    daily = runs.groupby(runs["date"].dt.normalize())["distance_mi"].sum()
    idx = pd.date_range(daily.index.min(), daily.index.max(), freq="D")
    daily = daily.reindex(idx, fill_value=0.0)
    return [{"date": d.strftime("%Y-%m-%d"), "miles": round(float(m), 1)} for d, m in daily.items()]


def _patterns(runs: pd.DataFrame) -> dict:
    dow = runs.groupby(runs["date"].dt.dayofweek).agg(
        runs=("id", "count"), miles=("distance_mi", "sum"), pace=("pace_s", "median"))
    hours = runs.groupby(runs["date"].dt.hour).agg(runs=("id", "count"))
    return {
        "dow": [{"dow": int(d), "runs": int(row["runs"]), "miles": round(float(row["miles"]), 1),
                 "pace_s": _f(row["pace"], 1)} for d, row in dow.iterrows()],
        "hours": [{"hour": int(h), "runs": int(row["runs"])} for h, row in hours.iterrows()],
    }


def _hr_zones(runs: pd.DataFrame) -> dict:
    """Time spent in each HR zone (binned by each run's average HR)."""
    if runs["avg_hr"].dropna().empty:
        return {}
    hrmax = (float(np.nanpercentile(runs["max_hr"].dropna(), 99))
             if runs["max_hr"].notna().any() else float(runs["avg_hr"].max()) / 0.9)
    bands = [("Z1", "Recovery", 0, 0.6), ("Z2", "Easy", 0.6, 0.7), ("Z3", "Aerobic", 0.7, 0.8),
             ("Z4", "Threshold", 0.8, 0.9), ("Z5", "Max", 0.9, 2.0)]
    hr = runs["avg_hr"]
    zones = []
    for z, lbl, lo, hi in bands:
        m = (hr >= lo * hrmax) & (hr < hi * hrmax)
        zones.append({"zone": z, "label": lbl, "runs": int(m.sum()),
                      "time_h": round(float(runs.loc[m, "moving_s"].sum()) / 3600, 1),
                      "lo": int(lo * hrmax), "hi": int(hi * hrmax) if hi < 2 else None})
    return {"hrmax": round(hrmax), "zones": zones}


PROJ_TARGETS = ["1 mi", "5k", "10k", "Half", "Marathon"]
PROJ_WINDOW_DAYS = 90


def _fitness_projection(runs: pd.DataFrame) -> dict[str, list[dict]]:
    """Predicted "what you could run" race times — race-calculator style.

    At each run date we take your best efforts (≥1k, last 90 days), personalize the
    endurance exponent `b` to your data (power-law fit, clamped 1.00–1.18), then for
    each target distance take your FASTEST equivalent performance: Riegel-convert each
    nearby effort to the target and keep the best. Only efforts within a 4× distance
    band of the target are used, so e.g. the marathon comes from your long runs rather
    than an over-optimistic mile. The result shows your potential — it sits at your PB
    where that distance is already your strength, and beats it where another distance
    implies headroom; it's never slower than a time you've actually run.
    """
    recs = [(r["date"], r["_best_efforts"]) for _, r in runs.iterrows()
            if not r.get("exclude_prog") and r["_best_efforts"]]
    out: dict[str, list[dict]] = {lbl: [] for lbl in PROJ_TARGETS}
    for d, _ in recs:
        lo = d - pd.Timedelta(days=PROJ_WINDOW_DAYS)
        best: dict[str, float] = {}
        for dd, eff in recs:
            if lo <= dd <= d:
                for lbl, t in eff.items():
                    if EFFORT_M[lbl] >= 1000 and (lbl not in best or t < best[lbl]):
                        best[lbl] = t  # drop sub-1k sprints; they distort the endurance curve
        if not best:
            continue
        # personalized endurance exponent
        if len(best) >= 2:
            X = np.log([EFFORT_M[l] for l in best])
            Y = np.log([best[l] for l in best])
            b = min(1.18, max(1.00, float(np.polyfit(X, Y, 1)[0])))
        else:
            b = 1.06  # Riegel default
        for tgt in PROJ_TARGETS:
            T = EFFORT_M[tgt]
            equivs = [t * (T / EFFORT_M[l]) ** b for l, t in best.items()
                      if T / 4 <= EFFORT_M[l] <= T * 4]
            if not equivs:
                continue
            out[tgt].append({"date": d.strftime("%Y-%m-%d"), "proj_s": round(min(equivs))})
    return out


if __name__ == "__main__":
    build()
