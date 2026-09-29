/* Records + Years tabs, and the Overview "at a glance" strip. Rendering only: the
 * numbers come from web/analytics.js (window.Analytics). Loaded before app.js and
 * called from its boot(), so it can use app.js's shared helpers (plot, fmtPace, state…)
 * at call time. */

const YEAR_COLORS = ["#fc5200", "#4f93ff", "#45c08a", "#9b6bff"];   // newest → older
const isLight = () => document.documentElement.getAttribute("data-theme") === "light";
// Sequential single-hue ramp for heatmaps: faint → Strava orange (brighter = more in dark
// mode, darker = more in light mode, matching the training calendar).
const seqScale = () => (isLight()
  ? [[0, "#fff4ec"], [0.4, "#ffc9a8"], [0.75, "#ff9a5c"], [1, "#f0631b"]]
  : [[0, "#1f242d"], [0.4, "#5a2a10"], [0.75, "#96400f"], [1, "#c24e0f"]]);   // keeps cell labels legible
const narrow = () => window.innerWidth < 640;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmtHour = (h) => (h == null ? "—" : `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`);
const fmtDate = (d) => {
  if (!d) return "—";
  const [y, m, dd] = d.slice(0, 10).split("-");
  return dd ? `${MONTHS[+m - 1]} ${+dd}, ${y}` : `${MONTHS[+m - 1]} ${y}`;
};
const fmtHM = (s) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
const fmtDelta = (v, digits = 0, unit = "") => {
  if (v == null || !isFinite(v) || Math.abs(v) < Math.pow(10, -digits) / 2) return `<span class="delta flat">±0${unit}</span>`;
  return `<span class="delta ${v > 0 ? "up" : "down"}">${v > 0 ? "▲" : "▼"} ${num(Math.abs(v), digits)}${unit}</span>`;
};

/** The date the dashboard treats as "now": today, unless the data stops well before
 *  today (the bundled sample, an old export), in which case the last run's date. */
function todayStr() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}
function anchorDate() {
  const last = state.summary.totals.last, t = todayStr();
  return Analytics.dayNum(t) - Analytics.dayNum(last) > 45 ? last : t;
}

/* =================== Overview: at a glance =================== */
function renderGlance() {
  const el = $("#glance");
  if (!el) return;
  const A = Analytics, runs = state.runs;
  const anchor = anchorDate(), an = A.dayNum(anchor);
  const dow = A.dowOf(anchor);
  // Current period so far vs. the same stretch of the previous period.
  const periods = [
    { lbl: "This week", from: an - dow, prevFrom: an - dow - 7, prevTo: an - 7 },
    { lbl: "This month", from: A.dayNum(anchor.slice(0, 8) + "01") },
    { lbl: "This year", from: A.dayNum(anchor.slice(0, 5) + "01-01") },
  ];
  // previous month / year windows: same day-of-period a period earlier
  const prevMonth = (() => { const y = +anchor.slice(0, 4), m = +anchor.slice(5, 7); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; })();
  periods[1].prevFrom = A.dayNum(prevMonth + "-01");
  periods[1].prevTo = Math.min(periods[1].prevFrom + (an - periods[1].from), periods[1].from - 1);
  periods[2].prevFrom = A.dayNum(`${+anchor.slice(0, 4) - 1}-01-01`);
  periods[2].prevTo = A.dayNum(`${+anchor.slice(0, 4) - 1}${anchor.slice(4, 10)}`.replace("-02-29", "-02-28"));

  const agg = (lo, hi) => {
    let mi = 0, n = 0, s = 0;
    for (const r of runs) { const d = A.dayNum(r.date.slice(0, 10)); if (d >= lo && d <= hi) { mi += r.distance_mi || 0; n++; s += r.moving_s || 0; } }
    return { mi, n, s };
  };
  const stale = anchor !== todayStr();
  el.innerHTML = `<div class="glance-head"><h2>At a glance</h2><span class="muted">${stale ? `as of your last run · ${fmtDate(anchor)}` : fmtDate(anchor)}</span></div>
    <div class="glance-grid">${periods.map((p) => {
      const cur = agg(p.from, an), prev = agg(p.prevFrom, p.prevTo);
      return `<div class="glance">
        <div class="glance-lbl">${p.lbl}</div>
        <div class="glance-val">${num(cur.mi, 1)}<span class="unit">mi</span></div>
        <div class="glance-sub">${cur.n} run${cur.n === 1 ? "" : "s"} · ${fmtHM(cur.s)} ${fmtDelta(cur.mi - prev.mi, 1, " mi")}<span class="muted"> vs. last ${p.lbl.split(" ")[1]}</span></div>
      </div>`;
    }).join("")}</div>`;
}

