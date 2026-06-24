/* In-browser port of pipeline/regions.py — cluster GPS routes into geographic
 * regions. Reverse geocoding is dropped (it can't run politely from a browser), so
 * regions are named generically: the most-run cluster is "Home", the rest "Area N".
 */
const round4 = (x) => Math.round(x * 1e4) / 1e4;

function minMax(arr) {
  let lo = Infinity, hi = -Infinity;
  for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

const pctile = (vals, p) => {
  const a = [...vals].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
};

// City-sized window for the default map view (percentile-trimmed). `shift` nudges it.
function span(vals, minSpan, shift = 0) {
  const lo = pctile(vals, 0.04), hi = pctile(vals, 0.96);
  const half = Math.max((hi - lo) / 2, minSpan / 2);
  const c = (lo + hi) / 2 + shift * 2 * half;
  return [c - half, c + half];
}

/** features: GeoJSON LineString features (coordinates lon,lat). */
export function buildRegions(features) {
  if (!features.length) return [];
  const clusters = [];
  for (const ft of features) {
    const coords = ft.geometry.coordinates;
    const mid = coords[Math.floor(coords.length / 2)]; // [lon, lat]
    const lat = mid[1], lon = mid[0];
    let c = clusters.find((cl) => Math.abs(cl.lat - lat) < 0.7 && Math.abs(cl.lon - lon) < 0.7);
    if (!c) { c = { lat, lon, pts: [], lats: [], lons: [] }; clusters.push(c); }
    c.pts.push(ft); c.lats.push(lat); c.lons.push(lon);
    c.lat = c.lats.reduce((a, b) => a + b) / c.lats.length;
    c.lon = c.lons.reduce((a, b) => a + b) / c.lons.length;
  }
  clusters.sort((a, b) => b.pts.length - a.pts.length);

  return clusters.map((c, i) => {
    const lats = [], lons = [];
    for (const ft of c.pts) for (const [lo, la] of ft.geometry.coordinates) { lats.push(la); lons.push(lo); }
    const [latLo, latHi] = minMax(lats), [lonLo, lonHi] = minMax(lons);
    const clat = span(lats, 0.11), clon = span(lons, 0.13, -0.18);
    return {
      name: i === 0 ? "Home" : `Area ${i + 1}`,
      count: c.pts.length, lat: round4(c.lat), lon: round4(c.lon),
      bounds: [[latLo, lonLo], [latHi, lonHi]],
      core: [[clat[0], clon[0]], [clat[1], clon[1]]],
    };
  });
}
