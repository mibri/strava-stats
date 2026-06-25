/* Strava Stats dashboard. Reads the pipeline's JSON from ../data/clean/. */
const DATA = "../data/clean";
const MEDIA = "../data/media";
const TYPE_COLORS = {
  easy: "#4f93ff", long: "#ec5fa6", workout: "#fc5200",
  recovery: "#45c08a", race: "#ffd23f",
};
// Distinct marker shapes so types stay separable where dots overlap.
const TYPE_SYMBOLS = {
  easy: "circle", long: "diamond", workout: "triangle-up",
  recovery: "square", race: "star",
};
const TYPE_GLYPH = { easy: "●", long: "◆", workout: "▲", recovery: "■", race: "★" };
const TYPE_ORDER = ["easy", "long", "workout", "recovery", "race"];
// Theme-aware chart/map colors, read from the active CSS variables (set by the theme
// before this script runs), so charts and tiles match light or dark mode.
const css = (v, fb) => (getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fb);
const GRID = css("--grid", "#2a313c");
const HOVER_BG = css("--hover-bg", "#1f242d");
const HOVER_FG = css("--hover-fg", "#e7ecf3");
const HOVER_BORDER = css("--hover-border", "#3a424f");
const MAP_TILES = css("--map-tiles", "dark_all");
const PLOT_FONT = { color: css("--muted", "#8b94a3"), family: "-apple-system, Segoe UI, Roboto, sans-serif" };

const state = { runs: [], summary: null, routes: null, points: [],
  sortKey: "date", sortDir: -1, timeframe: "all", dateById: {} };

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
const fmtPace = (s) => (s == null || !isFinite(s) ? "—" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
// Resolve a "media/<file>" path to an image URL: an object URL from the in-browser
// build (photos cached in IndexedDB), or data/media when running off the Python build.
const mediaUrl = (file) => (state.fromBuild ? (state.photoUrls[file] || "") : `${MEDIA}/${file.replace("media/", "")}`);
const fmtDur = (s) => {
  if (s == null) return "—";
  s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
const num = (n, d = 0) => (n == null || !isFinite(n) ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));

function paceAxis(values) {
  const v = values.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { autorange: "reversed" };
  let lo = v[Math.floor(v.length * 0.02)], hi = v[Math.ceil(v.length * 0.98) - 1];
  if (!(hi > lo)) { hi = v[v.length - 1]; lo = v[0]; }
  const step = [15, 30, 60, 120, 300].find((s) => (hi - lo) / s <= 8) || 600;
  const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step;
  const tickvals = [], ticktext = [];
  for (let t = start; t <= end; t += step) { tickvals.push(t); ticktext.push(fmtPace(t)); }
  return { range: [end, start], tickvals, ticktext, gridcolor: GRID, zeroline: false };
}

const baseLayout = (over = {}) => ({
  paper_bgcolor: "transparent", plot_bgcolor: "transparent",
  font: PLOT_FONT, margin: { l: 56, r: 24, t: 16, b: 40 },
  xaxis: { gridcolor: GRID, zeroline: false, ...(over.xaxis || {}) },
  yaxis: { gridcolor: GRID, zeroline: false, ...(over.yaxis || {}) },
  legend: { orientation: "h", y: 1.12, font: { size: 11 } },
  hovermode: "closest",
  hoverlabel: { bgcolor: HOVER_BG, bordercolor: HOVER_BORDER,
    font: { family: PLOT_FONT.family, color: HOVER_FG, size: 12 }, align: "left" },
  ...over,
});
const CONFIG = { displayModeBar: false, responsive: true };

/* plot + wire click-to-open-run (points must carry customdata = run id) */
function plot(id, traces, over, clickable) {
  return Plotly.newPlot(id, traces, baseLayout(over), CONFIG).then(() => {
    if (!clickable) return;
    const gd = document.getElementById(id);
    if (gd && gd.on) gd.on("plotly_click", (ev) => {
      const cd = ev.points[0].customdata;
      const rid = Array.isArray(cd) ? cd[0] : cd;
      if (rid != null) openRun(String(rid));
    });
  });
}

function rolling(arr, win) {
  return arr.map((_, i) => {
    const a = arr.slice(Math.max(0, i - win + 1), i + 1).filter((x) => x != null && isFinite(x));
    return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  });
}

/* ---------- boot ---------- */
async function boot() {
  // Data source: an in-browser build (dropped export, cached in IndexedDB) takes
  // precedence; otherwise fetch the Python pipeline's files from data/clean.
  let build = null;
  if (window.StravaStore) { try { build = await window.StravaStore.loadBuild(); } catch (e) { /* none */ } }
  let summary, runs, routes, segments;
  if (build) {
    ({ summary, runs, routes, segments } = build);
  } else {
    try {
      [summary, runs, routes, segments] = await Promise.all([
        fetch(`${DATA}/summary.json`).then((r) => r.json()),
        fetch(`${DATA}/runs.json`).then((r) => r.json()),
        fetch(`${DATA}/routes.geojson`).then((r) => r.json()).catch(() => null),
        fetch(`${DATA}/segments.json`).then((r) => r.json()).catch(() => []),
      ]);
    } catch (e) {
      // No local data and no build → send the user to the importer.
      location.href = "import.html";
      return;
    }
  }
  state.fromBuild = !!build;
  state.summary = summary; state.runs = runs; state.routes = routes; state.points = summary.points || [];
  state.segments = segments || [];

  // For an in-browser build, turn the cached photo blobs into object URLs up front.
  state.photoUrls = {};
  if (build && window.StravaStore) {
    try {
      const blobs = await window.StravaStore.loadAllPhotos();
      for (const f in blobs) state.photoUrls[f] = URL.createObjectURL(blobs[f]);
    } catch (e) { /* photos are optional */ }
  }
  runs.forEach((r) => { const d = r.date.slice(0, 10); if (!state.dateById[d]) state.dateById[d] = r.id; });

  renderOverview();
  setupTimeframe();
  renderProgression();
  renderRuns();
  setupTabs();
}

/* ---------- tabs ---------- */
let mapBuilt = false;
function setupTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const id = btn.dataset.tab;
      $(`#${id}`).classList.add("active");
      if (id === "map" && !mapBuilt) { buildHeatmap(); mapBuilt = true; }
      window.dispatchEvent(new Event("resize"));
    };
  });
}

/* ---------- timeframe ---------- */
function setupTimeframe() {
  const opts = [["3M", 3], ["6M", 6], ["1Y", 12], ["All", 0]];
  $("#timeframe-controls").innerHTML = opts.map(([l, m]) =>
    `<button class="${(m === 0 ? "all" : m) == state.timeframe ? "active" : ""}" data-m="${m === 0 ? "all" : m}">${l}</button>`).join("");
  $("#timeframe-controls").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    state.timeframe = b.dataset.m; state.customStart = state.customEnd = null;
    $("#tf-start").value = ""; $("#tf-end").value = "";
    syncTimeframeButtons(); renderProgression();
  }));
  const onDate = () => {
    state.customStart = $("#tf-start").value || null;
    state.customEnd = $("#tf-end").value || null;
    if (state.customStart || state.customEnd) { state.timeframe = null; syncTimeframeButtons(); }
    renderProgression();
  };
  $("#tf-start").onchange = onDate; $("#tf-end").onchange = onDate;
}
function syncTimeframeButtons() {
  $("#timeframe-controls").querySelectorAll("button").forEach((x) =>
    x.classList.toggle("active", x.dataset.m == state.timeframe));
}
function cutoff() {
  if (state.timeframe === "all" || state.timeframe == null) return new Date(0);
  const anchor = new Date(state.summary.totals.last);
  const c = new Date(anchor); c.setMonth(c.getMonth() - Number(state.timeframe)); return c;
}
function inFrame(dateStr) {
  const d = new Date(dateStr);
  if (state.customStart && d < new Date(state.customStart)) return false;
  if (state.customEnd && d > new Date(state.customEnd)) return false;
  if (state.customStart || state.customEnd) return true;
  return d >= cutoff();
}