/* =================== Records tab =================== */
let recordsBuilt = false;
function renderRecords() {
  if (recordsBuilt) return;
  recordsBuilt = true;
  const A = Analytics;
  const recs = A.effortsByRun(state.points, state.summary.pr_progression);
  state.effortRecs = recs;
  renderTrophies(recs);
  renderStreaks();
  setupPaceCurve(recs);
  renderPrTimeline(recs);
  renderSuperlatives();
  renderDistanceMix();
  renderPaceDistance();
}

function renderTrophies(recs) {
  const A = Analytics;
  const all = A.paceCurve(recs);
  const yr = anchorDate().slice(0, 4);
  const thisYear = Object.fromEntries(A.paceCurve(recs, `${yr}-01-01`).map((p) => [p.label, p]));
  if (!all.length) { $("#trophies").innerHTML = `<p class="muted">No best efforts yet — they come from GPS tracks.</p>`; return; }
  $("#trophies").innerHTML = all.map((p) => {
    const ty = thisYear[p.label];
    const sameAsAll = ty && ty.id === p.id;
    return `<button class="trophy" data-id="${p.id}" title="Open the run">
      <span class="trophy-dist">${p.label}</span>
      <span class="trophy-time">${fmtDur(p.s)}</span>
      <span class="trophy-pace">${fmtPace(p.pace_s)}/mi</span>
      <span class="trophy-date">${fmtDate(p.date)}</span>
      <span class="trophy-yr">${ty ? (sameAsAll ? `★ set in ${yr}` : `${yr} best ${fmtDur(ty.s)}`) : `no ${yr} effort`}</span>
    </button>`;
  }).join("");
  $("#trophies").querySelectorAll(".trophy").forEach((b) => (b.onclick = () => openRun(b.dataset.id)));
}

function renderStreaks() {
  const s = Analytics.streaks(state.runs.map((r) => r.date), anchorDate());
  const range = (x) => (x.start ? (x.start === x.end ? fmtDate(x.start) : `${fmtDate(x.start)} – ${fmtDate(x.end)}`) : "—");
  const t = state.summary.totals;
  const span = Analytics.dayNum(t.last) - Analytics.dayNum(t.first) + 1;
  const active = new Set(state.runs.map((r) => r.date.slice(0, 10))).size;
  const tiles = [
    { v: s.current.len, u: "days", l: "Current streak", sub: s.current.len ? `since ${fmtDate(s.current.start)}` : "run today to start one" },
    { v: s.longest.len, u: "days", l: "Longest streak", sub: range(s.longest) },
    { v: s.currentWeeks.len, u: "wks", l: "Weeks in a row", sub: s.currentWeeks.len ? `with at least one run, since ${fmtDate(s.currentWeeks.start)}` : "—" },
    { v: s.longestWeeks.len, u: "wks", l: "Longest weekly streak", sub: range(s.longestWeeks) },
    { v: s.longestBreak.len, u: "days", l: "Longest break", sub: range(s.longestBreak) },
    { v: Math.round((active / span) * 100), u: "%", l: "Days with a run", sub: `${num(active)} of ${num(span)} days` },
  ];
  $("#streaks").innerHTML = tiles.map((x) => `<div class="stat streak">
    <div class="val">${num(x.v)}<span class="unit">${x.u}</span></div>
    <div class="lbl">${x.l}</div><div class="streak-sub">${x.sub}</div></div>`).join("");
}

