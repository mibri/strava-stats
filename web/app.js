/* Strava Stats dashboard. Reads the pipeline's JSON from ../data/clean/. */
const DATA = "../data/clean";
const MEDIA = "../data/media";
const TYPE_COLORS = {
  easy: "#4f93ff", long: "#9b6bff", workout: "#fc5200",
  recovery: "#45c08a", race: "#ffd23f",
};
const PLOT_FONT = { color: "#8b94a3", family: "-apple-system, Segoe UI, Roboto, sans-serif" };

const state = { runs: [], summary: null, routes: null, points: [],
  sortKey: "date", sortDir: -1, timeframe: "all", dateById: {} };

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
const fmtPace = (s) => (s == null || !isFinite(s) ? "—" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
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
  return { range: [end, start], tickvals, ticktext, gridcolor: "#2a313c", zeroline: false };
}

const baseLayout = (over = {}) => ({
  paper_bgcolor: "transparent", plot_bgcolor: "transparent",
  font: PLOT_FONT, margin: { l: 56, r: 24, t: 16, b: 40 },
  xaxis: { gridcolor: "#2a313c", zeroline: false, ...(over.xaxis || {}) },
  yaxis: { gridcolor: "#2a313c", zeroline: false, ...(over.yaxis || {}) },
  legend: { orientation: "h", y: 1.12, font: { size: 11 } },
  hovermode: "closest",
  hoverlabel: { bgcolor: "#1f242d", bordercolor: "#3a424f",
    font: { family: PLOT_FONT.family, color: "#e7ecf3", size: 12 }, align: "left" },
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
  const [summary, runs, routes] = await Promise.all([
    fetch(`${DATA}/summary.json`).then((r) => r.json()),
    fetch(`${DATA}/runs.json`).then((r) => r.json()),
    fetch(`${DATA}/routes.geojson`).then((r) => r.json()).catch(() => null),
  ]);
  state.summary = summary; state.runs = runs; state.routes = routes; state.points = summary.points || [];
  runs.forEach((r) => { const d = r.date.slice(0, 10); if (!state.dateById[d]) state.dateById[d] = r.id; });

  const t = summary.totals;
  $("#subtitle").textContent = `${num(t.runs)} runs · ${num(t.miles)} mi · ${t.first} → ${t.last}`;

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
  }], { yaxis: { title: "miles", gridcolor: "#2a313c" } });

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

  const blocks = years.map((yr) => {
    const start = new Date(`${yr}-01-01`); start.setDate(start.getDate() - start.getDay()); // back to Sunday
    const end = new Date(`${yr}-12-31`);
    const cells = []; const monthMarks = []; let col = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 0) col++;
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (d.getFullYear() != yr) { cells.push(`<div class="cal-cell future"></div>`); continue; }
      if (d.getDate() <= 7 && d.getDay() === 0) monthMarks.push({ col, label: d.toLocaleString("en", { month: "short" }) });
      if (d > today) { cells.push(`<div class="cal-cell future"></div>`); continue; }
      const mi = byDate[iso] || 0;
      const click = state.dateById[iso] ? ` data-id="${state.dateById[iso]}"` : "";
      cells.push(`<div class="cal-cell${mi > 0 ? " has" : ""}"${click} title="${iso}: ${mi.toFixed(1)} mi" style="background:${color(mi)}"></div>`);
    }
    return `<div class="cal-year">
      <div class="cal-year-label">${yr}</div>
      <div class="cal-months">${monthMarks.map((m) => `<span class="cal-month" style="grid-column:${m.col}">${m.label}</span>`).join("")}</div>
      <div class="cal-row"><div class="cal-dow">${dow.map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="cal-grid">${cells.join("")}</div></div>
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
    `<img src="${MEDIA}/${p.file.replace("media/", "")}" loading="lazy" data-i="${i}" title="${escapeHtml(p.name)} · ${p.date}" />`).join("");
  $("#photo-strip").querySelectorAll("img").forEach((img) =>
    (img.onclick = () => openLightbox(state.lbSet, +img.dataset.i)));
}

/* ---------- lightbox ---------- */
function openLightbox(set, i) {
  state.lbCur = { set, i };
  const p = set[i];
  $("#lb-img").src = `${MEDIA}/${p.file.replace("media/", "")}`;
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
  ], { yaxis: { title: "miles", gridcolor: "#2a313c" } });

  // Projected marathon time vs goal
  drawMarathon();

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
    yaxis: { title: "load", gridcolor: "#2a313c" },
    yaxis2: { title: { text: "form", standoff: 16 }, overlaying: "y", side: "right",
      zeroline: true, zerolinecolor: "#2a313c", showgrid: false, automargin: true },
  });

  // Injury-risk ACWR
  const acwr = fit.filter((d) => d.acwr != null);
  plot("chart-acwr", [
    { type: "scatter", mode: "lines", x: acwr.map((d) => d.date), y: acwr.map((d) => d.acwr),
      line: { color: "#e7ecf3", width: 2 }, hovertemplate: "%{x}<br>ACWR %{y:.2f}<extra></extra>" },
  ], {
    shapes: [
      { type: "rect", xref: "paper", x0: 0, x1: 1, y0: 0.8, y1: 1.3, fillcolor: "#45c08a18", line: { width: 0 } },
      { type: "rect", xref: "paper", x0: 0, x1: 1, y0: 1.5, y1: 3, fillcolor: "#e24b4a18", line: { width: 0 } },
    ],
    yaxis: { title: "acute : chronic", gridcolor: "#2a313c", range: [0, Math.max(2, ...acwr.map((d) => d.acwr)) + 0.2] },
  });

  // Aerobic efficiency (easy/long runs)
  drawEF("chart-ef", pts.filter((p) => ["easy", "long", "recovery"].includes(p.type) && p.ef != null), "ef", "speed per heartbeat →");

  // Hill efficiency (grade-adjusted EF, hilly runs only)
  drawEF("chart-hill", pts.filter((p) => p.ef_gap != null && p.elev_pm >= 40), "ef_gap", "climb-adjusted speed per heartbeat →");

  // Pace trend by type
  const types = ["easy", "long", "workout", "race", "recovery"];
  const paceTraces = types.map((ty) => {
    const p = pts.filter((x) => x.type === ty);
    return { type: "scatter", mode: "markers", name: ty, x: p.map((x) => x.date), y: p.map((x) => x.pace_s),
      marker: { color: TYPE_COLORS[ty], size: 7, opacity: 0.75 }, customdata: p.map((x) => x.id),
      text: p.map((x) => `${x.date} · ${x.dist} mi · ${fmtPace(x.pace_s)}/mi`),
      hovertemplate: `%{text}<extra>${ty}</extra>` };
  }).filter((t) => t.x.length);
  plot("chart-pace", paceTraces, { yaxis: { title: "pace (/mi)", ...paceAxis(pts.map((p) => p.pace_s)) } }, true);

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
    yaxis: { title: "HR drift (%)", gridcolor: "#2a313c" },
  }, true);

  // Cadence trend
  const cad = pts.filter((p) => p.cadence != null);
  plot("chart-cadence", [
    { type: "scatter", mode: "markers", name: "runs", x: cad.map((p) => p.date), y: cad.map((p) => p.cadence),
      marker: { color: "#45c08a", size: 6, opacity: 0.5 }, customdata: cad.map((p) => p.id),
      text: cad.map((p) => `${p.date} · ${Math.round(p.cadence)} spm`), hovertemplate: "%{text}<extra></extra>" },
    { type: "scatter", mode: "lines", name: "trend", x: cad.map((p) => p.date), y: rolling(cad.map((p) => p.cadence), 8),
      line: { color: "#ffd23f", width: 3 } },
  ], { yaxis: { title: "steps / min", gridcolor: "#2a313c" } }, true);

  // Heat vs pace
  const hot = pts.filter((p) => p.temp_f != null && ["easy", "long", "recovery"].includes(p.type));
  plot("chart-temp", [{
    type: "scatter", mode: "markers", x: hot.map((p) => p.temp_f), y: hot.map((p) => p.pace_s),
    marker: { color: "#fc5200", size: 7, opacity: 0.6 }, customdata: hot.map((p) => p.id),
    text: hot.map((p) => `${p.date} · ${Math.round(p.temp_f)}°F · ${fmtPace(p.pace_s)}/mi`),
    hovertemplate: "%{text}<extra></extra>",
  }], { xaxis: { title: "temperature (°F)", gridcolor: "#2a313c" }, yaxis: { title: "pace (/mi)", ...paceAxis(hot.map((p) => p.pace_s)) } }, true);

  // PR progression
  buildPRChart();

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
  ], { yaxis: { title: ytitle, gridcolor: "#2a313c" } }, true);
}

function drawPatterns() {
  const p = state.summary.patterns;
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const dowRuns = names.map((_, i) => (p.dow.find((d) => d.dow === i) || {}).runs || 0);
  plot("chart-dow", [{
    type: "bar", x: names, y: dowRuns, marker: { color: "#4f93ff" },
    hovertemplate: "%{x}<br>%{y} runs<extra></extra>",
  }], { margin: { l: 40, r: 12, t: 10, b: 32 }, yaxis: { title: "runs", gridcolor: "#2a313c" } });

  const hours = Array.from({ length: 24 }, (_, h) => (p.hours.find((x) => x.hour === h) || {}).runs || 0);
  plot("chart-hour", [{
    type: "bar", x: hours.map((_, h) => `${h}`), y: hours, marker: { color: "#fc5200" },
    hovertemplate: "%{x}:00<br>%{y} runs<extra></extra>",
  }], { margin: { l: 40, r: 12, t: 10, b: 32 }, xaxis: { title: "hour of day", gridcolor: "#2a313c" }, yaxis: { title: "runs", gridcolor: "#2a313c" } });
}

function drawMarathon() {
  const GOAL = 3 * 3600 + 45 * 60; // sub-3:45
  const all = (state.summary.marathon_projection || []).filter((p) => inFrame(p.date));
  if (!all.length) { Plotly.purge("chart-marathon"); return; }
  let best = Infinity; const line = [];
  all.forEach((p) => { if (p.proj_s < best) { best = p.proj_s; line.push(p); } });
  const xs = all.map((p) => p.date);
  // Clamp the axis: easy-run efforts can project absurd marathons; show the useful band.
  const sorted = all.map((p) => p.proj_s).sort((a, b) => a - b);
  const yMin = Math.max(2.5 * 3600, Math.min(best, GOAL) - 600);
  const yMax = Math.min(sorted[Math.floor(sorted.length * 0.9)] || 6 * 3600, 6.5 * 3600);
  const ticks = []; for (let t = Math.ceil(yMin / 900) * 900; t <= yMax; t += 900) ticks.push(t);
  plot("chart-marathon", [
    { type: "scatter", mode: "markers", name: "per-run projection", x: xs, y: all.map((p) => p.proj_s),
      marker: { color: "#4f93ff", size: 5, opacity: 0.3 }, customdata: all.map((p) => p.id),
      text: all.map((p) => `${p.date} · ${fmtDur(p.proj_s)} (from ${p.from})`), hovertemplate: "%{text}<extra></extra>" },
    { type: "scatter", mode: "lines+markers", name: "best projection", x: line.map((p) => p.date), y: line.map((p) => p.proj_s),
      line: { color: "#fc5200", width: 3, shape: "hv" }, marker: { size: 7, color: "#fc5200" },
      customdata: line.map((p) => p.id), text: line.map((p) => `${p.date} · ${fmtDur(p.proj_s)}`), hovertemplate: "%{text}<extra></extra>" },
    { type: "scatter", mode: "lines", name: "goal 3:45", x: [xs[0], xs[xs.length - 1]], y: [GOAL, GOAL],
      line: { color: "#ffd23f", width: 2, dash: "dash" }, hoverinfo: "skip" },
  ], {
    yaxis: { title: "projected time", range: [yMax, yMin], gridcolor: "#2a313c",
      tickvals: ticks, ticktext: ticks.map(fmtDur) },
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
    xaxis: { title: `hours (HRmax est. ${hz.hrmax})`, gridcolor: "#2a313c" }, yaxis: { gridcolor: "#2a313c" } });
}

let prDist = null;
function buildPRChart() {
  const prog = state.summary.pr_progression;
  const dists = Object.keys(prog).filter((k) => prog[k].length);
  if (!prDist) prDist = dists.includes("5k") ? "5k" : dists[0];
  $("#pr-controls").innerHTML = dists.map((d) =>
    `<button class="${d === prDist ? "active" : ""}" data-d="${d}">${d}</button>`).join("");
  $("#pr-controls").querySelectorAll("button").forEach((b) => (b.onclick = () => { prDist = b.dataset.d; buildPRChart(); }));

  const e = prog[prDist].filter((p) => inFrame(p.date));
  // recompute running-best within the window
  let best = Infinity; const prs = [];
  e.forEach((p) => { if (p.time_s < best) { best = p.time_s; prs.push(p); } });
  plot("chart-pr", [
    { type: "scatter", mode: "markers", name: "efforts", x: e.map((p) => p.date), y: e.map((p) => p.time_s),
      marker: { color: "#4f93ff", size: 6, opacity: 0.4 }, customdata: e.map((p) => p.id),
      text: e.map((p) => `${p.date} · ${p.time}`), hovertemplate: "%{text}<extra></extra>" },
    { type: "scatter", mode: "lines+markers", name: "best", x: prs.map((p) => p.date), y: prs.map((p) => p.time_s),
      line: { color: "#fc5200", width: 3, shape: "hv" }, marker: { size: 8, color: "#fc5200" },
      customdata: prs.map((p) => p.id), text: prs.map((p) => `${p.date} · PR ${p.time}`), hovertemplate: "%{text}<extra></extra>" },
  ], { yaxis: { title: "time", autorange: "reversed", gridcolor: "#2a313c",
      tickvals: tickTimes(e.map((p) => p.time_s)), ticktext: tickTimes(e.map((p) => p.time_s)).map(fmtDur) } }, true);
}
function tickTimes(vals) {
  const v = vals.filter((x) => x != null);
  if (!v.length) return [];
  const lo = Math.min(...v), hi = Math.max(...v), step = Math.max(5, Math.round((hi - lo) / 6 / 5) * 5);
  const out = []; for (let t = Math.floor(lo / step) * step; t <= hi + step; t += step) out.push(t);
  return out;
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
      <td>${escapeHtml(r.name)}${r.n_photos ? " 📷" : ""}${r.description ? ` <span class="muted">· ${escapeHtml(r.description.slice(0, 40))}</span>` : ""}</td>
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
let detailMap = null;
async function openRun(id) {
  const r = state.runs.find((x) => x.id === id);
  if (!r) return;
  const d = await fetch(`${DATA}/streams/${id}.json`).then((x) => x.json()).catch(() => null);
  const be = d && d.best_efforts || {};
  const beHtml = Object.entries(be).map(([k, v]) => `<span class="be">${k} <b>${v.t}</b></span>`).join("");
  const photos = (d && d.photos) || [];
  const photoSet = photos.map((f) => ({ file: f, name: r.name, date: r.date.slice(0, 10), id: r.id }));
  const photoHtml = photos.length
    ? `<div class="detail-photos">${photos.map((f, i) => `<img src="${MEDIA}/${f.replace("media/", "")}" data-i="${i}" />`).join("")}</div>` : "";

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
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(detailMap);
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
    }], { margin: { l: 50, r: 16, t: 6, b: 30 }, xaxis: { title: xt, gridcolor: "#2a313c" },
        yaxis: t.pace ? paceAxis(t.y) : { gridcolor: "#2a313c" }, height: 180 });
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
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(map);

  const all = [];
  state.routes.features.forEach((f) => {
    const latlng = f.geometry.coordinates.map(([lo, la]) => [la, lo]);
    const pl = L.polyline(latlng, { color: "#fc5200", weight: 2, opacity: 0.3 }).addTo(map);
    pl.on("mouseover", () => pl.setStyle({ opacity: 1, weight: 4 }));
    pl.on("mouseout", () => pl.setStyle({ opacity: 0.3, weight: 2 }));
    pl.on("click", () => openRun(f.properties.id));
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

  // Photo pins (placed at each photographed run's start point)
  let photoLayer = null;
  const startById = {};
  state.routes.features.forEach((f) => { startById[f.properties.id] = f.geometry.coordinates[0]; });
  $("#toggle-photos").onclick = () => {
    const btn = $("#toggle-photos");
    if (photoLayer) { map.removeLayer(photoLayer); photoLayer = null; btn.textContent = "📷 Show photo pins"; btn.classList.remove("active"); return; }
    photoLayer = L.layerGroup();
    const byRun = {};
    (state.summary.photos || []).forEach((p) => { (byRun[p.id] ||= []).push(p); });
    Object.entries(byRun).forEach(([rid, ps]) => {
      const c = startById[rid]; if (!c) return;
      const thumb = `${MEDIA}/${ps[0].file.replace("media/", "")}`;
      const icon = L.divIcon({ className: "", html: `<img src="${thumb}" style="width:34px;height:34px;border-radius:6px;border:2px solid #fc5200;object-fit:cover">`, iconSize: [34, 34] });
      L.marker([c[1], c[0]], { icon }).on("click", () => openLightbox(ps.map((p) => ({ ...p })), 0)).addTo(photoLayer);
    });
    photoLayer.addTo(map);
    btn.textContent = "📷 Hide photo pins"; btn.classList.add("active");
  };

  fit((buttons[1] || buttons[0]).bounds);
}

boot();