/* ---------- overview ---------- */
function renderOverview() {
  const t = state.summary.totals;
  const stats = [
    { val: num(t.miles), unit: "mi", lbl: "Total distance" },
    { val: num(t.runs), unit: "", lbl: "Runs logged" },
    { val: num(t.hours), unit: "h", lbl: "Time on feet" },
    { val: num(t.elev_ft), unit: "ft", lbl: "Elevation climbed" },
    { val: num(t.calories / 1000, 1), unit: "k", lbl: "Calories burned" },
  ];
  $("#hero").innerHTML = stats.map((s) =>
    `<div class="stat"><div class="val">${s.val}<span class="unit">${s.unit}</span></div><div class="lbl">${s.lbl}</div></div>`).join("");

  const fun = [
    { e: "🌍", big: `${t.earth_pct}%`, sub: "of the way around the Earth (24,901 mi)" },
    { e: "🏔️", big: `${t.elev_everest}×`, sub: "the height of Mt. Everest climbed" },
    { e: "🍔", big: `${num(t.calories / 540)}`, sub: "Big Macs worth of calories torched" },
    { e: "🔁", big: `${num(t.miles / 26.219, 1)}`, sub: "marathons of total distance" },
  ];
  $("#funfacts").innerHTML = fun.map((f) =>
    `<div class="fun"><span class="emoji">${f.e}</span><div><div class="big">${f.big}</div><div class="sub">${f.sub}</div></div></div>`).join("");

  const w = state.summary.weekly;
  plot("overview-mileage", [{
    type: "bar", x: w.map((d) => d.x), y: w.map((d) => d.miles),
    marker: { color: "#fc5200" }, hovertemplate: "%{x}<br>%{y:.1f} mi<extra></extra>",
  }], { yaxis: { title: "miles", gridcolor: GRID } });

  renderCalendar();
  renderPhotoStrip();
}

/* GitHub-style daily-mileage calendar — one block per year, newest first (no side-scroll hunt) */
function renderCalendar() {
  const days = state.summary.daily_miles;
  if (!days || !days.length) { $("#calendar").innerHTML = `<span class="muted">No data</span>`; return; }
  const max = Math.max(...days.map((d) => d.miles));
  const ramp = ["#5c2e12", "#9c4410", "#d65a10", "#fc5200"];
  const color = (mi) => {
    if (mi <= 0) return "var(--bg-elev2)";
    const r = mi / max;
    return r < 0.25 ? ramp[0] : r < 0.5 ? ramp[1] : r < 0.75 ? ramp[2] : ramp[3];
  };
  const byDate = Object.fromEntries(days.map((d) => [d.date, d.miles]));
  const years = [...new Set(days.map((d) => d.date.slice(0, 4)))].sort().reverse();
  const dow = ["", "M", "", "W", "", "F", ""];
  const today = new Date();

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const blocks = years.map((yr) => {
    const start = new Date(yr, 0, 1); start.setDate(start.getDate() - start.getDay());   // back to Sunday
    const end = new Date(yr, 11, 31); end.setDate(end.getDate() + (6 - end.getDay()));    // forward to Saturday
    const cells = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (d.getFullYear() != yr || d > today) { cells.push(`<div class="cal-cell future"></div>`); continue; }
      const k = iso(d); const mi = byDate[k] || 0;
      const click = state.dateById[k] ? ` data-id="${state.dateById[k]}"` : "";
      cells.push(`<div class="cal-cell${mi > 0 ? " has" : ""}"${click} title="${k}: ${mi.toFixed(1)} mi" style="background:${color(mi)}"></div>`);
    }
    const ncols = Math.round(cells.length / 7);
    // place each month label at the week-column where its 1st falls
    const monthCols = MONTHS.map((_, m) => Math.floor((new Date(yr, m, 1) - start) / (7 * 864e5)) + 1);
    return `<div class="cal-year">
      <div class="cal-year-label">${yr}</div>
      <div class="cal-months" style="grid-template-columns:repeat(${ncols},1fr)">${MONTHS.map((m, i) => `<span class="cal-month" style="grid-column:${monthCols[i]}">${m}</span>`).join("")}</div>
      <div class="cal-row"><div class="cal-dow">${dow.map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="cal-grid" style="grid-template-columns:repeat(${ncols},1fr)">${cells.join("")}</div></div>
    </div>`;
  }).join("");

  $("#calendar").innerHTML = blocks +
    `<div class="cal-legend">Less ${ramp.map((c) => `<i style="background:${c}"></i>`).join("")} More</div>`;
  $("#calendar").querySelectorAll(".cal-cell.has[data-id]").forEach((c) => (c.onclick = () => openRun(c.dataset.id)));
}

function renderPhotoStrip() {
  const photos = state.summary.photos || [];
  if (!photos.length) { $("#photos-card").style.display = "none"; return; }
  const shuffled = [...photos].sort(() => Math.random() - 0.5).slice(0, 30);
  state.lbSet = shuffled;
  $("#photo-strip").innerHTML = shuffled.map((p, i) =>
    `<img src="${mediaUrl(p.file)}" loading="lazy" data-i="${i}" title="${escapeHtml(p.name)} · ${p.date}" />`).join("");
  $("#photo-strip").querySelectorAll("img").forEach((img) =>
    (img.onclick = () => openLightbox(state.lbSet, +img.dataset.i)));
}

/* ---------- lightbox ---------- */
function openLightbox(set, i) {
  state.lbCur = { set, i };
  const p = set[i];
  $("#lb-img").src = mediaUrl(p.file);
  $("#lb-cap").innerHTML = `${escapeHtml(p.name)} · ${p.date} — <a data-id="${p.id}">open run ↗</a>`;
  $("#lb-cap a").onclick = () => { closeLightbox(); openRun(p.id); };
  $("#lightbox").classList.remove("hidden");
}
function lbStep(d) { const c = state.lbCur; if (!c) return; openLightbox(c.set, (c.i + d + c.set.length) % c.set.length); }
function closeLightbox() { $("#lightbox").classList.add("hidden"); state.lbCur = null; }
$("#lb-close").onclick = closeLightbox;
$("#lb-prev").onclick = () => lbStep(-1);
$("#lb-next").onclick = () => lbStep(1);
$("#lightbox").onclick = (e) => { if (e.target.id === "lightbox") closeLightbox(); };
document.addEventListener("keydown", (e) => {
  if ($("#lightbox").classList.contains("hidden")) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft") lbStep(-1);
  if (e.key === "ArrowRight") lbStep(1);
});