/* Pace curve: best pace held at each distance, for a few time windows. */
let curveWindows = null;
function setupPaceCurve(recs) {
  const anchor = anchorDate();
  const years = [...new Set(recs.map((r) => r.date.slice(0, 4)))].sort().reverse();
  const back = (days) => Analytics.isoDay(Analytics.dayNum(anchor) - days);
  const opts = [
    { key: "all", label: "All-time", from: null, to: null, color: "#fc5200" },
    { key: "365", label: "Last 365 days", from: back(365), to: null, color: "#4f93ff" },
    { key: "90", label: "Last 90 days", from: back(90), to: null, color: "#45c08a" },
    ...years.map((y) => ({ key: y, label: y, from: `${y}-01-01`, to: `${y}-12-31` })),
  ];
  // Years draw from a fixed set after the window colors; color follows the entity.
  const yColors = ["#9b6bff", "#ec5fa6", "#ffd23f", "#8b94a3"];
  opts.filter((o) => !o.color).forEach((o, i) => (o.color = yColors[i % yColors.length]));
  if (!curveWindows) curveWindows = new Set(["all", "365", "90"]);
  const el = $("#pacecurve-controls");
  const draw = () => {
    el.innerHTML = opts.map((o) => {
      const on = curveWindows.has(o.key);
      return `<button class="type-chip plain ${on ? "on" : ""}" data-k="${o.key}" style="${on ? `border-color:${o.color}` : ""}">
        <span class="glyph" style="color:${on ? o.color : "var(--muted)"}">●</span>${o.label}</button>`;
    }).join("");
    el.querySelectorAll("button").forEach((b) => (b.onclick = () => {
      const k = b.dataset.k;
      curveWindows.has(k) ? curveWindows.delete(k) : curveWindows.add(k);
      draw();
    }));
    const traces = [], allPace = [];
    opts.filter((o) => curveWindows.has(o.key)).forEach((o) => {
      const c = Analytics.paceCurve(recs, o.from, o.to || null);
      if (!c.length) return;
      c.forEach((p) => allPace.push(p.pace_s));
      traces.push({
        type: "scatter", mode: "lines+markers", name: o.label, x: c.map((p) => p.m), y: c.map((p) => p.pace_s),
        line: { color: o.color, width: o.key === "all" ? 3 : 2, shape: "spline", smoothing: 0.6 },
        marker: { color: o.color, size: 8, line: { color: css("--bg-elev", "#171a21"), width: 2 } },
        customdata: c.map((p) => p.id),
        text: c.map((p) => `<b>${p.label}</b> · ${fmtDur(p.s)} · ${fmtPace(p.pace_s)}/mi<br>${fmtDate(p.date)}`),
        hovertemplate: `%{text}<extra>${o.label}</extra>`,
      });
    });
    const D = Analytics.BE_DISTANCES;
    plot("chart-pacecurve", traces, {
      xaxis: { type: "log", tickvals: D.map((d) => d[1]), ticktext: D.map((d) => d[0]), gridcolor: GRID, title: "distance" },
      yaxis: { title: "best pace (/mi)", ...paceAxis(allPace) },
      legend: { orientation: "h", y: 1.12, font: { size: 11 } },
    }, true);
  };
  draw();
}

