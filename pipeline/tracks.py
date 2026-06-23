"""Parse per-activity track files (.fit, .fit.gz, .gpx) into a uniform record stream.

Every parser returns a pandas DataFrame with these columns (NaN where missing):
    t          seconds elapsed since the start of the activity
    lat, lon   decimal degrees (WGS84)
    ele_m      elevation in meters
    hr         heart rate in bpm
    dist_m     cumulative distance in meters
    speed_ms   instantaneous speed in m/s
    cad        cadence (per leg) where available
"""
from __future__ import annotations

import gzip
import io
from pathlib import Path

import gpxpy
import pandas as pd

# FIT stores lat/long as "semicircles"; convert to degrees.
SEMI_TO_DEG = 180.0 / (2 ** 31)


def _empty() -> pd.DataFrame:
    cols = ["t", "lat", "lon", "ele_m", "hr", "dist_m", "speed_ms", "cad"]
    return pd.DataFrame(columns=cols)


def _scalar(v):
    """Some FIT fields arrive as tuples/lists (multi-component). Take the first."""
    if isinstance(v, (tuple, list)):
        return v[0] if v else None
    return v


def parse_fit(raw: bytes) -> pd.DataFrame:
    import fitdecode

    rows = []
    with fitdecode.FitReader(io.BytesIO(raw)) as fit:
        for frame in fit:
            if not isinstance(frame, fitdecode.FitDataMessage) or frame.name != "record":
                continue
            f = {fld.name: _scalar(fld.value) for fld in frame.fields}
            lat = f.get("position_lat")
            lon = f.get("position_long")
            rows.append(
                {
                    "timestamp": f.get("timestamp"),
                    "lat": lat * SEMI_TO_DEG if lat is not None else None,
                    "lon": lon * SEMI_TO_DEG if lon is not None else None,
                    "ele_m": f.get("enhanced_altitude", f.get("altitude")),
                    "hr": f.get("heart_rate"),
                    "dist_m": f.get("distance"),
                    "speed_ms": f.get("enhanced_speed", f.get("speed")),
                    "cad": f.get("cadence"),
                }
            )
    return _finalize(rows)


def parse_gpx(raw: bytes) -> pd.DataFrame:
    gpx = gpxpy.parse(raw.decode("utf-8", errors="replace"))
    rows = []
    for track in gpx.tracks:
        for seg in track.segments:
            for p in seg.points:
                hr = None
                # Strava GPX occasionally embeds HR via the TrackPointExtension.
                for ext in getattr(p, "extensions", []) or []:
                    for child in ext:
                        tag = child.tag.split("}")[-1].lower()
                        if tag == "hr":
                            try:
                                hr = float(child.text)
                            except (TypeError, ValueError):
                                pass
                rows.append(
                    {
                        "timestamp": p.time,
                        "lat": p.latitude,
                        "lon": p.longitude,
                        "ele_m": p.elevation,
                        "hr": hr,
                        "dist_m": None,  # derived below from positions
                        "speed_ms": None,
                        "cad": None,
                    }
                )
    return _finalize(rows)


def _finalize(rows: list[dict]) -> pd.DataFrame:
    if not rows:
        return _empty()
    df = pd.DataFrame(rows)
    df = df.dropna(subset=["timestamp"]).reset_index(drop=True)
    if df.empty:
        return _empty()
    t0 = df["timestamp"].iloc[0]
    df["t"] = (df["timestamp"] - t0).dt.total_seconds()

    # Fill cumulative distance from haversine when the device didn't record it.
    if df["dist_m"].isna().all() and df[["lat", "lon"]].notna().all(axis=None):
        df["dist_m"] = _cumulative_haversine(df["lat"].to_numpy(), df["lon"].to_numpy())

    # Derive speed when missing.
    if df["speed_ms"].isna().all() and df["dist_m"].notna().any():
        dd = df["dist_m"].diff()
        dt = df["t"].diff()
        df["speed_ms"] = (dd / dt).where(dt > 0)

    return df[["t", "lat", "lon", "ele_m", "hr", "dist_m", "speed_ms", "cad"]]


def _cumulative_haversine(lat, lon):
    import numpy as np

    r = 6371000.0
    lat_r = np.radians(lat)
    lon_r = np.radians(lon)
    dlat = np.diff(lat_r, prepend=lat_r[0])
    dlon = np.diff(lon_r, prepend=lon_r[0])
    a = np.sin(dlat / 2) ** 2 + np.cos(lat_r) * np.cos(np.roll(lat_r, 1)) * np.sin(dlon / 2) ** 2
    a[0] = 0.0
    seg = 2 * r * np.arcsin(np.sqrt(np.clip(a, 0, 1)))
    return np.cumsum(seg)


def load_track(path: str | Path) -> pd.DataFrame:
    """Dispatch on file extension and return a uniform record DataFrame."""
    path = Path(path)
    name = path.name.lower()
    raw = path.read_bytes()
    if name.endswith(".gz"):
        raw = gzip.decompress(raw)
        name = name[:-3]
    if name.endswith(".fit"):
        return parse_fit(raw)
    if name.endswith(".gpx"):
        return parse_gpx(raw)
    raise ValueError(f"Unsupported track format: {path.name}")