/* ---------- progression ---------- */
function renderProgression() {
  const s = state.summary;
  const pts = state.points.filter((p) => inFrame(p.date));
  const w = s.weekly.filter((d) => inFrame(d.x));
  const fit = s.fitness.filter((d) => inFrame(d.date));

  // Weekly volume + 4wk avg
  plot("chart-volume", [
    { type: "bar", name: "miles", x: w.map((d) => d.x), y: w.map((d) => d.miles),
      marker: { color: "#fc520099" }, hovertemplate: "%{x}<br>%{y:.1f} mi<extra></extra>" },
    { type: "scatter", mode: "lines", name: "4-wk avg", x: w.map((d) => d.x),
      y: rolling(w.map((d) => d.miles), 4), line: { color: "#ffd23f", width: 3 } },
  ], { yaxis: { title: "miles", gridcolor: GRID } });

  // Race times — actual bests vs projected (combined, distance-selectable)
  drawRaces();

  // Fitness / fatigue / form
  plot("chart-fitness", [
    { type: "scatter", mode: "lines", name: "Form (TSB)", x: fit.map((d) => d.date), y: fit.map((d) => d.tsb),
      yaxis: "y2", fill: "tozeroy", line: { color: "#45c08a", width: 1 }, fillcolor: "#45c08a22" },
    { type: "scatter", mode: "lines", name: "Fitness (CTL)", x: fit.map((d) => d.date), y: fit.map((d) => d.ctl),
      line: { color: "#4f93ff", width: 3 } },
    { type: "scatter", mode: "lines", name: "Fatigue (ATL)", x: fit.map((d) => d.date), y: fit.map((d) => d.atl),
      line: { color: "#fc5200", width: 2, dash: "dot" } },
  ], {
    margin: { l: 56, r: 64, t: 16, b: 40 },
    yaxis: { title: "load", gridcolor: GRID },
    yaxis2: { title: { text: "form", standoff: 16 }, overlaying: "y", side: "right",
      zeroline: true, zerolinecolor: GRID, showgrid: false, automargin: true },
  });

  // Injury-risk ACWR
  const acwr = fit.filter((d) => d.acwr != null);
  plot("chart-acwr", [
    { type: "scatter", mode: "lines", x: acwr.map((d) => d.date), y: acwr.map((d) => d.acwr),
      line: { color: HOVER_FG, width: 2 }, hovertemplate: "%{x}<br>ACWR %{y:.2f}<extra></extra>" },
  ], {
    shapes: [
      { type: "rect", xref: "paper", x0: 0, x1: 1, y0: 0.8, y1: 1.3, fillcolor: "#45c08a18", line: { width: 0 } },
      { type: "rect", xref: "paper", x0: 0, x1: 1, y0: 1.5, y1: 3, fillcolor: "#e24b4a18", line: { width: 0 } },
    ],
    yaxis: { title: "acute : chronic", gridcolor: GRID, range: [0, Math.max(2, ...acwr.map((d) => d.acwr)) + 0.2] },
  });

  // Aerobic efficiency (easy/long runs)
  drawEF("chart-ef", pts.filter((p) => ["easy", "long", "recovery"].includes(p.type) && p.ef != null), "ef", "speed per heartbeat →");

  // Hill efficiency (grade-adjusted EF, hilly runs only)
  drawEF("chart-hill", pts.filter((p) => p.ef_gap != null && p.elev_pm >= 40), "ef_gap", "climb-adjusted speed per heartbeat →");

  // Pace trend by type — type toggles + optional per-type trend lines
  state.curPts = pts;
  if (!state.paceControlsBuilt) { setupPaceControls(); state.paceControlsBuilt = true; }
  drawPaceChart();

  // Aerobic durability — decoupling on long runs
  const dec = pts.filter((p) => p.decoup != null && ["long", "easy"].includes(p.type) && p.dist >= 8);
  plot("chart-decoup", [
    { type: "scatter", mode: "markers", name: "long runs", x: dec.map((p) => p.date), y: dec.map((p) => p.decoup),
      marker: { color: "#9b6bff", size: 8, opacity: 0.7 }, customdata: dec.map((p) => p.id),
      text: dec.map((p) => `${p.date} · ${p.dist} mi · drift ${p.decoup}%`), hovertemplate: "%{text}<extra></extra>" },
    { type: "scatter", mode: "lines", name: "trend", x: dec.map((p) => p.date), y: rolling(dec.map((p) => p.decoup), 5),
      line: { color: "#ffd23f", width: 3 } },
  ], {
    shapes: [{ type: "rect", xref: "paper", x0: 0, x1: 1, y0: -3, y1: 5, fillcolor: "#45c08a18", line: { width: 0 } }],
    yaxis: { title: "HR drift (%)", gridcolor: GRID },
  }, true);

  // Cadence trend
  const cad = pts.filter((p) => p.cadence != null);
  plot("chart-cadence", [
    { type: "scatter", mode: "markers", name: "runs", x: cad.map((p) => p.date), y: cad.map((p) => p.cadence),
      marker: { color: "#45c08a", size: 6, opacity: 0.5 }, customdata: cad.map((p) => p.id),
      text: cad.map((p) => `${p.date} · ${Math.round(p.cadence)} spm`), hovertemplate: "%{text}<extra></extra>" },
    { type: "scatter", mode: "lines", name: "trend", x: cad.map((p) => p.date), y: rolling(cad.map((p) => p.cadence), 8),
      line: { color: "#ffd23f", width: 3 } },
  ], { yaxis: { title: "steps / min", gridcolor: GRID } }, true);

  // Heat vs pace
  const hot = pts.filter((p) => p.temp_f != null && ["easy", "long", "recovery"].includes(p.type));
  plot("chart-temp", [{
    type: "scatter", mode: "markers", x: hot.map((p) => p.temp_f), y: hot.map((p) => p.pace_s),
    marker: { color: "#fc5200", size: 7, opacity: 0.6 }, customdata: hot.map((p) => p.id),
    text: hot.map((p) => `${p.date} · ${Math.round(p.temp_f)}°F · ${fmtPace(p.pace_s)}/mi`),
    hovertemplate: "%{text}<extra></extra>",
  }], { xaxis: { title: "temperature (°F)", gridcolor: GRID }, yaxis: { title: "pace (/mi)", ...paceAxis(hot.map((p) => p.pace_s)) } }, true);

  // When you run
  drawPatterns();

  // HR zones (all-time)
  drawZones();

  // Easy/hard balance donut (timeframe-aware)
  const counts = {};
  pts.forEach((p) => (counts[p.type] = (counts[p.type] || 0) + 1));
  const order = ["easy", "long", "recovery", "workout", "race"].filter((t) => counts[t]);
  Plotly.newPlot("chart-balance", [{
    type: "pie", hole: 0.6, labels: order, values: order.map((t) => counts[t]),
    marker: { colors: order.map((t) => TYPE_COLORS[t]) }, textinfo: "label+percent",
    hovertemplate: "%{label}: %{value} runs<extra></extra>",
  }], { ...baseLayout(), margin: { l: 10, r: 10, t: 10, b: 10 }, showlegend: false }, CONFIG);
}

function drawEF(id, pts, key, ytitle) {
  const y = pts.map((p) => p[key] * 1000);
  plot(id, [
    { type: "scatter", mode: "markers", name: "runs", x: pts.map((p) => p.date), y,
      marker: { color: key === "ef" ? "#4f93ff" : "#9b6bff", size: 7, opacity: 0.55 },
      customdata: pts.map((p) => p.id),
      text: pts.map((p) => `${p.date} · ${p.dist} mi · HR ${p.hr ? Math.round(p.hr) : "—"}`),
      hovertemplate: "%{text}<extra></extra>" },
    { type: "scatter", mode: "lines", name: "trend", x: pts.map((p) => p.date), y: rolling(y, 8),
      line: { color: "#ffd23f", width: 3 } },
  ], { yaxis: { title: ytitle, gridcolor: GRID } }, true);
}

function drawPatterns() {
  const p = state.summary.patterns;
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const dowRuns = names.map((_, i) => (p.dow.find((d) => d.dow === i) || {}).runs || 0);
  plot("chart-dow", [{
    type: "bar", x: names, y: dowRuns, marker: { color: "#4f93ff" },
    hovertemplate: "%{x}<br>%{y} runs<extra></extra>",
  }], { margin: { l: 40, r: 12, t: 10, b: 32 }, yaxis: { title: "runs", gridcolor: GRID } });

  const hours = Array.from({ length: 24 }, (_, h) => (p.hours.find((x) => x.hour === h) || {}).runs || 0);
  plot("chart-hour", [{
    type: "bar", x: hours.map((_, h) => `${h}`), y: hours, marker: { color: "#fc5200" },
    hovertemplate: "%{x}:00<br>%{y} runs<extra></extra>",
  }], { margin: { l: 40, r: 12, t: 10, b: 32 }, xaxis: { title: "hour of day", gridcolor: GRID }, yaxis: { title: "runs", gridcolor: GRID } });
}

function setupPaceControls() {
  const present = TYPE_ORDER.filter((t) => state.runs.some((r) => r.type === t));
  if (!state.paceTypes) { state.paceTypes = new Set(present); state.paceTrend = true; }
  const el = $("#pace-controls");
  el.innerHTML = present.map((t) => {
    const on = state.paceTypes.has(t);
    return `<button class="type-chip ${on ? "on" : ""}" data-t="${t}" style="${on ? `border-color:${TYPE_COLORS[t]}` : ""}">
      <span class="glyph" style="color:${on ? TYPE_COLORS[t] : "var(--muted)"}">${TYPE_GLYPH[t]}</span>${t}</button>`;
  }).join("") +
    `<label class="trend-toggle"><input type="checkbox" id="pace-trend-cb" ${state.paceTrend ? "checked" : ""}/> trend lines</label>`;
  el.querySelectorAll(".type-chip").forEach((b) => (b.onclick = () => {
    const t = b.dataset.t;
    state.paceTypes.has(t) ? state.paceTypes.delete(t) : state.paceTypes.add(t);
    setupPaceControls(); drawPaceChart();
  }));
  $("#pace-trend-cb").onchange = (e) => { state.paceTrend = e.target.checked; drawPaceChart(); };
}