function renderPrTimeline(recs) {
  const tl = Analytics.prTimeline(recs);
  if (!tl.length) { $("#chart-prtimeline").innerHTML = `<p class="muted" style="padding:20px">No best efforts yet.</p>`; return; }
  const labels = Analytics.BE_DISTANCES.map((d) => d[0]).filter((l) => tl.some((e) => e.label === l));
  const mk = (arr, name, marker) => ({
    type: "scatter", mode: "markers", name, x: arr.map((e) => e.date), y: arr.map((e) => e.label), marker,
    customdata: arr.map((e) => e.id),
    text: arr.map((e) => `<b>${e.label}</b> · ${fmtDur(e.s)} (${fmtPace(e.s / (e.m / Analytics.M_PER_MI))}/mi)` +
      (e.prev != null ? `<br>−${fmtDur(e.prev - e.s)} vs. previous best ${fmtDur(e.prev)}` : "<br>first effort at this distance")),
    hovertemplate: "%{x}<br>%{text}<extra></extra>",
  });
  const firsts = tl.filter((e) => e.first), prs = tl.filter((e) => !e.first);
  // Improvement size → marker size, so big breakthroughs stand out.
  const gain = prs.map((e) => (e.prev - e.s) / e.prev);
  const gmax = Math.max(0.01, ...gain);
  plot("chart-prtimeline", [
    mk(firsts, "first effort", { color: "#8b94a3", size: 8, symbol: "circle-open", line: { width: 2 } }),
    mk(prs, "new best", { color: "#ffd23f", symbol: "star", size: gain.map((g) => 10 + 14 * (g / gmax)),
      line: { color: css("--bg-elev", "#171a21"), width: 1 } }),
  ], {
    yaxis: { type: "category", categoryorder: "array", categoryarray: labels, gridcolor: GRID },
    margin: { l: 70, r: 24, t: 16, b: 40 },
  }, true);
  const recent = [...prs].reverse().slice(0, 1)[0];
  $("#pr-count").textContent = `${prs.length} personal bests set` + (recent ? ` · most recent: ${recent.label} on ${fmtDate(recent.date)}` : "");
}

function renderSuperlatives() {
  const A = Analytics;
  const sup = A.superlatives(state.runs);
  const big = A.biggestPeriods(state.runs);
  const EMO = { longest: "📏", time: "⏱️", climb: "⛰️", fast5: "⚡", fast10: "🚀", effort: "🔥", hot: "🥵", cold: "🥶", early: "🌅", late: "🌙" };
  const fmt = (x) => ({
    mi: `${num(x.raw, 1)} mi`, dur: fmtDur(x.raw), ft: `${num(x.raw)} ft`, pace: `${fmtPace(x.raw)}/mi`,
    num: num(x.raw), temp: `${Math.round(x.raw)}°F`,
    clock: `${((Math.floor(x.raw / 60) + 11) % 12) + 1}:${String(x.raw % 60).padStart(2, "0")} ${x.raw < 720 ? "am" : "pm"}`,
  }[x.fmt]);
  const cards = sup.map((x) => `<button class="sup" data-id="${x.id}">
    <span class="emoji">${EMO[x.key] || "🏅"}</span>
    <span class="sup-body"><span class="sup-title">${x.title}</span><span class="sup-val">${fmt(x)}</span>
    <span class="sup-sub">${escapeHtml(x.name || "")} · ${fmtDate(x.date)}</span></span></button>`);
  if (big.week) cards.push(`<div class="sup"><span class="emoji">📅</span><span class="sup-body"><span class="sup-title">Biggest week</span>
    <span class="sup-val">${num(big.week.miles, 1)} mi</span><span class="sup-sub">${big.week.runs} runs · week of ${fmtDate(big.week.start)}</span></span></div>`);
  if (big.month) cards.push(`<div class="sup"><span class="emoji">🗓️</span><span class="sup-body"><span class="sup-title">Biggest month</span>
    <span class="sup-val">${num(big.month.miles, 1)} mi</span><span class="sup-sub">${big.month.runs} runs · ${fmtDate(big.month.start)}</span></span></div>`);
  $("#superlatives").innerHTML = cards.join("");
  $("#superlatives").querySelectorAll("button.sup").forEach((b) => (b.onclick = () => openRun(b.dataset.id)));
}

