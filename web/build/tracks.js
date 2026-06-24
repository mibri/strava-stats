/* In-browser port of pipeline/tracks.py.
 *
 * Parses a per-activity track file (.fit, .fit.gz, .gpx) into a uniform record
 * stream — an array of { t, lat, lon, ele_m, hr, dist_m, speed_ms, cad } (null where
 * missing) — matching the DataFrame columns the Python parser emits.
 */
import { gunzipSync } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm";
import FitParserNS from "https://cdn.jsdelivr.net/npm/fit-file-parser@1.21.0/+esm";
// jsdelivr's CJS→ESM interop double-wraps the default export.
const FitParser = FitParserNS?.default || FitParserNS;

const R_EARTH = 6371000.0;

function cumulativeHaversine(lat, lon) {
  const out = new Array(lat.length);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < lat.length; i++) {
    const la1 = (lat[i - 1] * Math.PI) / 180, la2 = (lat[i] * Math.PI) / 180;
    const dla = la2 - la1, dlo = ((lon[i] - lon[i - 1]) * Math.PI) / 180;
    const a = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
    acc += 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
    out[i] = acc;
  }
  return out;
}

// rows: [{ timestamp, lat, lon, ele_m, hr, dist_m, speed_ms, cad }] → uniform stream.
function finalize(rows) {
  rows = rows.filter((r) => r.timestamp != null);
  if (!rows.length) return [];
  const t0 = +new Date(rows[0].timestamp);
  for (const r of rows) r.t = (+new Date(r.timestamp) - t0) / 1000;

  // Fill cumulative distance from haversine when the device didn't record it (GPX).
  if (rows.every((r) => r.dist_m == null) && rows.every((r) => r.lat != null && r.lon != null)) {
    const d = cumulativeHaversine(rows.map((r) => r.lat), rows.map((r) => r.lon));
    rows.forEach((r, i) => (r.dist_m = d[i]));
  }
  // Derive speed when missing.
  if (rows.every((r) => r.speed_ms == null) && rows.some((r) => r.dist_m != null)) {
    for (let i = 1; i < rows.length; i++) {
      const dd = rows[i].dist_m - rows[i - 1].dist_m, dt = rows[i].t - rows[i - 1].t;
      rows[i].speed_ms = dt > 0 ? dd / dt : null;
    }
  }
  return rows.map((r) => ({
    t: r.t, lat: r.lat ?? null, lon: r.lon ?? null, ele_m: r.ele_m ?? null,
    hr: r.hr ?? null, dist_m: r.dist_m ?? null, speed_ms: r.speed_ms ?? null, cad: r.cad ?? null,
  }));
}

// Regex-based (not DOMParser) so it runs inside a Web Worker, where there is no DOM.
const TRKPT = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
const ATTR = (s, n) => { const m = s.match(new RegExp(`\\b${n}="([^"]+)"`)); return m ? parseFloat(m[1]) : null; };
const TAG = (s, n) => { const m = s.match(new RegExp(`<(?:\\w+:)?${n}>([^<]+)</(?:\\w+:)?${n}>`, "i")); return m ? m[1] : null; };

export function parseGpx(text) {
  const rows = [];
  let m;
  while ((m = TRKPT.exec(text))) {
    const attrs = m[1], body = m[2];
    const time = TAG(body, "time"), ele = TAG(body, "ele"), hr = TAG(body, "hr"); // gpxtpx:hr
    rows.push({
      timestamp: time, lat: ATTR(attrs, "lat"), lon: ATTR(attrs, "lon"),
      ele_m: ele != null ? parseFloat(ele) : null,
      hr: hr != null ? parseFloat(hr) : null,
      dist_m: null, speed_ms: null, cad: null,
    });
  }
  return finalize(rows);
}

function parseFit(bytes) {
  return new Promise((resolve, reject) => {
    const parser = new FitParser({
      force: true, mode: "list", lengthUnit: "m", speedUnit: "m/s", elapsedRecordField: true,
    });
    parser.parse(bytes.buffer ? bytes.buffer : bytes, (err, data) => {
      if (err) return reject(err);
      const rows = (data.records || []).map((f) => ({
        timestamp: f.timestamp ?? null,
        lat: f.position_lat ?? null,     // fit-file-parser already converts to degrees
        lon: f.position_long ?? null,
        ele_m: f.enhanced_altitude ?? f.altitude ?? null,
        hr: f.heart_rate ?? null,
        dist_m: f.distance ?? null,
        speed_ms: f.enhanced_speed ?? f.speed ?? null,
        cad: f.cadence ?? null,
      }));
      resolve(finalize(rows));
    });
  });
}

/** Dispatch on extension. `bytes` is a Uint8Array of the file's contents. */
export async function loadTrack(filename, bytes) {
  let name = filename.toLowerCase();
  let raw = bytes;
  if (name.endsWith(".gz")) { raw = gunzipSync(raw); name = name.slice(0, -3); }
  if (name.endsWith(".fit")) return parseFit(raw);
  if (name.endsWith(".gpx")) return parseGpx(new TextDecoder().decode(raw));
  throw new Error(`Unsupported track format: ${filename}`);
}