function drawPaceChart() {
  const pts = state.curPts || [];
  const traces = [];
  TYPE_ORDER.filter((t) => state.paceTypes.has(t)).forEach((ty) => {
    const p = pts.filter((x) => x.type === ty).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!p.length) return;
    traces.push({
      type: "scatter", mode: "markers", name: ty, x: p.map((x) => x.date), y: p.map((x) => x.pace_s),
      marker: { color: TYPE_COLORS[ty], size: 6, opacity: state.paceTrend ? 0.3 : 0.7,
        symbol: TYPE_SYMBOLS[ty], line: { color: "#0f1115", width: 0.5 } },
      customdata: p.map((x) => x.id), text: p.map((x) => `${x.date} · ${x.dist} mi · ${fmtPace(x.pace_s)}/mi`),
      hovertemplate: `%{text}<extra>${ty}</extra>`,
    });
    if (state.paceTrend && p.length >= 4) {
      const win = Math.min(10, Math.max(3, Math.round(p.length / 4)));
      traces.push({
        type: "scatter", mode: "lines", x: p.map((x) => x.date), y: rolling(p.map((x) => x.pace_s), win),
        line: { color: TYPE_COLORS[ty], width: 3, shape: "spline" }, showlegend: false, hoverinfo: "skip",
      });
    }
  });
  plot("chart-pace", traces, {
    showlegend: false,
    yaxis: { title: "pace (/mi)", ...paceAxis(pts.map((p) => p.pace_s)) },
  }, true);
}

const RACE_DISTS = ["1 mi", "5k", "10k", "Half", "Marathon"];
const RACE_GOALS = { Marathon: 3 * 3600 + 45 * 60 }; // sub-3:45
let raceDist = null;
function drawRaces() {
  const prog = state.summary.pr_progression || {};
  const proj = state.summary.projections || {};
  const dists = RACE_DISTS.filter((d) => (prog[d] && prog[d].length) || (proj[d] && proj[d].length));
  if (!dists.length) return;
  if (!raceDist || !dists.includes(raceDist)) raceDist = dists.includes("Marathon") ? "Marathon" : dists[dists.length - 1];

  $("#race-controls").innerHTML = dists.map((d) =>
    `<button class="${d === raceDist ? "active" : ""}" data-d="${d}">${d}</button>`).join("");
  $("#race-controls").querySelectorAll("button").forEach((b) => (b.onclick = () => { raceDist = b.dataset.d; drawRaces(); }));

  const efforts = (prog[raceDist] || []).filter((p) => inFrame(p.date));
  let b1 = Infinity; const prLine = [];
  efforts.forEach((p) => { if (p.time_s < b1) { b1 = p.time_s; prLine.push(p); } });
  // projection is a fitness MODEL over time — plot it directly (it rises/falls with
  // fitness), not as a cumulative best, so it doesn't just trace the PBs.
  const projAll = (proj[raceDist] || []).filter((p) => inFrame(p.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const GOAL = RACE_GOALS[raceDist] || null;

  const traces = [];
  if (efforts.length) {
    traces.push({ type: "scatter", mode: "markers", name: "efforts", x: efforts.map((p) => p.date), y: efforts.map((p) => p.time_s),
      marker: { color: "#4f93ff", size: 6, opacity: 0.3 }, customdata: efforts.map((p) => p.id),
      text: efforts.map((p) => `${p.date} · ${p.time}`), hovertemplate: "%{text}<extra></extra>" });
    traces.push({ type: "scatter", mode: "lines+markers", name: "your best", x: prLine.map((p) => p.date), y: prLine.map((p) => p.time_s),
      line: { color: "#fc5200", width: 3, shape: "hv" }, marker: { size: 7, color: "#fc5200" },
      customdata: prLine.map((p) => p.id), text: prLine.map((p) => `best ${p.time}`), hovertemplate: "%{x}<br>%{text}<extra></extra>" });
  }
  if (projAll.length) {
    traces.push({ type: "scatter", mode: "lines", name: "predicted (fitness)", x: projAll.map((p) => p.date), y: projAll.map((p) => p.proj_s),
      line: { color: "#45c08a", width: 2.5, shape: "spline" },
      text: projAll.map((p) => `predicted ${fmtDur(p.proj_s)}`), hovertemplate: "%{x}<br>%{text}<extra></extra>" });
  }

  // y range: efforts span + projection range + goal, clipping the slowest easy-run efforts
  const effSorted = efforts.map((p) => p.time_s).sort((a, b) => a - b);
  const projVals = projAll.map((p) => p.proj_s);
  const lows = [b1, GOAL, ...projVals].filter((x) => x != null && isFinite(x));
  let yLo = Math.min(...lows, ...(effSorted.length ? [effSorted[0]] : []));
  let yHi = Math.max(
    effSorted.length ? effSorted[Math.floor(effSorted.length * 0.9)] : 0,
    GOAL || 0, ...projVals);
  yLo *= 0.985; yHi *= 1.02;
  const xsAll = [...efforts.map((p) => p.date), ...projAll.map((p) => p.date)].sort();
  if (GOAL && xsAll.length) {
    traces.push({ type: "scatter", mode: "lines", name: `goal ${fmtDur(GOAL)}`, x: [xsAll[0], xsAll[xsAll.length - 1]], y: [GOAL, GOAL],
      line: { color: "#ffd23f", width: 2, dash: "dash" }, hoverinfo: "skip" });
  }
  const ticks = []; for (let t = Math.ceil(yLo / 300) * 300; t <= yHi; t += (yHi - yLo > 3600 ? 900 : 300)) ticks.push(t);
  plot("chart-races", traces, {
    yaxis: { title: "time", range: [yHi, yLo], gridcolor: GRID, tickvals: ticks, ticktext: ticks.map(fmtDur) },
  }, true);
}

function drawZones() {
  const hz = state.summary.hr_zones;
  if (!hz || !hz.zones) { Plotly.purge("chart-zones"); return; }
  const z = hz.zones;
  const colors = ["#45c08a", "#4f93ff", "#9b6bff", "#fc5200", "#e24b4a"];
  plot("chart-zones", [{
    type: "bar", orientation: "h",
    y: z.map((x) => `${x.zone} ${x.label}`), x: z.map((x) => x.time_h),
    marker: { color: colors }, customdata: z.map((x) => x.runs),
    text: z.map((x) => `${x.time_h}h`), textposition: "auto",
    hovertemplate: "%{y}<br>%{x:.1f} h · %{customdata} runs<extra></extra>",
  }], { margin: { l: 96, r: 24, t: 16, b: 36 },
    xaxis: { title: `hours (HRmax est. ${hz.hrmax})`, gridcolor: GRID }, yaxis: { gridcolor: GRID } });
}


/* ---------- runs table ---------- */
function renderRuns() {
  const sel = $("#run-type");
  [...new Set(state.runs.map((r) => r.type))].forEach((t) => {
    const o = document.createElement("option"); o.value = t; o.textContent = t; sel.appendChild(o);
  });
  $("#run-search").oninput = drawRows;
  sel.onchange = drawRows;
  document.querySelectorAll("#runs-table th").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
      state.sortDir = state.sortKey === k ? -state.sortDir : (k === "name" || k === "type" ? 1 : -1);
      state.sortKey = k; drawRows();
    };
  });
  drawRows();
}