function renderDistanceMix() {
  const runs = state.runs.filter((r) => r.distance_mi > 0);
  const max = Math.max(...runs.map((r) => r.distance_mi));
  const width = max > 16 ? 1 : 0.5;
  const nb = Math.ceil((max + 1e-9) / width);
  const x = Array.from({ length: nb }, (_, i) => (i + 0.5) * width);
  const traces = TYPE_ORDER.filter((t) => runs.some((r) => r.type === t)).map((t) => {
    const y = Array(nb).fill(0);
    runs.filter((r) => r.type === t).forEach((r) => y[Math.min(nb - 1, Math.floor(r.distance_mi / width))]++);
    return { type: "bar", name: t, x, y, marker: { color: TYPE_COLORS[t], line: { color: css("--bg-elev", "#171a21"), width: 1 } },
      customdata: x.map((c) => `${num(c - width / 2, 1)}–${num(c + width / 2, 1)} mi`),
      hovertemplate: `%{customdata}<br>%{y} ${t} runs<extra></extra>` };
  });
  plot("chart-disthist", traces, { barmode: "stack", bargap: 0.08, legend: { orientation: "h", y: 1.12, traceorder: "normal", font: { size: 11 } },
    xaxis: { title: "distance (mi)", gridcolor: GRID }, yaxis: { title: "runs", gridcolor: GRID } });
}

function renderPaceDistance() {
  const pts = state.points.filter((p) => p.pace_s != null && p.dist > 0);
  const traces = TYPE_ORDER.filter((t) => pts.some((p) => p.type === t)).map((t) => {
    const p = pts.filter((x) => x.type === t);
    return { type: "scatter", mode: "markers", name: t, x: p.map((x) => x.dist), y: p.map((x) => x.pace_s),
      marker: { color: TYPE_COLORS[t], symbol: TYPE_SYMBOLS[t], size: 8, opacity: 0.65, line: { color: css("--bg-elev", "#171a21"), width: 1 } },
      customdata: p.map((x) => x.id), text: p.map((x) => `${x.date} · ${x.dist} mi · ${fmtPace(x.pace_s)}/mi`),
      hovertemplate: `%{text}<extra>${t}</extra>` };
  });
  plot("chart-pacedist", traces, { xaxis: { title: "distance (mi)", gridcolor: GRID },
    yaxis: { title: "pace (/mi)", ...paceAxis(pts.map((p) => p.pace_s)) } }, true);
}

/* =================== Years tab =================== */
let yearsBuilt = false, yoyMetric = "miles", reviewYear = null;
function renderYears() {
  if (yearsBuilt) return;
  yearsBuilt = true;
  const years = [...new Set(state.runs.map((r) => r.date.slice(0, 4)))].sort().reverse();
  reviewYear = years[0];
  setupYoy();
  $("#year-controls").innerHTML = years.map((y) => `<button class="${y === reviewYear ? "active" : ""}" data-y="${y}">${y}</button>`).join("");
  $("#year-controls").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    reviewYear = b.dataset.y;
    $("#year-controls").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    renderYearReview();
  }));
  renderYearReview();
  renderMonthGrid();
}

