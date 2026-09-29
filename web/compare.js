/* Compare two runs (docs/design/compare-runs.md): stat strip with deltas, a cumulative
 * time-gap chart, pace / HR / elevation overlays on a shared distance (or time) axis,
 * side-by-side mile splits, and both routes on one map with hover-synced markers.
 * Also the "compare with…" picker, which ranks candidates by route overlap.
 * Loaded before app.js; uses its helpers (plot, loadStream, state…) at call time. */

const CMP_A = "#fc5200", CMP_B = "#9b6bff";
let cmpMap = null, cmpMode = "distance";

const runById = (id) => state.runs.find((r) => r.id === id);
const routeCoords = (id) => {
  if (!state.routes) return null;
  state.routeIdx ||= Object.fromEntries(state.routes.features.map((f) => [f.properties.id, f.geometry.coordinates]));
  return state.routeIdx[id] || null;
};
const shortDate = (r) => fmtDate(r.date);

/* ---------- picker ---------- */
function renderComparePicker(anchorId) {
  const a = runById(anchorId);
  if (!a) return;
  const ca = routeCoords(anchorId);
  // Cheap bbox prefilter, then route overlap on the (already loaded) map geometry.
  const bbox = (c) => c.reduce((b, [lo, la]) => [Math.min(b[0], lo), Math.min(b[1], la), Math.max(b[2], lo), Math.max(b[3], la)], [180, 90, -180, -90]);
  const ba = ca && bbox(ca);
  const scored = state.runs.filter((r) => r.id !== anchorId).map((r) => {
    let sim = null;
    const cb = ca && routeCoords(r.id);
    if (cb) {
      const bb = bbox(cb);
      const overlap = !(bb[2] < ba[0] || bb[0] > ba[2] || bb[3] < ba[1] || bb[1] > ba[3]);
      sim = overlap ? Analytics.routeSimilarity(ca, cb, 40) : 0;
    }
    const dd = Math.abs((r.distance_mi || 0) - (a.distance_mi || 0)) / Math.max(1, a.distance_mi || 1);
    // Same-route runs first (by overlap), then by how close the distance is; same type is a tiebreak.
    const score = (sim || 0) * 2 - dd + (r.type === a.type ? 0.15 : 0);
    return { r, sim, dd, score };
  }).sort((x, y) => y.score - x.score);

  state.openRunId = null;
  $("#modal-box").classList.remove("wide");
  $("#modal-body").innerHTML = `
    <h2>Compare with…</h2>
    <p class="sub"><span class="cmp-dot" style="background:${CMP_A}"></span>${escapeHtml(a.name)} · ${shortDate(a)} · ${a.distance_mi.toFixed(2)} mi · ${fmtPace(a.pace_s)}/mi</p>
    <input id="cmp-search" class="cmp-search" type="search" placeholder="Search by name, date (2026-05), or type…" autocomplete="off" />
    <p class="hint" style="margin:10px 0 8px">Best matches first — runs on the same route, then similar distance.</p>
    <div id="cmp-list" class="cmp-list"></div>
    <p class="hint" style="margin-top:10px"><a class="link" id="cmp-back">← back to ${escapeHtml(a.name)}</a></p>`;
  const draw = () => {
    const q = $("#cmp-search").value.trim().toLowerCase();
    const rows = (q ? scored.filter(({ r }) => `${r.name} ${r.date} ${r.type} ${r.description || ""}`.toLowerCase().includes(q)) : scored).slice(0, 40);
    $("#cmp-list").innerHTML = rows.map(({ r, sim }) => `<button class="cmp-row" data-id="${r.id}">
      <span class="cmp-row-main"><b>${escapeHtml(r.name)}</b><span class="muted">${shortDate(r)} · <span class="pill ${r.type}">${r.type}</span></span></span>
      <span class="cmp-row-num">${r.distance_mi.toFixed(2)} mi</span>
      <span class="cmp-row-num">${fmtPace(r.pace_s)}/mi</span>
      <span class="cmp-sim">${sim != null && sim >= 0.5 ? `<span class="badge">${sim >= 0.85 ? "same route" : "overlaps"} ${Math.round(sim * 100)}%</span>` : ""}</span>
    </button>`).join("") || `<p class="muted">No runs match.</p>`;
    $("#cmp-list").querySelectorAll(".cmp-row").forEach((b) => (b.onclick = () => openCompare(anchorId, b.dataset.id)));
  };
  $("#cmp-search").oninput = draw;
  $("#cmp-back").onclick = () => openRun(anchorId);
  draw();
  setTimeout(() => $("#cmp-search") && $("#cmp-search").focus(), 50);
}