function drawRows() {
  const q = $("#run-search").value.toLowerCase();
  const ty = $("#run-type").value;
  let rows = state.runs.filter((r) =>
    (!ty || r.type === ty) &&
    (!q || (r.name + " " + (r.description || "")).toLowerCase().includes(q)));
  const k = state.sortKey, dir = state.sortDir;
  rows.sort((a, b) => {
    let x = a[k], y = b[k];
    if (k === "date") { x = a.date; y = b.date; }
    if (typeof x === "string") return x.localeCompare(y) * dir;
    return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
  });
  $("#run-count").textContent = `${rows.length} runs`;
  $("#runs-table tbody").innerHTML = rows.map((r) => `
    <tr data-id="${r.id}">
      <td>${r.date.slice(0, 10)}</td>
      <td>${escapeHtml(r.name)}${r.n_photos ? " 📷" : ""}${r.exclude_prog ? ` <span class="muted" title="excluded from progression charts">⊘</span>` : ""}${r.description ? ` <span class="muted">· ${escapeHtml(r.description.slice(0, 40))}</span>` : ""}</td>
      <td><span class="pill ${r.type}">${r.type}</span></td>
      <td class="num">${r.distance_mi.toFixed(2)}</td>
      <td class="num">${fmtPace(r.pace_s)}</td>
      <td class="num">${fmtPace(r.gap_pace_s)}</td>
      <td class="num">${r.avg_hr ? Math.round(r.avg_hr) : "—"}</td>
      <td class="num">${num(r.elev_gain_ft)}</td>
      <td class="num">${r.rel_effort ? Math.round(r.rel_effort) : "—"}</td>
    </tr>`).join("");
  document.querySelectorAll("#runs-table tbody tr").forEach((tr) => (tr.onclick = () => openRun(tr.dataset.id)));
}
const escapeHtml = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- run detail modal ---------- */
// One per-run detail blob ({ stream, best_efforts, photos, ... }), from the in-browser
// build's IndexedDB store or the Python build's streams/<id>.json. Used by both the run
// modal and the drawn-segment matcher.
async function loadStream(id) {
  return state.fromBuild && window.StravaStore
    ? await window.StravaStore.loadStream(id)
    : await fetch(`${DATA}/streams/${id}.json`).then((x) => x.json()).catch(() => null);
}

let detailMap = null;
async function openRun(id) {
  const r = state.runs.find((x) => x.id === id);
  if (!r) return;
  const d = await loadStream(id);
  const be = d && d.best_efforts || {};
  const beHtml = Object.entries(be).map(([k, v]) => `<span class="be">${k} <b>${v.t}</b></span>`).join("");
  const photos = (d && d.photos) || [];
  const photoSet = photos.map((f) => ({ file: f, name: r.name, date: r.date.slice(0, 10), id: r.id }));
  const photoHtml = photos.length
    ? `<div class="detail-photos">${photos.map((f, i) => `<img src="${mediaUrl(f)}" data-i="${i}" />`).join("")}</div>` : "";

  $("#modal-body").innerHTML = `
    <h2>${escapeHtml(r.name)}</h2>
    <p class="sub">${r.date} · <span class="pill ${r.type}">${r.type}</span>${r.description ? " · " + escapeHtml(r.description) : ""}</p>
    <div class="detail-stats">
      ${stat(r.distance_mi.toFixed(2), "mi")}
      ${stat(fmtDur(r.moving_s), "moving")}
      ${stat(fmtPace(r.pace_s), "/mi pace")}
      ${stat(fmtPace(r.gap_pace_s), "/mi GAP")}
      ${stat(r.avg_hr ? Math.round(r.avg_hr) : "—", "avg HR")}
      ${stat(r.cadence ? Math.round(r.cadence) : "—", "cadence")}
      ${stat(num(r.elev_gain_ft), "ft climb")}
      ${stat(r.rel_effort ? Math.round(r.rel_effort) : "—", "effort")}
    </div>
    ${beHtml ? `<div class="be-grid">${beHtml}</div>` : ""}
    ${photoHtml}
    <div id="detail-map" class="detail-map"></div>
    <div id="detail-streams"></div>
    <div id="detail-splits"></div>`;
  $("#modal").classList.remove("hidden");
  $("#modal-body").querySelectorAll(".detail-photos img").forEach((img) =>
    (img.onclick = () => openLightbox(photoSet, +img.dataset.i)));

  const st = d && d.stream || {};
  setTimeout(() => {
    if (detailMap) { detailMap.remove(); detailMap = null; }
    if (st.latlng && st.latlng.length) {
      detailMap = L.map("detail-map", { attributionControl: false, zoomControl: true });
      L.tileLayer(`https://{s}.basemaps.cartocdn.com/${MAP_TILES}/{z}/{x}/{y}{r}.png`, { maxZoom: 19 }).addTo(detailMap);
      const line = L.polyline(st.latlng, { color: "#fc5200", weight: 4 }).addTo(detailMap);
      detailMap.fitBounds(line.getBounds(), { padding: [20, 20] });
      L.circleMarker(st.latlng[0], { radius: 5, color: "#45c08a", fillOpacity: 1 }).addTo(detailMap);
    } else {
      $("#detail-map").innerHTML = `<div class="muted" style="padding:40px;text-align:center">No GPS track</div>`;
    }
  }, 60);

  const x = st.dist_mi || st.t;
  const xt = st.dist_mi ? "distance (mi)" : "time (s)";
  const traces = [];
  if (st.pace_s) traces.push({ key: "pace", y: st.pace_s, color: "#fc5200", title: "Pace", pace: true });
  if (st.hr) traces.push({ key: "hr", y: st.hr, color: "#45c08a", title: "Heart rate" });
  if (st.elev_ft) traces.push({ key: "elev", y: st.elev_ft, color: "#9b6bff", title: "Elevation", fill: true });
  $("#detail-streams").innerHTML = traces.map((t) => `<div class="card" style="margin:10px 0"><h2 style="font-size:14px">${t.title}</h2><div id="ds-${t.key}" style="height:180px"></div></div>`).join("");
  traces.forEach((t) => {
    plot(`ds-${t.key}`, [{
      type: "scatter", mode: "lines", x, y: t.y, line: { color: t.color, width: 2 }, connectgaps: true,
      fill: t.fill ? "tozeroy" : undefined, fillcolor: t.fill ? t.color + "22" : undefined,
    }], { margin: { l: 50, r: 16, t: 6, b: 30 }, xaxis: { title: xt, gridcolor: GRID },
        yaxis: t.pace ? paceAxis(t.y) : { gridcolor: GRID }, height: 180 });
  });

  if (d && d.splits && d.splits.length) {
    const max = Math.max(...d.splits.map((s) => s.pace_s || 0));
    const min = Math.min(...d.splits.filter((s) => s.pace_s).map((s) => s.pace_s));
    $("#detail-splits").innerHTML = `<div class="card"><h2 style="font-size:14px">Mile splits</h2>
      <table><thead><tr><th>Mile</th><th class="num">Pace</th><th>—</th><th class="num">HR</th><th class="num">Elev</th></tr></thead>
      <tbody>${d.splits.map((s) => {
        const pct = s.pace_s ? 30 + 70 * (max - s.pace_s) / (max - min || 1) : 0;
        return `<tr><td>${s.mile}</td><td class="num">${fmtPace(s.pace_s)}</td>
          <td style="width:40%"><div style="background:#fc5200;height:8px;border-radius:4px;width:${pct}%"></div></td>
          <td class="num">${s.hr ? Math.round(s.hr) : "—"}</td>
          <td class="num">${s.elev_ft != null ? (s.elev_ft > 0 ? "+" : "") + Math.round(s.elev_ft) : "—"}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  }
}
const stat = (v, l) => `<div class="stat"><div class="val">${v}</div><div class="lbl">${l}</div></div>`;
$("#modal-close").onclick = () => $("#modal").classList.add("hidden");
$("#modal").onclick = (e) => { if (e.target.id === "modal") $("#modal").classList.add("hidden"); };