function setupYoy() {
  const M = [["miles", "Miles"], ["hours", "Hours"], ["elev", "Climb"], ["runs", "Runs"]];
  const UNIT = { miles: "mi", hours: "h", elev: "ft", runs: "runs" };
  const DIG = { miles: 0, hours: 0, elev: 0, runs: 0 };
  const el = $("#yoy-controls");
  const draw = () => {
    el.innerHTML = M.map(([k, l]) => `<button class="${k === yoyMetric ? "active" : ""}" data-k="${k}">${l}</button>`).join("");
    el.querySelectorAll("button").forEach((b) => (b.onclick = () => { yoyMetric = b.dataset.k; draw(); }));
    const anchor = anchorDate();
    const series = Analytics.cumulativeByYear(state.runs, yoyMetric, anchor);
    const newest = [...series].reverse();
    const traces = [], ann = [];
    newest.forEach((s, i) => {
      const color = i < YEAR_COLORS.length ? YEAR_COLORS[i] : "#8b94a3";
      const faded = i >= YEAR_COLORS.length;
      traces.push({ type: "scatter", mode: "lines", name: s.year, x: s.x, y: s.y,
        line: { color, width: i === 0 ? 3.5 : 2, shape: "hv" }, opacity: faded ? 0.45 : 1,
        hovertemplate: `%{x|%b %d} · %{y:,.${DIG[yoyMetric]}f} ${UNIT[yoyMetric]}<extra>${s.year}</extra>` });
      // Direct label at each line's end (years are few, so all get one).
      ann.push({ x: s.x[s.x.length - 1], y: s.y[s.y.length - 1], text: `<b>${s.year}</b> ${num(s.total, DIG[yoyMetric])}`,
        showarrow: false, xanchor: "left", xshift: 6, font: { size: 11, color: HOVER_FG } });
    });
    plot("chart-yoy", traces.reverse(), {
      xaxis: { type: "date", tickformat: "%b", dtick: narrow() ? "M3" : "M1", tickangle: 0, range: ["2000-01-01", "2001-01-12"], gridcolor: GRID, hoverformat: "%b %d" },
      yaxis: { title: UNIT[yoyMetric], gridcolor: GRID, rangemode: "tozero" },
      margin: { l: narrow() ? 44 : 56, r: narrow() ? 70 : 90, t: 16, b: 40 }, annotations: ann, hovermode: "x unified", showlegend: false,
    });
    // Headline: this year vs. last year at the same point.
    const cur = series[series.length - 1], prev = series[series.length - 2];
    const md = fmtDate(anchor).replace(/, \d{4}$/, "");
    let msg = `<b>${cur.year}</b>: ${num(cur.total, DIG[yoyMetric])} ${UNIT[yoyMetric]} through ${md}`;
    if (prev) {
      const d = cur.atAnchor - prev.atAnchor;
      msg += ` — ${fmtDelta(d, DIG[yoyMetric], " " + UNIT[yoyMetric])} vs. ${prev.year} at this point (${num(prev.atAnchor, DIG[yoyMetric])})`;
      // Straight-line projection of the current year to Dec 31.
      const doy = Analytics.dayNum(anchor) - Analytics.dayNum(`${cur.year}-01-01`) + 1;
      if (cur.year === anchor.slice(0, 4) && doy < 360 && doy > 20) {
        const len = Analytics.dayNum(`${cur.year}-12-31`) - Analytics.dayNum(`${cur.year}-01-01`) + 1;
        msg += `. On pace for <b>${num((cur.total / doy) * len, DIG[yoyMetric])}</b> ${UNIT[yoyMetric]}.`;
      }
    }
    $("#yoy-headline").innerHTML = msg;
  };
  draw();
}

