/* IndexedDB cache for an in-browser build, so a dropped export persists across visits
 * and the dashboard can render without a server. Classic script (no module) — exposes
 * window.StravaStore for both import.html and app.js.
 */
(function () {
  const DB = "strava-stats", VER = 1;

  function open() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        if (!db.objectStoreNames.contains("streams")) db.createObjectStore("streams");
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  async function saveBuild(data) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(["meta", "streams"], "readwrite");
      tx.objectStore("meta").put(
        { summary: data.summary, runs: data.runs, routes: data.routes, segments: data.segments, builtAt: Date.now() },
        "dataset");
      const ss = tx.objectStore("streams");
      ss.clear();
      for (const id in data.streams) ss.put(data.streams[id], id);
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

  window.StravaStore = {
    saveBuild,
    loadBuild: () => read("meta", "dataset").catch(() => null),
    loadStream: (id) => read("streams", id).catch(() => null),
    clearBuild: () => open().then((db) => new Promise((res) => {
      const tx = db.transaction(["meta", "streams"], "readwrite");
      tx.objectStore("meta").clear();
      tx.objectStore("streams").clear();
      tx.oncomplete = () => res();
    })),
  };
})();