/* ---------- heatmap ---------- */
function buildHeatmap() {
  if (!state.routes || !state.routes.features.length) {
    $("#heatmap").innerHTML = `<div class="muted" style="padding:40px">No GPS routes found.</div>`; return;
  }
  $("#route-count").textContent = state.routes.features.length;
  const map = L.map("heatmap", { attributionControl: false });
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${MAP_TILES}/{z}/{x}/{y}{r}.png`, { maxZoom: 19 }).addTo(map);

  const all = [];
  state.routes.features.forEach((f) => {
    const latlng = f.geometry.coordinates.map(([lo, la]) => [la, lo]);
    const pl = L.polyline(latlng, { color: "#fc5200", weight: 2, opacity: 0.3 }).addTo(map);
    pl.on("mouseover", () => { if (!drawMode) pl.setStyle({ opacity: 1, weight: 4 }); });
    pl.on("mouseout", () => { if (!drawMode) pl.setStyle({ opacity: 0.3, weight: 2 }); });
    pl.on("click", () => { if (!drawMode) openRun(f.properties.id); });
    all.push(pl);
  });

  const fit = (b) => setTimeout(() => { map.invalidateSize(); map.fitBounds(b, { padding: [30, 30] }); }, 80);
  const regions = state.summary.regions || [];
  const buttons = [{ label: `All (${all.length})`, bounds: L.featureGroup(all).getBounds() }]
    .concat(regions.slice(0, 9).map((rg, i) => ({
      label: `${i === 0 ? "🏠 " : "✈️ "}${rg.name.split(",")[0]} (${rg.count})`,
      // default view uses the trimmed "core" bounds so it sits tight on the city
      bounds: L.latLngBounds(rg.core || rg.bounds),
    })));

  $("#region-controls").innerHTML = buttons.map((b, i) =>
    `<button class="${i === 1 ? "active" : ""}" data-i="${i}">${b.label}</button>`).join("");
  $("#region-controls").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    $("#region-controls").querySelectorAll("button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    fit(buttons[+b.dataset.i].bounds);
  }));

  // Photo pins. The export strips photo EXIF (no real coords), so we spread each
  // run's photos evenly ALONG its route rather than stacking them all at the start.
  let photoLayer = null;
  const routeById = {};
  state.routes.features.forEach((f) => { routeById[f.properties.id] = f.geometry.coordinates; });
  $("#toggle-photos").onclick = () => {
    const btn = $("#toggle-photos");
    if (photoLayer) { map.removeLayer(photoLayer); photoLayer = null; btn.classList.remove("active"); btn.setAttribute("aria-pressed", "false"); return; }
    photoLayer = L.layerGroup();
    const byRun = {};
    (state.summary.photos || []).forEach((p) => { (byRun[p.id] ||= []).push(p); });
    Object.entries(byRun).forEach(([rid, ps]) => {
      const route = routeById[rid]; if (!route || !route.length) return;
      ps.forEach((p, i) => {
        const frac = (i + 0.5) / ps.length;               // spread along the route
        const c = route[Math.floor(frac * (route.length - 1))];
        const thumb = mediaUrl(p.file);
        const icon = L.divIcon({ className: "", html: `<img src="${thumb}" style="width:34px;height:34px;border-radius:6px;border:2px solid #fc5200;object-fit:cover">`, iconSize: [34, 34] });
        L.marker([c[1], c[0]], { icon }).on("click", () => openLightbox(ps, i)).addTo(photoLayer);
      });
    });
    photoLayer.addTo(map);
    btn.classList.add("active"); btn.setAttribute("aria-pressed", "true");
  };

  // Repeated-segments overlay. Dims the orange heatmap and draws each detected
  // corridor colored by its EF trend; click one to open its trend panel.
  const TREND_COLOR = { improving: "#45c08a", declining: "#ec5fa6", flat: "#7f8a99" };
  let segLayer = null;
  $("#toggle-segments").onclick = () => {
    const btn = $("#toggle-segments");
    if (segLayer) {
      map.removeLayer(segLayer); segLayer = null;
      all.forEach((pl) => pl.setStyle({ opacity: 0.3 }));
      $("#segment-panel").innerHTML = "";
      btn.classList.remove("active"); btn.setAttribute("aria-pressed", "false");
      return;
    }
    const segs = state.segments || [];
    if (!segs.length) { btn.disabled = true; btn.title = "No repeated segments found"; return; }
    all.forEach((pl) => pl.setStyle({ opacity: 0.05 }));
    segLayer = L.layerGroup();
    segs.forEach((s) => {
      const col = TREND_COLOR[s.trend.label] || "#7f8a99";
      const pl = L.polyline(s.polyline, { color: col, weight: 5, opacity: 0.85 }).addTo(segLayer);
      pl.on("mouseover", () => pl.setStyle({ weight: 9 }));
      pl.on("mouseout", () => pl.setStyle({ weight: 5 }));
      pl.on("click", () => showSegmentPanel(s));
      pl.bindTooltip(`${s.name} · ${s.n_runs}×`, { sticky: true });
    });
    segLayer.addTo(map);
    btn.classList.add("active"); btn.setAttribute("aria-pressed", "true");
  };

  // ---- Draw-a-segment: paint a corridor, see every run that ran it ----
  const DRAW_TREND = { improving: "#45c08a", declining: "#ec5fa6", flat: "#7f8a99" };
  const drawBtn = $("#toggle-draw");
  const drawCtl = $("#draw-controls");
  const widthInput = $("#draw-width");
  const widthVal = $("#draw-width-val");
  const widthM = () => +widthInput.value;
  let drawMode = false, drawing = false, directional = true;
  let stroke = null, raw = null, drawLayer = null, livePoly = null;

  // Metric ±halfW buffer of the stroke, in lat/lon (so it stays correct at every zoom).
  const bufferPolygon = (latlngs, halfW) => {
    const coslat = Math.cos((latlngs[0][0] * Math.PI) / 180);
    const toM = ([la, lo]) => [lo * SEG_MPD_LAT * coslat, la * SEG_MPD_LAT];
    const toLL = ([x, y]) => [y / SEG_MPD_LAT, x / (SEG_MPD_LAT * coslat)];
    const P = latlngs.map(toM), lft = [], rgt = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1;
      const nx = (-ty / tl) * halfW, ny = (tx / tl) * halfW;   // left normal × halfW
      lft.push([P[i][0] + nx, P[i][1] + ny]);
      rgt.push([P[i][0] - nx, P[i][1] - ny]);
    }
    return lft.concat(rgt.reverse()).map(toLL);
  };

  const clearDraw = () => {
    if (drawLayer) { map.removeLayer(drawLayer); drawLayer = null; }
    stroke = null; raw = null; livePoly = null;
    $("#segment-panel").innerHTML = "";
  };

  const renderDraw = () => {
    if (!stroke || stroke.length < 2 || !raw) return;
    const cl = buildCenterline(stroke);
    const seg = aggregateDrawn(raw, Math.round((cl.total / SEG_MI_M) * 100) / 100, segDirLabel(stroke), directional);
    const col = DRAW_TREND[seg.trend.label] || "#7f8a99";
    if (drawLayer) map.removeLayer(drawLayer);
    drawLayer = L.layerGroup().addTo(map);
    L.polygon(bufferPolygon(stroke, widthM() / 2), { color: col, weight: 1, opacity: 0.5, fillOpacity: 0.12, interactive: false }).addTo(drawLayer);
    L.polyline(stroke, { color: col, weight: 3, opacity: 0.95, interactive: false }).addTo(drawLayer);
    L.circleMarker(stroke[0], { radius: 5, color: "#fff", weight: 2, fillColor: col, fillOpacity: 1, interactive: false }).addTo(drawLayer);
    const p = stroke[stroke.length - 1], q = stroke[stroke.length - 2];
    const ang = (Math.atan2((p[1] - q[1]) * Math.cos((p[0] * Math.PI) / 180), p[0] - q[0]) * 180) / Math.PI;
    const arrow = L.divIcon({ className: "", iconSize: [18, 18], html: `<div style="transform:rotate(${ang}deg);color:${col};font-size:18px;line-height:18px;text-shadow:0 0 2px #000">▲</div>` });
    L.marker(p, { icon: arrow, interactive: false }).addTo(drawLayer);
    if (seg.n_runs) showSegmentPanel(seg);
    else {
      $("#segment-panel").innerHTML = `<div class="card seg-card"><button class="seg-close" id="seg-close">✕</button>
        <h2>Drawn segment</h2><p class="hint">No runs cover this stretch. Try a wider brush or a different section.</p></div>`;
      $("#seg-close").onclick = () => { $("#segment-panel").innerHTML = ""; };
    }
  };

  const runMatch = async () => {
    if (!stroke || stroke.length < 2) return;
    $("#segment-panel").innerHTML = `<div class="card seg-card"><p class="hint">Matching runs…</p></div>`;
    raw = await matchDrawnEfforts(buildCenterline(stroke), widthM());
    renderDraw();
  };

  const enterDraw = () => {
    if (segLayer) $("#toggle-segments").onclick();    // can't show both overlays at once
    drawMode = true;
    drawBtn.classList.add("active"); drawBtn.setAttribute("aria-pressed", "true");
    drawCtl.classList.remove("hidden");
    all.forEach((pl) => pl.setStyle({ opacity: 0.05 }));
    map.dragging.disable();
    map.getContainer().style.cursor = "crosshair";
  };
  const exitDraw = () => {
    drawMode = false; drawing = false;
    drawBtn.classList.remove("active"); drawBtn.setAttribute("aria-pressed", "false");
    drawCtl.classList.add("hidden");
    all.forEach((pl) => pl.setStyle({ opacity: 0.3 }));
    map.dragging.enable();
    map.getContainer().style.cursor = "";
    clearDraw();
  };
  drawBtn.onclick = () => (drawMode ? exitDraw() : enterDraw());

  map.on("mousedown", (e) => {
    if (!drawMode) return;
    drawing = true;
    clearDraw();
    stroke = [[e.latlng.lat, e.latlng.lng]];
    drawLayer = L.layerGroup().addTo(map);
    livePoly = L.polyline(stroke, { color: "#ffd23f", weight: 3, opacity: 0.95, interactive: false }).addTo(drawLayer);
  });
  map.on("mousemove", (e) => {
    if (!drawMode || !drawing) return;
    const last = stroke[stroke.length - 1];
    const dM = Math.hypot((e.latlng.lat - last[0]) * SEG_MPD_LAT, (e.latlng.lng - last[1]) * SEG_MPD_LAT * Math.cos((last[0] * Math.PI) / 180));
    if (dM < 5) return;                               // ~5 m sampling, keeps the stroke light
    stroke.push([e.latlng.lat, e.latlng.lng]);
    livePoly.setLatLngs(stroke);
  });
  map.on("mouseup", () => {
    if (!drawMode || !drawing) return;
    drawing = false;
    if (!stroke || stroke.length < 2 || buildCenterline(stroke).total < 30) { clearDraw(); return; }
    runMatch();
  });

  widthInput.oninput = () => { widthVal.textContent = `${widthM()} m`; };
  widthInput.onchange = () => { if (stroke && stroke.length >= 2) runMatch(); };
  drawCtl.querySelectorAll(".draw-dir button").forEach((b) => (b.onclick = () => {
    drawCtl.querySelectorAll(".draw-dir button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    directional = b.dataset.dir === "1";
    if (raw) renderDraw();
  }));
  $("#draw-new").onclick = () => clearDraw();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawMode) exitDraw(); });

  fit((buttons[1] || buttons[0]).bounds);
}

/* ---------- drawn-segment matcher ----------
 * Match every run against a hand-drawn corridor. The drawn stroke is the centerline;
 * a run point is "inside" if its perpendicular distance to that centerline <= half the
 * brush width. Projecting each inside-point onto the centerline gives its arc-length
 * position s (0=start A, 1=end B); a run "did" the segment if it covers >= SEG_COVER of
 * that length without turning around. This is the same coverage/turnaround logic as the
 * auto-miner (web/build/segments.js) but projected onto the *drawn* path instead of a
 * fitted straight axis, so the stroke may curve. */
const SEG_MPD_LAT = 111320.0;      // meters per degree latitude
const SEG_COVER = 0.8;             // an effort must span >= 80% of the drawn length
const SEG_GAP_PTS = 8;             // bridge this many off-corridor points within one pass
const SEG_DIR8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const SEG_MI_M = 1609.344;

// Pre-project the drawn stroke into local east/north meters and accumulate arc length.
function buildCenterline(latlngs) {
  if (!latlngs || latlngs.length < 2) return null;
  const coslat = Math.cos((latlngs[0][0] * Math.PI) / 180);
  const ex = (lo) => lo * SEG_MPD_LAT * coslat;
  const ny = (la) => la * SEG_MPD_LAT;
  const pts = latlngs.map(([la, lo]) => [ex(lo), ny(la)]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  let minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
  for (const [la, lo] of latlngs) { if (la < minLa) minLa = la; if (la > maxLa) maxLa = la; if (lo < minLo) minLo = lo; if (lo > maxLo) maxLo = lo; }
  return { pts, cum, total, coslat, ex, ny, bbox: { minLa, maxLa, minLo, maxLo } };
}

// Nearest point on the centerline to a meter-coord (px,py): perpendicular distance + s.
function projectToCenterline(cl, px, py) {
  let bestD = Infinity, bestS = 0;
  for (let i = 0; i < cl.pts.length - 1; i++) {
    const ax = cl.pts[i][0], ay = cl.pts[i][1];
    const dx = cl.pts[i + 1][0] - ax, dy = cl.pts[i + 1][1] - ay;
    const seg2 = dx * dx + dy * dy;
    let t = seg2 ? ((px - ax) * dx + (py - ay) * dy) / seg2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < bestD) { bestD = d; bestS = cl.total ? (cl.cum[i] + t * Math.sqrt(seg2)) / cl.total : 0; }
  }
  return { d: bestD, s: bestS };
}

// Clean traversals of the corridor by one run's track ([[lat,lon],...]); returns legs of
// {lo, hi, dir} index spans (dir +1 = toward B). One-way = 1 leg, out-and-back = 2.
function matchTrack(cl, track, halfW) {
  const pad = halfW / SEG_MPD_LAT + 1e-4, padLo = halfW / (SEG_MPD_LAT * cl.coslat) + 1e-4;
  let lo = Infinity, hi = -Infinity, wlo = Infinity, whi = -Infinity;
  for (const [la, ln] of track) { if (la < lo) lo = la; if (la > hi) hi = la; if (ln < wlo) wlo = ln; if (ln > whi) whi = ln; }
  if (hi < cl.bbox.minLa - pad || lo > cl.bbox.maxLa + pad || whi < cl.bbox.minLo - padLo || wlo > cl.bbox.maxLo + padLo) return [];

  const inside = [];
  for (let i = 0; i < track.length; i++) {
    const pr = projectToCenterline(cl, cl.ex(track[i][1]), cl.ny(track[i][0]));
    if (pr.d <= halfW) inside.push({ i, s: pr.s });
  }
  if (inside.length < 2) return [];

  const groups = [];
  let cur = [inside[0]];
  for (let k = 1; k < inside.length; k++) {
    if (inside[k].i - cur[cur.length - 1].i <= SEG_GAP_PTS) cur.push(inside[k]);
    else { groups.push(cur); cur = [inside[k]]; }
  }
  groups.push(cur);

  const legs = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const sv = g.map((p) => p.s);
    const argmax = sv.indexOf(Math.max(...sv)), argmin = sv.indexOf(Math.min(...sv));
    const extMax = argmax !== 0 && argmax !== sv.length - 1 ? argmax : null;
    const extMin = argmin !== 0 && argmin !== sv.length - 1 ? argmin : null;
    const turn = extMax != null ? extMax : extMin;        // interior extreme = turnaround
    const spans = turn ? [[0, turn], [turn, g.length - 1]] : [[0, g.length - 1]];
    for (const [a, b] of spans) {
      if (Math.abs(sv[b] - sv[a]) < SEG_COVER) continue;  // covers < 80% of the drawn length
      legs.push({ lo: g[a].i, hi: g[b].i, dir: sv[b] > sv[a] ? 1 : -1 });
    }
  }
  return legs;
}

// Distance/pace/HR/EF for one leg, read from the run's index-aligned stream arrays.
function effortFromLeg(st, leg) {
  if (!st.t || leg.hi >= st.t.length || !st.dist_mi) return null;
  const dt = st.t[leg.hi] - st.t[leg.lo];
  const dmi = st.dist_mi[leg.hi] - st.dist_mi[leg.lo];
  if (!(dt > 0) || !(dmi > 0)) return null;
  let sum = 0, n = 0;
  for (let i = leg.lo; i <= leg.hi; i++) if (st.hr && st.hr[i] != null) { sum += st.hr[i]; n++; }
  const hr = n ? sum / n : null;
  return {
    time_s: Math.round(dt * 10) / 10, pace_s: Math.round((dt / dmi) * 10) / 10,
    hr: hr ? Math.round(hr * 10) / 10 : null,
    ef: hr ? Math.round(((dmi * SEG_MI_M) / dt / hr) * 1e5) / 1e5 : null,
    dir: leg.dir,
  };
}

// Linear EF-vs-time fit → label (mirrors trend() in web/build/segments.js).
function segTrend(efforts) {
  const pts = efforts.filter((e) => e.ef != null).map((e) => [e.ord, e.ef]);
  if (pts.length < 4) return { label: "flat", slope: null };
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  const span = Math.max(...xs) - Math.min(...xs);
  const rel = span && my ? (slope * span) / my : 0;
  return { label: rel > 0.03 ? "improving" : rel < -0.03 ? "declining" : "flat", slope };
}

function segDirLabel(latlngs) {
  const [la0, lo0] = latlngs[0], [la1, lo1] = latlngs[latlngs.length - 1];
  const dy = la1 - la0, dx = (lo1 - lo0) * Math.cos((la0 * Math.PI) / 180);
  const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return SEG_DIR8[Math.floor((bearing + 22.5) / 45) % 8];
}

// Phase 1 (geometry on already-loaded routes) + phase 2 (fetch streams for matches only).
// Returns the raw per-leg efforts keyed with run date/type; aggregation by direction is
// deferred to aggregateDrawn so the Directional/Either-way toggle never re-fetches.
async function matchDrawnEfforts(cl, widthM) {
  const halfW = widthM / 2;
  const matches = [];
  for (const f of state.routes.features) {
    const track = f.geometry.coordinates.map(([lo, la]) => [la, lo]);
    const legs = matchTrack(cl, track, halfW);
    if (legs.length) matches.push({ id: f.properties.id, legs });
  }
  const efforts = [];
  await Promise.all(matches.map(async (m) => {
    const d = await loadStream(m.id);
    const st = d && d.stream;
    // Leg indices come from the GPS polyline; the time/dist streams are index-aligned with
    // it only when the run has no GPS-dropout rows (equal lengths). If they diverge, skip
    // the run rather than read mismatched samples.
    if (!st || !st.t || !st.dist_mi || !st.latlng) return;
    if (st.latlng.length !== st.t.length || st.t.length !== st.dist_mi.length) return;
    const run = state.runs.find((r) => r.id === m.id) || {};
    const date = (run.date || "").slice(0, 10);
    const ord = date ? Math.floor(Date.parse(date) / 864e5) : 0;
    for (const leg of m.legs) {
      const e = effortFromLeg(st, leg);
      if (e) efforts.push({ id: m.id, date, type: run.type || "easy", ord, ...e });
    }
  }));
  return efforts;
}

// Shape raw efforts into the seg object showSegmentPanel expects. Directional keeps only
// the drawn A→B direction; "either way" keeps both (an out-and-back contributes two).
function aggregateDrawn(raw, lengthMi, dirLabel, directional) {
  const kept = (directional ? raw.filter((e) => e.dir > 0) : raw)
    .slice()
    .sort((a, b) => a.ord - b.ord || (a.date < b.date ? -1 : 1));
  const efforts = kept.map((e) => ({ id: e.id, date: e.date, type: e.type, time_s: e.time_s, pace_s: e.pace_s, hr: e.hr, ef: e.ef }));
  return {
    name: "Drawn segment", length_mi: lengthMi, dir_label: dirLabel,
    n_runs: efforts.length, trend: segTrend(kept), efforts, reverse: null,
  };
}

// Trend panel for one segment: EF headline + pace & HR below, each effort a dot
// colored by run type (click a dot to open that run). If the segment was also run
// the other way, a direction toggle flips between the two (grade differs, so they
// trend separately).
const SEG_TREND = { improving: ["▲ improving", "#45c08a"], declining: ["▼ declining", "#ec5fa6"], flat: ["▬ flat", "#8b94a3"] };

function showSegmentPanel(seg) {
  const panel = $("#segment-panel");
  // Both directions share one geometry; build a pickable list (primary first).
  const dirs = [{ dir_label: seg.dir_label, n_runs: seg.n_runs, trend: seg.trend, efforts: seg.efforts }];
  if (seg.reverse) dirs.push(seg.reverse);

  const toggle = dirs.length > 1
    ? `<div class="pr-controls seg-dirs">${dirs.map((d, i) =>
        `<button class="${i === 0 ? "active" : ""}" data-d="${i}">${d.dir_label} (${d.n_runs}×)</button>`).join("")}</div>`
    : "";
  panel.innerHTML = `<div class="card seg-card">
    <button class="seg-close" id="seg-close">✕</button>
    <h2>${escapeHtml(seg.name)}</h2>
    <p class="hint" id="seg-sub"></p>
    ${toggle}
    <div id="seg-ef" style="height:210px"></div>
    <div class="seg-mini">
      <div><h3>Pace</h3><div id="seg-pace" style="height:160px"></div></div>
      <div><h3>Heart rate</h3><div id="seg-hr" style="height:160px"></div></div>
    </div>
    <p class="hint">Dots colored by run type. Click any dot to open that run.</p>
  </div>`;
  $("#seg-close").onclick = () => { panel.innerHTML = ""; };
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const render = (d) => {
    const efs = d.efforts;
    const [tlabel, tcolor] = SEG_TREND[d.trend.label] || SEG_TREND.flat;
    $("#seg-sub").innerHTML = `${seg.length_mi} mi · heading ${d.dir_label} · run ${d.n_runs}× · efficiency
      <span style="color:${tcolor};font-weight:600">${tlabel}</span>`;
    const x = efs.map((e) => e.date);
    const customdata = efs.map((e) => e.id);
    const marker = () => ({
      size: 9, color: efs.map((e) => TYPE_COLORS[e.type] || "#888"),
      symbol: efs.map((e) => TYPE_SYMBOLS[e.type] || "circle"),
      line: { width: 1, color: "#11151c" },
    });
    const dots = (y, fmt) => ({
      type: "scatter", mode: "markers", x, y, marker: marker(), customdata,
      text: efs.map((e, i) => `${e.date} · ${e.type} · ${fmt(e, i)}`), hovertemplate: "%{text}<extra></extra>",
    });

    const efy = efs.map((e) => e.ef);
    plot("seg-ef", [
      dots(efy, (e) => `EF ${e.ef != null ? e.ef.toFixed(4) : "—"}`),
      { type: "scatter", mode: "lines", x, y: rolling(efy, 5), line: { color: "#ffd23f", width: 2 }, hoverinfo: "skip", showlegend: false },
    ], { margin: { l: 56, r: 16, t: 8, b: 34 }, xaxis: { gridcolor: GRID },
         yaxis: { title: "EF (speed ÷ HR)", gridcolor: GRID }, height: 210 }, true);

    const py = efs.map((e) => e.pace_s);
    plot("seg-pace", [dots(py, (e) => `${fmtPace(e.pace_s)}/mi`)],
      { margin: { l: 52, r: 12, t: 6, b: 30 }, xaxis: { gridcolor: GRID }, yaxis: paceAxis(py), height: 160 }, true);

    const hy = efs.map((e) => e.hr);
    plot("seg-hr", [dots(hy, (e) => `${e.hr != null ? Math.round(e.hr) : "—"} bpm`)],
      { margin: { l: 46, r: 12, t: 6, b: 30 }, xaxis: { gridcolor: GRID }, yaxis: { gridcolor: GRID }, height: 160 }, true);
  };

  panel.querySelectorAll(".seg-dirs button").forEach((b) => (b.onclick = () => {
    panel.querySelectorAll(".seg-dirs button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    render(dirs[+b.dataset.d]);
  }));
  render(dirs[0]);
}

// Info-icon tooltips: hover works via CSS; click toggles for touch devices.
document.addEventListener("click", (e) => {
  const info = e.target.closest(".info");
  document.querySelectorAll(".info.show").forEach((i) => { if (i !== info) i.classList.remove("show"); });
  if (info) { info.classList.toggle("show"); e.stopPropagation(); }
});

boot();
