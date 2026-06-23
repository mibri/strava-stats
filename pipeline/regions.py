"""Cluster GPS routes into geographic regions and name them via reverse geocoding.

Names are cached to data/clean/geocode_cache.json so rebuilds work offline after
the first run and we stay polite to the free Nominatim service.
"""
from __future__ import annotations

import json
import ssl
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Kept outside data/clean so it survives a clean rebuild (avoids re-hitting Nominatim).
CACHE = ROOT / "data" / "geocode_cache.json"


def _centroid(coords):
    mid = coords[len(coords) // 2]
    return mid[1], mid[0]  # lat, lon  (geojson is lon,lat)


# Chinese municipalities geocode to a district; map the common ones to the city.
CITY_FIX = {
    "Dongcheng District": "Beijing", "Xicheng District": "Beijing",
    "Chaoyang District": "Beijing", "Haidian District": "Beijing",
    "Fengtai District": "Beijing", "Changning District": "Shanghai",
    "Xuhui District": "Shanghai", "Pudong": "Shanghai", "Huangpu District": "Shanghai",
    "Jing'an District": "Shanghai", "Jingan District": "Shanghai",
}


def cluster_features(features, thresh=0.7):
    """Greedy lat/lon clustering of route midpoints (~0.7° ≈ 70 km)."""
    clusters = []
    for f in features:
        lat, lon = _centroid(f["geometry"]["coordinates"])
        c = next((cl for cl in clusters
                  if abs(cl["lat"] - lat) < thresh and abs(cl["lon"] - lon) < thresh), None)
        if not c:
            c = {"lat": lat, "lon": lon, "pts": [], "lats": [], "lons": []}
            clusters.append(c)
        c["pts"].append(f)
        c["lats"].append(lat)
        c["lons"].append(lon)
        c["lat"] = sum(c["lats"]) / len(c["lats"])
        c["lon"] = sum(c["lons"]) / len(c["lons"])
    return sorted(clusters, key=lambda c: len(c["pts"]), reverse=True)


def _load_cache():
    if CACHE.exists():
        return json.loads(CACHE.read_text())
    return {}


def reverse_geocode(lat, lon, cache):
    key = f"v2:{round(lat, 2)},{round(lon, 2)}"
    if key in cache:
        return cache[key]
    name = None
    try:
        ctx = None
        try:
            import certifi
            ctx = ssl.create_default_context(cafile=certifi.where())
        except Exception:
            ctx = ssl.create_default_context()
        q = urllib.parse.urlencode({"lat": lat, "lon": lon, "format": "json", "zoom": "10"})
        url = f"https://nominatim.openstreetmap.org/reverse?{q}"
        req = urllib.request.Request(url, headers={
            "User-Agent": "strava-stats/1.0", "Accept-Language": "en"})
        d = json.load(urllib.request.urlopen(req, timeout=10, context=ctx))
        a = d.get("address", {})
        state = a.get("state")
        city = a.get("city") or a.get("town") or a.get("village") or a.get("county") or state
        if city in CITY_FIX:
            city = CITY_FIX[city]
        elif city and "District" in city and state:  # district → parent city/municipality
            city = state
        name = ", ".join(x for x in (city, a.get("country")) if x) or None
        time.sleep(1.1)  # Nominatim: max 1 req/s
    except Exception as e:
        print(f"  geocode failed for {key}: {e}")
    cache[key] = name
    return name


def build_regions(features) -> list[dict]:
    """Return [{name, count, lat, lon, bounds:[[s,w],[n,e]]}] sorted by run count."""
    if not features:
        return []
    cache = _load_cache()
    clusters = cluster_features(features)
    regions = []
    for i, c in enumerate(clusters):
        lats, lons = [], []
        for f in c["pts"]:
            for lon, lat in f["geometry"]["coordinates"]:
                lats.append(lat)
                lons.append(lon)
        name = reverse_geocode(c["lat"], c["lon"], cache)
        if not name:
            name = "Home" if i == 0 else f"Area {i + 1}"

        def pct(vals, p):
            vals = sorted(vals)
            return vals[min(len(vals) - 1, int(len(vals) * p))]

        # "core" bounds trim outlier routes (e.g. an occasional far long-run) so the
        # default view sits tight on where most runs happen.
        core = [[pct(lats, 0.08), pct(lons, 0.08)], [pct(lats, 0.92), pct(lons, 0.92)]]
        regions.append({
            "name": name, "count": len(c["pts"]),
            "lat": round(c["lat"], 4), "lon": round(c["lon"], 4),
            "bounds": [[min(lats), min(lons)], [max(lats), max(lons)]],
            "core": core,
        })
    CACHE.write_text(json.dumps(cache, indent=1))
    return regions