/* ---------- compare view ---------- */
async function renderCompare(idA, idB) {
  const a = runById(idA), b = runById(idB);
  if (!a || !b) return;
  // Oldest first reads naturally ("then" vs "now").
  let [ra, rb] = a.date <= b.date ? [a, b] : [b, a];
  const token = (state.cmpToken = (state.cmpToken || 0) + 1);
  const [da, db] = await Promise.all([loadStream(ra.id), loadStream(rb.id)]);
  if (token !== state.cmpToken || !location.hash.startsWith("#compare/")) return;
  const sa = (da && da.stream) || {}, sb = (db && db.stream) || {};
  const canDist = sa.dist_mi && sb.dist_mi;
  if (!canDist) cmpMode = "time";
  const sim = routeCoords(ra.id) && routeCoords(rb.id) ? Analytics.routeSimilarity(routeCoords(ra.id), routeCoords(rb.id), 40) : null;

  const row = (label, va, vb, fmt, better) => {
    let delta = "";
    if (va != null && vb != null && isFinite(va) && isFinite(vb)) {
      const d = vb - va;
      const good = better === "lower" ? d < 0 : better === "higher" ? d > 0 : null;
      const cls = !better || Math.abs(d) < 1e-9 ? "flat" : good ? "up" : "down";
      delta = `<span class="delta ${cls}">${d > 0 ? "+" : d < 0 ? "−" : "±"}${fmt(Math.abs(d))}</span>`;
    }
    return `<tr><th>${label}</th><td>${va != null ? fmt(va) : "—"}</td><td>${vb != null ? fmt(vb) : "—"}</td><td>${delta}</td></tr>`;
  };
  const f1 = (v) => v.toFixed(2), fi = (v) => num(v), fd = (v) => fmtDur(v), fp = (v) => fmtPace(v);
  const ef = (r) => (r.ef != null ? r.ef * 1000 : null);

  $("#modal-box").classList.add("wide");
  $("#modal-body").innerHTML = `
    <h2>Run vs. run</h2>
    <div class="cmp-heads">
      ${[ra, rb].map((r, i) => `<a class="cmp-head" data-id="${r.id}" style="--c:${i ? CMP_B : CMP_A}">
        <span class="cmp-tag">${i ? "B" : "A"}</span><span><b>${escapeHtml(r.name)}</b><br><span class="muted">${r.date} · <span class="pill ${r.type}">${r.type}</span></span></span></a>`).join("")}
    </div>
    ${sim != null ? `<p class="sub">${sim >= 0.85 ? "🔁 Same route" : sim >= 0.5 ? "↔ Partly the same route" : "🗺️ Different routes"} · ${Math.round(sim * 100)}% overlap
      <button class="link-btn" id="cmp-swap" title="Pick a different run to compare with">change B</button></p>` : ""}
    <div class="table-wrap"><table class="cmp-table">
      <thead><tr><th></th><th style="color:${CMP_A}">A</th><th style="color:${CMP_B}">B</th><th>B − A</th></tr></thead>
      <tbody>
        ${row("Distance", ra.distance_mi, rb.distance_mi, (v) => `${f1(v)} mi`, "higher")}
        ${row("Moving time", ra.moving_s, rb.moving_s, fd)}
        ${row("Pace", ra.pace_s, rb.pace_s, (v) => `${fp(v)}/mi`, "lower")}
        ${row("Grade-adj. pace", ra.gap_pace_s, rb.gap_pace_s, (v) => `${fp(v)}/mi`, "lower")}
        ${row("Avg heart rate", ra.avg_hr, rb.avg_hr, (v) => `${fi(v)} bpm`, "lower")}
        ${row("Efficiency (EF)", ef(ra), ef(rb), (v) => v.toFixed(2), "higher")}
        ${row("Cadence", ra.cadence, rb.cadence, (v) => `${fi(v)} spm`)}
        ${row("Climb", ra.elev_gain_ft, rb.elev_gain_ft, (v) => `${fi(v)} ft`)}
        ${row("Effort", ra.rel_effort, rb.rel_effort, fi)}
      </tbody></table></div>
    <div class="cmp-toolbar">
      <div class="pr-controls" id="cmp-mode" style="margin:0">
        <button data-m="distance" ${canDist ? "" : "disabled"}>By distance</button><button data-m="time">By time</button>
      </div>
      <span class="hint" style="margin:0" id="cmp-note"></span>
    </div>
    <div class="card cmp-card"><h3 id="cmp-gap-title">Time gap</h3><p class="hint" id="cmp-gap-hint"></p><div id="cmp-gap" style="height:220px"></div></div>
    <div class="card cmp-card"><h3>Pace</h3><div id="cmp-pace" style="height:200px"></div></div>
    <div class="card cmp-card" id="cmp-hr-card"><h3>Heart rate</h3><div id="cmp-hr" style="height:180px"></div></div>
    <div class="card cmp-card" id="cmp-elev-card"><h3>Elevation</h3><div id="cmp-elev" style="height:160px"></div></div>
    <div id="cmp-map" class="detail-map"></div>
    <div id="cmp-splits"></div>`;
  state.openRunId = null;
  showModal();
  $("#modal-box").scrollTop = 0;
  $("#modal-body").querySelectorAll(".cmp-head").forEach((h) => (h.onclick = () => openRun(h.dataset.id)));
  if ($("#cmp-swap")) $("#cmp-swap").onclick = () => renderComparePicker(ra.id);

  // Map: both routes + hover markers.
  const markers = {};
  setTimeout(() => {
    if (cmpMap) { cmpMap.remove(); cmpMap = null; }
    const lines = [];
    cmpMap = L.map("cmp-map");
    addBasemap(cmpMap);
    [[sa, CMP_A, "a"], [sb, CMP_B, "b"]].forEach(([s, c, k]) => {
      if (s.latlng && s.latlng.length) {
        lines.push(L.polyline(s.latlng, { color: c, weight: k === "a" ? 6 : 3.5, opacity: k === "a" ? 0.55 : 0.95 }).addTo(cmpMap));
        markers[k] = L.circleMarker(s.latlng[0], { radius: 7, color: "#0b0d11", weight: 2, fillColor: c, fillOpacity: 1 });
      }
    });
    if (lines.length) cmpMap.fitBounds(L.featureGroup(lines).getBounds(), { padding: [20, 20] });
    else { cmpMap.remove(); cmpMap = null; $("#cmp-map").innerHTML = `<div class="muted" style="padding:40px;text-align:center">No GPS tracks</div>`; }
  }, 60);

  // Position along a run at a given distance (or time): nearest display-stream sample.
  const locate = (s, x, key) => {
    const xs = s[key];
    if (!xs || !s.latlng || s.latlng.length !== xs.length) return null;
    let lo = 0, hi = xs.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid + 1; else hi = mid; }
    return s.latlng[lo];
  };
  const onHover = (x) => {
    if (!cmpMap) return;
    const key = cmpMode === "time" ? "t" : "dist_mi";
    [["a", sa], ["b", sb]].forEach(([k, s]) => {
      const ll = markers[k] && locate(s, x, key);
      if (ll) { markers[k].setLatLng(ll); if (!cmpMap.hasLayer(markers[k])) markers[k].addTo(cmpMap); }
    });
  };

  const draw = () => {
    $("#cmp-mode").querySelectorAll("button").forEach((btn) => btn.classList.toggle("active", btn.dataset.m === cmpMode));
    const al = Analytics.alignRuns(sa, sb, cmpMode);
    const byTime = al.mode === "time";
    const xs = byTime ? al.grid.map((s) => s / 60) : al.grid;
    const xTitle = byTime ? "moving time (min)" : "distance (mi)";
    const longer = Math.max(ra.distance_mi, rb.distance_mi), shorter = Math.min(ra.distance_mi, rb.distance_mi);
    $("#cmp-note").textContent = !byTime && longer - shorter > 0.2 ? `Overlays cover the first ${num(xs[xs.length - 1], 1)} mi (the shorter run).` : "";

    // Gap: split by sign so the fill takes the color of whoever is ahead.
    const g = al.gap;
    const fmtGap = (v) => (byTime ? `${num(Math.abs(v), 2)} mi` : fmtDur(Math.abs(v)));
    $("#cmp-gap-title").textContent = byTime ? "Distance gap" : "Time gap";
    $("#cmp-gap-hint").innerHTML = byTime
      ? `How far apart you'd be at the same moment. Above zero: <b style="color:${CMP_A}">A</b> is ahead.`
      : `Where the time was won or lost, at equal distance. Above zero: <b style="color:${CMP_A}">A</b> is ahead; below: <b style="color:${CMP_B}">B</b> is.`;
    const endGap = g.filter((v) => v != null).slice(-1)[0];
    const lead = endGap == null ? "" : endGap > 0 ? `A ahead by ${fmtGap(endGap)}` : endGap < 0 ? `B ahead by ${fmtGap(endGap)}` : "dead even";
    const text = g.map((v) => (v == null ? "" : v > 0 ? `A ahead by ${fmtGap(v)}` : v < 0 ? `B ahead by ${fmtGap(v)}` : "even"));
    const common = { margin: { l: 56, r: 16, t: 6, b: 36 }, xaxis: { title: xTitle, gridcolor: GRID }, hovermode: "x unified", showlegend: false };
    plot("cmp-gap", [
      { type: "scatter", mode: "lines", x: xs, y: g.map((v) => (v != null && v > 0 ? v : 0)), fill: "tozeroy",
        line: { color: CMP_A, width: 0 }, fillcolor: CMP_A + "55", hoverinfo: "skip" },
      { type: "scatter", mode: "lines", x: xs, y: g.map((v) => (v != null && v < 0 ? v : 0)), fill: "tozeroy",
        line: { color: CMP_B, width: 0 }, fillcolor: CMP_B + "55", hoverinfo: "skip" },
      { type: "scatter", mode: "lines", x: xs, y: g, line: { color: HOVER_FG, width: 2 }, text, hovertemplate: "%{text}<extra></extra>" },
    ], { ...common, yaxis: { title: byTime ? "miles" : "seconds", gridcolor: GRID, zeroline: true, zerolinecolor: css("--muted", "#8b94a3") },
      annotations: lead ? [{ xref: "paper", yref: "paper", x: 1, y: 1, xanchor: "right", yanchor: "top", showarrow: false,
        text: `<b>finish of overlap:</b> ${lead}`, font: { size: 12, color: HOVER_FG } }] : [] });

    const pair = (k, sA, sB) => [
      { type: "scatter", mode: "lines", name: "A", x: xs, y: sA, line: { color: CMP_A, width: 2 }, connectgaps: true,
        hovertemplate: k === "pace" ? "A %{customdata}<extra></extra>" : `A %{y:.0f}<extra></extra>`, customdata: sA && sA.map(fmtPace) },
      { type: "scatter", mode: "lines", name: "B", x: xs, y: sB, line: { color: CMP_B, width: 2 }, connectgaps: true,
        hovertemplate: k === "pace" ? "B %{customdata}<extra></extra>" : `B %{y:.0f}<extra></extra>`, customdata: sB && sB.map(fmtPace) },
    ];
    if (al.a.pace_s && al.b.pace_s) {
      plot("cmp-pace", pair("pace", al.a.pace_s, al.b.pace_s), { ...common,
        yaxis: { ...paceAxis([...al.a.pace_s, ...al.b.pace_s]) } });
    }
    if (al.a.hr && al.b.hr && al.a.hr.some((v) => v != null) && al.b.hr.some((v) => v != null)) {
      $("#cmp-hr-card").style.display = "";
      plot("cmp-hr", pair("hr", al.a.hr, al.b.hr), { ...common, yaxis: { title: "bpm", gridcolor: GRID } });
    } else $("#cmp-hr-card").style.display = "none";
    if (al.a.elev_ft && al.b.elev_ft) {
      plot("cmp-elev", [
        { type: "scatter", mode: "lines", x: xs, y: al.a.elev_ft, fill: "tozeroy", fillcolor: CMP_A + "22", line: { color: CMP_A, width: 1.5 }, hovertemplate: "A %{y:.0f} ft<extra></extra>" },
        { type: "scatter", mode: "lines", x: xs, y: al.b.elev_ft, line: { color: CMP_B, width: 2 }, hovertemplate: "B %{y:.0f} ft<extra></extra>" },
      ], { ...common, yaxis: { title: "ft", gridcolor: GRID } });
    } else $("#cmp-elev-card").style.display = "none";

    ["cmp-gap", "cmp-pace", "cmp-hr", "cmp-elev"].forEach((id) => {
      const gd = document.getElementById(id);
      if (gd && gd.on && !gd._cmpHover) { gd._cmpHover = true; gd.on("plotly_hover", (ev) => onHover(byTimeNow() ? ev.points[0].x * 60 : ev.points[0].x)); }
    });
  };
  const byTimeNow = () => cmpMode === "time";
  $("#cmp-mode").querySelectorAll("button").forEach((btn) => (btn.onclick = () => { if (!btn.disabled) { cmpMode = btn.dataset.m; draw(); } }));
  draw();

  // Splits side by side.
  const spA = (da && da.splits) || [], spB = (db && db.splits) || [];
  const n = Math.max(spA.length, spB.length);
  if (n) {
    let rows = "";
    for (let i = 0; i < n; i++) {
      const x = spA[i], y = spB[i];
      const d = x && y && x.pace_s && y.pace_s ? y.pace_s - x.pace_s : null;
      rows += `<tr class="${x && y ? "" : "muted"}"><td>${i + 1}</td>
        <td class="num" style="color:${CMP_A}">${x ? fmtPace(x.pace_s) : "—"}</td><td class="num" style="color:${CMP_B}">${y ? fmtPace(y.pace_s) : "—"}</td>
        <td class="num">${d == null ? "" : `<span class="delta ${Math.abs(d) < 0.5 ? "flat" : d < 0 ? "up" : "down"}">${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.round(Math.abs(d))}s</span>`}</td>
        <td class="num">${x && x.hr ? Math.round(x.hr) : "—"}</td><td class="num">${y && y.hr ? Math.round(y.hr) : "—"}</td></tr>`;
    }
    $("#cmp-splits").innerHTML = `<div class="card cmp-card"><h3>Mile splits</h3><p class="hint">Δ is B − A: negative (green) means B ran that mile faster.</p>
      <div class="table-wrap"><table><thead><tr><th>Mile</th><th class="num">Pace A</th><th class="num">Pace B</th><th class="num">Δ</th><th class="num">HR A</th><th class="num">HR B</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
  }
}