function renderYearReview() {
  const A = Analytics, y = reviewYear, anchor = anchorDate();
  const cur = A.yearSummary(state.runs, y);
  const partial = y === anchor.slice(0, 4);
  const prevYear = String(+y - 1);
  // For the in-progress year, compare against last year up to the same calendar day.
  const cut = `${prevYear}${anchor.slice(4, 10)}`;
  const prevRuns = partial ? state.runs.filter((r) => r.date.slice(0, 10) <= cut) : state.runs;
  const prev = A.yearSummary(prevRuns, prevYear);
  const hasPrev = prev.runs > 0;
  const vs = partial ? `vs. ${prevYear} by ${fmtDate(anchor).replace(/, \d{4}$/, "")}` : `vs. ${prevYear}`;

  const tile = (v, u, l, d, digits, du, invert) => `<div class="stat">
    <div class="val">${v}<span class="unit">${u}</span></div><div class="lbl">${l}</div>
    ${hasPrev && d != null ? `<div class="streak-sub">${invert ? fmtDelta(-d, digits, du).replace(/▲|▼/, (m) => (m === "▲" ? "▼" : "▲")) : fmtDelta(d, digits, du)}</div>` : ""}</div>`;
  $("#year-tiles").innerHTML = [
    tile(num(cur.miles, 0), "mi", "Distance", cur.miles - prev.miles, 0, " mi"),
    tile(num(cur.runs), "", "Runs", cur.runs - prev.runs, 0, ""),
    tile(num(cur.hours, 0), "h", "Time on feet", cur.hours - prev.hours, 0, " h"),
    tile(num(cur.elev), "ft", "Climbed", cur.elev - prev.elev, 0, " ft"),
    tile(fmtPace(cur.avgPace), "/mi", "Average pace",
      cur.avgPace && prev.avgPace ? cur.avgPace - prev.avgPace : null, 0, " s/mi", true),
    tile(num(cur.activeDays), "days", "Days you ran", cur.activeDays - prev.activeDays, 0, ""),
  ].join("");
  $("#year-vs").textContent = hasPrev ? `Changes are ${vs}.` : "";

  // A few sentences, Wrapped-style.
  const mar = cur.miles / 26.219;
  const lines = [];
  if (cur.runs) {
    lines.push(`You ran <b>${num(cur.miles, 0)} miles</b> in ${y}${partial ? " so far" : ""} — that's <b>${num(mar, 1)} marathons</b>.`);
    lines.push(`Your go-to day was <b>${cur.topDow}</b>${cur.topHour != null ? `, usually heading out around <b>${fmtHour(cur.topHour)}</b>` : ""}.`);
    lines.push(`Biggest month: <b>${cur.topMonth}</b> (${num(Math.max(...cur.byMonth), 0)} mi).`);
    if (cur.longest) lines.push(`Longest run: <a data-id="${cur.longest.id}">${escapeHtml(cur.longest.name)}</a>, ${num(cur.longest.distance_mi, 1)} mi on ${fmtDate(cur.longest.date)}.`);
    const recs = state.effortRecs || A.effortsByRun(state.points, state.summary.pr_progression);
    const prs = A.prTimeline(recs).filter((e) => !e.first && e.date.startsWith(y));
    if (prs.length) lines.push(`You set <b>${prs.length} personal best${prs.length === 1 ? "" : "s"}</b>: ${[...new Set(prs.map((e) => e.label))].join(", ")}.`);
  } else lines.push(`No runs logged in ${y}.`);
  $("#year-story").innerHTML = lines.map((l) => `<p>${l}</p>`).join("");
  $("#year-story").querySelectorAll("a[data-id]").forEach((a) => (a.onclick = () => openRun(a.dataset.id)));

  // Monthly miles, this year vs. last.
  const traces = [];
  if (hasPrev) {
    const full = A.yearSummary(state.runs, prevYear);
    traces.push({ type: "bar", name: prevYear, x: MONTHS, y: full.byMonth, marker: { color: "#4f93ff" }, opacity: 0.55,
      hovertemplate: `%{x} ${prevYear}<br>%{y:.1f} mi<extra></extra>` });
  }
  traces.push({ type: "bar", name: y, x: MONTHS, y: cur.byMonth, marker: { color: "#fc5200" },
    customdata: cur.runsByMonth, hovertemplate: `%{x} ${y}<br>%{y:.1f} mi · %{customdata} runs<extra></extra>` });
  plot("chart-year-months", traces, { barmode: "group", bargap: 0.25, bargroupgap: 0.08,
    xaxis: { gridcolor: GRID, tickangle: 0, ...(narrow() ? { tickvals: MONTHS, ticktext: MONTHS.map((m) => m[0]) } : {}) },
    yaxis: { title: "miles", gridcolor: GRID }, showlegend: traces.length > 1 });

  // Type mix donut + punch card for the selected year.
  const order = TYPE_ORDER.filter((t) => cur.byType[t]);
  Plotly.newPlot("chart-year-types", [{ type: "pie", hole: 0.62, labels: order, values: order.map((t) => cur.byType[t]),
    marker: { colors: order.map((t) => TYPE_COLORS[t]), line: { color: css("--bg-elev", "#171a21"), width: 2 } }, sort: false,
    textinfo: "label+percent", hovertemplate: "%{label}: %{value} runs<extra></extra>" }],
  { ...baseLayout(), margin: { l: 10, r: 10, t: 10, b: 10 }, showlegend: false,
    annotations: [{ text: `<b>${cur.runs}</b><br>runs`, showarrow: false, font: { size: 15, color: HOVER_FG } }] }, CONFIG);
  drawPunchCard(state.runs.filter((r) => r.date.startsWith(y)), "chart-year-punch");
}

