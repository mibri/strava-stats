"""Build the bundled SAMPLE dataset from a subset of the REAL export, so a first-time
visitor can explore the dashboard without importing anything of their own.

PRIVACY MODEL — redact an off-centre box around home, keep everything else:
The runs all converge on home, so any small per-run trim leaves the endpoints scattered
*around* that point; averaging ~N endpoints recovers it to within ~(spread/sqrt(N)) — about
70 m here, useless as protection. A box *centred* on home is no better: routes exit on all
sides and the centroid of those exits returns to home. So we blank a box that holds home in
a CORNER — buffered enough on the near sides that no kept point lands close to home, but
extended far in the directions the runs go, so exits cluster away and their centroid is
pushed ~570 m off. Runs keep their longest stretch *outside* the box (no line is drawn
across it); runs that never enter it are untouched, so the map stays full.

The redacted tracks are re-emitted as GPX and run through the real pipeline into web/sample/,
which the dashboard serves when opened with ?sample=1.

Run:  .venv/bin/python -m pipeline.make_sample
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from .tracks import load_track

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CLEAN = DATA / "clean"
SAMPLE_OUT = ROOT / "web" / "sample"
N_KEEP = 50          # how many surviving (post-redaction) runs to ship
# Redaction box: drop every GPS point inside it. Home sits in the SE corner with a ~350 m
# buffer on the south/east edges (so no kept point lands near it) while the box runs ~2 km
# north and ~2.4 km west — the directions the runs actually go — so route exits, and their
# centroid, are pushed away from home. Grid-searched: ~570 m centroid-attack residual,
# nothing within ~330 m of home, full radial map kept. See the module docstring.
BOX_S, BOX_N = 37.78576, 37.80714     # ~Post St … Bay St (latitude)
BOX_W, BOX_E = -122.44820, -122.41716  # ~Divisadero … Larkin (longitude)
DATE_FMT = "%b %d, %Y, %I:%M:%S %p"


def home_ids() -> list[str]:
    """Home-region run IDs, newest first (the cut drops the non-northern ones, so this is
    a candidate pool — we keep the first N_KEEP that survive)."""
    summary = json.loads((CLEAN / "summary.json").read_text())
    regions = summary.get("regions") or []
    if not regions:
        raise SystemExit("No regions in summary.json — build the real data first.")
    (s, w), (n, e) = regions[0]["bounds"]            # [[s,w],[n,e]]
    routes = json.loads((CLEAN / "routes.geojson").read_text())["features"]
    runs = {r["id"]: r for r in json.loads((CLEAN / "runs.json").read_text())}

    picked = []
    for f in routes:
        coords = f["geometry"]["coordinates"]
        rid = f["properties"]["id"]
        if not coords or rid not in runs:
            continue
        lon, lat = coords[len(coords) // 2]          # geojson is lon,lat
        if s <= lat <= n and w <= lon <= e:
            picked.append(rid)
    picked.sort(key=lambda i: runs[i]["date"], reverse=True)   # newest first
    return picked


def redact_box(df: pd.DataFrame):
    """Keep only the longest contiguous run of points OUTSIDE the home box (so the home
    block is blanked and no segment crosses it). Runs that never enter the box are returned
    whole. Returns (kept_df, seconds_skipped_before_it) or None if too little survives."""
    df = df.dropna(subset=["lat", "lon", "t", "dist_m"]).reset_index(drop=True)
    if len(df) < 30:
        return None
    lat = df["lat"].to_numpy(); lon = df["lon"].to_numpy()
    outside = ~((lat >= BOX_S) & (lat <= BOX_N) & (lon >= BOX_W) & (lon <= BOX_E))
    cs, bs, be = None, -1, -1
    for idx, v in enumerate(outside):
        if v:
            if cs is None:
                cs = idx
            if (idx - cs) >= (be - bs):
                bs, be = cs, idx
        else:
            cs = None
    if bs < 0 or (be - bs + 1) < 15:
        return None
    keep = df.iloc[bs:be + 1].copy()
    skipped_s = float(keep["t"].iloc[0])
    keep["t"] = keep["t"] - keep["t"].iloc[0]
    keep["dist_m"] = keep["dist_m"] - keep["dist_m"].iloc[0]
    return keep.reset_index(drop=True), skipped_s


def write_gpx(keep: pd.DataFrame, start_dt: datetime, path: Path):
    pts = []
    for _, r in keep.iterrows():
        ts = (start_dt + timedelta(seconds=float(r["t"]))).strftime("%Y-%m-%dT%H:%M:%SZ")
        ele = "" if pd.isna(r["ele_m"]) else f"<ele>{float(r['ele_m']):.1f}</ele>"
        hr = "" if pd.isna(r["hr"]) else (
            f"<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>{int(r['hr'])}</gpxtpx:hr>"
            f"</gpxtpx:TrackPointExtension></extensions>")
        pts.append(f'<trkpt lat="{float(r["lat"]):.6f}" lon="{float(r["lon"]):.6f}">{ele}<time>{ts}</time>{hr}</trkpt>')
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="strava-stats-sample" '
        'xmlns="http://www.topografix.com/GPX/1/1" '
        'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n'
        '<trk><trkseg>\n' + "\n".join(pts) + "\n</trkseg></trk></gpx>\n")


def build_subset(ids: list[str]) -> tuple[Path, Path]:
    df = pd.read_csv(DATA / "activities.csv")
    by_id = {str(r["Activity ID"]): r.to_dict() for _, r in df.iterrows()}

    sandbox = Path(tempfile.mkdtemp(prefix="strava-sample-"))
    (sandbox / "activities").mkdir(parents=True, exist_ok=True)

    out_rows = []
    for rid in ids:                                   # newest first
        if len(out_rows) >= N_KEEP:
            break
        row = by_id.get(rid)
        if row is None:
            continue
        fn = row.get("Filename")
        if not isinstance(fn, str) or not (DATA / fn).exists():
            continue
        try:
            track = load_track(DATA / fn)
        except Exception:
            continue
        red = redact_box(track)
        if not red:                                   # nothing usable outside the box
            continue
        keep, skipped_s = red

        # The kept segment may begin after the real start (home end blanked); shift the
        # displayed start time by the skipped seconds to match.
        try:
            start_dt = datetime.strptime(str(row["Activity Date"]), DATE_FMT) + timedelta(seconds=skipped_s)
        except ValueError:
            start_dt = datetime(2025, 1, 1) + timedelta(seconds=skipped_s)

        write_gpx(keep, start_dt, sandbox / "activities" / f"{rid}.gpx")

        # Recompute the CSV fields the pipeline reads from columns (not the track) so the
        # headline numbers stay consistent with the trimmed route.
        total_d = float(keep["dist_m"].iloc[-1])
        dur = float(keep["t"].iloc[-1]) or 1.0
        orig_dur = float(row.get("Moving Time") or dur) or dur
        orig_dist = float(row.get("Distance.1") or total_d) or total_d
        avg_speed = total_d / dur
        row["Filename"] = f"activities/{rid}.gpx"
        row["Media"] = ""
        if "Activity Description" in row:
            row["Activity Description"] = ""
        row["Activity Date"] = start_dt.strftime(DATE_FMT)
        row["Distance.1"] = round(total_d, 1)
        if "Distance" in row:
            row["Distance"] = round(total_d / 1000, 2)
        row["Moving Time"] = round(dur)
        row["Elapsed Time.1"] = round(dur)
        if "Elapsed Time" in row:
            row["Elapsed Time"] = round(dur)
        row["Average Speed"] = round(avg_speed, 3)
        row["Average Grade Adjusted Pace"] = round(avg_speed, 3)
        if keep["hr"].notna().any():
            row["Average Heart Rate"] = round(float(keep["hr"].mean()), 1)
            row["Max Heart Rate.1"] = round(float(keep["hr"].max()))
        if keep["ele_m"].notna().any():
            d = keep["ele_m"].astype(float).diff()
            row["Elevation Gain"] = round(float(d.clip(lower=0).sum()), 1)
            row["Elevation Loss"] = round(float((-d.clip(upper=0)).sum()), 1)
        if row.get("Total Steps") not in (None, "") and not pd.isna(row.get("Total Steps")):
            row["Total Steps"] = round(float(row["Total Steps"]) * dur / orig_dur)
        if row.get("Calories") not in (None, "") and not pd.isna(row.get("Calories")):
            row["Calories"] = round(float(row["Calories"]) * total_d / orig_dist)
        out_rows.append(row)

    pd.DataFrame(out_rows, columns=list(df.columns)).to_csv(sandbox / "activities.csv", index=False)

    cache = sandbox / "geocode_cache.json"
    real = DATA / "geocode_cache.json"
    if real.exists():
        shutil.copy(real, cache)
    print(f"Redacted home box + wrote {len(out_rows)} sample runs")
    return sandbox, cache


def main():
    ids = home_ids()
    print(f"Selected {len(ids)} home-region runs for the sample")
    sandbox, cache = build_subset(ids)
    try:
        if SAMPLE_OUT.exists():
            shutil.rmtree(SAMPLE_OUT)
        SAMPLE_OUT.mkdir(parents=True)
        env = {
            **os.environ,
            "STRAVA_DATA_DIR": str(sandbox),
            "STRAVA_CLEAN_DIR": str(SAMPLE_OUT),
            "STRAVA_GEOCODE_CACHE": str(cache),
            "STRAVA_COACH_DIR": str(sandbox / "coach"),   # don't touch the real coach files
        }
        subprocess.run([sys.executable, "-m", "pipeline.build"], check=True, env=env, cwd=str(ROOT))
        (SAMPLE_OUT / "runs.parquet").unlink(missing_ok=True)
        (SAMPLE_OUT / "geocode_cache.json").unlink(missing_ok=True)
        print(f"Sample dataset → {SAMPLE_OUT}")
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


if __name__ == "__main__":
    main()
