/* IndexedDB cache for an in-browser build, so a dropped export persists across visits
 * and the dashboard can render without a server. Classic script (no module) — exposes
 * window.StravaStore for both import.html and app.js.
 */
(function () {
  const DB = "strava-stats", VER = 2;
  // Bump when the built data SHAPE changes (e.g. per-run `traj` added for drawn segments)
  // so a stale cached build is ignored and the user is sent to re-import, rather than the
  // dashboard silently running on data that's missing fields.
  const BUILD_VERSION = 3;
  const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic" };
  const mime = (file) => MIME[(file.split(".").pop() || "").toLowerCase()] || "image/jpeg";

  function open() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        if (!db.objectStoreNames.contains("streams")) db.createObjectStore("streams");
        if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos");
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  async function saveBuild(data) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(["meta", "streams", "photos"], "readwrite");
      tx.objectStore("meta").put(
        { summary: data.summary, runs: data.runs, routes: data.routes, segments: data.segments,
          buildVersion: BUILD_VERSION, builtAt: Date.now() },
        "dataset");
      const ss = tx.objectStore("streams");
      ss.clear();
      for (const id in data.streams) ss.put(data.streams[id], id);
      // Photo bytes from the export's media/ folder, keyed by their "media/<file>" path.
      // Tag each Blob with its MIME type — an <img> won't render a typeless blob URL.
      const ps = tx.objectStore("photos");
      ps.clear();
      for (const file in (data.photos || {})) ps.put(new Blob([data.photos[file]], { type: mime(file) }), file);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  function read(store, key) {
    return open().then((db) => new Promise((res, rej) => {
      const req = db.transaction(store).objectStore(store).get(key);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => rej(req.error);
    }));
  }

  // All photos as a { "media/<file>": Blob } map (20 MB-ish; fine to load at once).
  function loadAllPhotos() {
    return open().then((db) => new Promise((res) => {
      const out = {};
      const req = db.transaction("photos").objectStore("photos").openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); };
      req.onerror = () => res(out);
    })).catch(() => ({}));
  }

  window.StravaStore = {
    saveBuild,
    // Ignore a cached build from an older schema so the dashboard never renders on data
    // missing fields the current code expects — falls through to a fresh import.
    loadBuild: () => read("meta", "dataset").then((d) => (d && d.buildVersion === BUILD_VERSION ? d : null)).catch(() => null),
    loadStream: (id) => read("streams", id).catch(() => null),
    loadAllPhotos,
    clearBuild: () => open().then((db) => new Promise((res) => {
      const tx = db.transaction(["meta", "streams", "photos"], "readwrite");
      tx.objectStore("meta").clear();
      tx.objectStore("streams").clear();
      tx.objectStore("photos").clear();
      tx.oncomplete = () => res();
    })),
  };
})();