function drawPunchCard(runs, id) {
  const m = Analytics.punchCard(runs);
  const hrs = Array.from({ length: 24 }, (_, h) => h);
  // Trim empty early/late hours so the grid focuses on when you actually run.
  const used = hrs.filter((h) => m.some((row) => row[h]));
  const lo = used.length ? Math.max(0, used[0] - 1) : 5, hi = used.length ? Math.min(23, used[used.length - 1] + 1) : 21;
  const cols = hrs.slice(lo, hi + 1);
  plot(id, [{
    type: "heatmap", x: cols.map(fmtHour), y: DOW_SHORT, z: m.map((row) => cols.map((h) => row[h] || null)),
    colorscale: seqScale(), showscale: false, xgap: 3, ygap: 3, hoverongaps: false,
    hovertemplate: "%{y} %{x}<br>%{z} runs<extra></extra>",
  }], { yaxis: { autorange: "reversed", gridcolor: "transparent", fixedrange: true },
    xaxis: { gridcolor: "transparent", fixedrange: true, title: "start time", tickangle: 0,
      ...(narrow() ? { tickvals: cols.filter((h) => h % 3 === 0).map(fmtHour) } : {}) }, margin: { l: 44, r: 12, t: 8, b: 40 } });
}

function renderMonthGrid() {
  const years = [...new Set(state.runs.map((r) => r.date.slice(0, 4)))].sort().reverse();
  const z = years.map(() => Array(12).fill(0)), n = years.map(() => Array(12).fill(0));
  state.runs.forEach((r) => {
    const yi = years.indexOf(r.date.slice(0, 4)), m = +r.date.slice(5, 7) - 1;
    z[yi][m] += r.distance_mi || 0; n[yi][m]++;
  });
  const first = state.summary.totals.first.slice(0, 7), last = anchorDate().slice(0, 7);
  // Months before the first run / after "now" are blank rather than zero.
  const zz = z.map((row, yi) => row.map((v, m) => {
    const k = `${years[yi]}-${String(m + 1).padStart(2, "0")}`;
    return k < first || k > last ? null : Math.round(v * 10) / 10;
  }));
  const max = Math.max(...zz.flat().filter((v) => v != null));
  plot("chart-monthgrid", [{
    type: "heatmap", x: MONTHS, y: years, z: zz, customdata: n, colorscale: seqScale(), zmin: 0, zmax: max,
    xgap: 3, ygap: 3, hoverongaps: false, showscale: false,
    text: zz.map((row) => row.map((v) => (v == null ? "" : num(v, 0)))), texttemplate: "%{text}",
    textfont: { size: 11, color: isLight() ? "#1b2430" : "#e7ecf3" },
    hovertemplate: "%{x} %{y}<br>%{z:.1f} mi · %{customdata} runs<extra></extra>",
  }], { yaxis: { type: "category", autorange: "reversed", gridcolor: "transparent", fixedrange: true },
    xaxis: { side: "top", gridcolor: "transparent", fixedrange: true, tickangle: 0,
      ...(narrow() ? { tickvals: MONTHS, ticktext: MONTHS.map((m) => m[0]) } : {}) }, margin: { l: 50, r: 12, t: 30, b: 10 },
    height: Math.max(140, 44 * years.length + 44) });
  $("#chart-monthgrid").style.height = `${Math.max(140, 44 * years.length + 44)}px`;
}
