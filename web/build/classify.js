/* In-browser port of pipeline/build.py's run classification.
 *
 * Strava's run names are generic, so type (easy / long / workout / recovery / race)
 * is data-driven: a trailing easy-pace baseline + within-run surge detection
 * (split_spread / min_split, derived from the mile splits), with name/description
 * keywords as a high-precision override.
 */

export const median = (arr) => {
  const a = arr.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export const fmtDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Monday of a date's week (matches pandas W-SUN start_time).
export function weekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export const monthStart = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;

// Inclusive list of consecutive Date objects between two dates (daily fill).
export function eachDay(min, max) {
  const out = [];
  const d = new Date(min); d.setHours(0, 0, 0, 0);
  const end = new Date(max); end.setHours(0, 0, 0, 0);
  while (d <= end) { out.push(new Date(d)); d.setDate(d.getDate() + 1); }
  return out;
}

// ISO 8601 week (year, week) — JS has no built-in, so compute the Thursday-anchored week.
export function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 864e5 + 1) / 7);
  return [date.getUTCFullYear(), week];
}

/** spread = how much the fastest mile beats the median mile (%); min_split = fastest mile. */
export function splitStats(splits) {
  const paces = (splits || []).map((s) => s.pace_s).filter((p) => p);
  const min_split = paces.length ? Math.min(...paces) : null;
  if (paces.length < 3) return { split_spread: null, min_split };
  const med = median(paces);
  return { split_spread: ((med - min_split) / med) * 100, min_split };
}

/** Tag each run with is_week_long = it's (within 1e-6 of) the longest run of its ISO week. */
export function addWeekLong(runs) {
  const maxByWeek = new Map();
  for (const r of runs) {
    const k = isoWeek(r.date).join("-");
    maxByWeek.set(k, Math.max(maxByWeek.get(k) ?? 0, r.distance_mi || 0));
  }
  for (const r of runs) {
    const k = isoWeek(r.date).join("-");
    r.is_week_long = (r.distance_mi || 0) >= maxByWeek.get(k) - 1e-6;
  }
}

export function nameOverride(name, desc) {
  const n = (name || "").toLowerCase();
  const text = n + " " + (desc || "").toLowerCase();
  if (["race", "parkrun"].some((k) => n.includes(k))) return "race";
  if (["tempo", "interval", "fartlek", "threshold", "repeats"].some((k) => text.includes(k))) return "workout";
  if (["track", "workout", "speed", "× ", " x "].some((k) => n.includes(k))) return "workout";
  if (["recovery", "shakeout"].some((k) => n.includes(k))) return "recovery";
  return null;
}

/** Assign each run.type. Expects runs to already carry split_spread, min_split,
 *  is_week_long. Returns a Map(id -> type) and also writes r.type in place. */
export function classifyRuns(runs) {
  const sorted = [...runs].sort((a, b) => a.date - b.date);
  const seed = median(sorted.filter((r) => r.distance_mi >= 4 && r.distance_mi < 13).map((r) => r.pace_s));
  const types = new Map();
  const baseline = []; // trailing paces of runs treated as easy/steady
  for (const r of sorted) {
    const dist = r.distance_mi, durMin = r.moving_s / 60, pace = r.pace_s;
    const spread = r.split_spread, minSplit = r.min_split;
    const override = nameOverride(r.name, r.description);
    const base = baseline.length >= 4 ? median(baseline.slice(-12)) : seed;

    let t;
    if (override) t = override;
    else if (dist >= 13 || durMin >= 95 || (r.is_week_long && dist >= 10)) t = "long";
    else if (pace != null && pace <= base - 45) t = "workout";
    else if (minSplit != null && minSplit <= base - 90 && spread != null && spread >= 18 && dist >= 2.5 && dist <= 10) t = "workout";
    else if (pace != null && pace >= base + 50 && dist < 6) t = "recovery";
    else t = "easy";

    types.set(r.id, t);
    r.type = t;
    if ((t === "easy" || t === "recovery") && pace != null) baseline.push(pace);
  }
  return types;
}
