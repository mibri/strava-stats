/* Track-parsing worker. Parses every run's track file off the main thread (FIT
 * decoding over hundreds of files is heavy) and returns the per-run artifacts the
 * pipeline needs: best efforts, mile splits, the compact chart/map stream, the
 * aligned trajectory (for segments), and the route polyline.
 *
 * Message in:  { jobs: [{ id, filename, bytes: Uint8Array }] }
 * Messages out: { type:"progress", done, total } … then { type:"done", streams, routes }
 */
import { loadTrack } from "./tracks.js";
import {
  bestEfforts, mileSplits, downsampleStream, buildTrajectory, aerobicDecoupling,
} from "./metrics.js";

self.onmessage = async (e) => {
  const { jobs } = e.data;
  const streams = {};
  const routes = [];
  const failures = [];
  let done = 0;

  for (const job of jobs) {
    try {
      const stream = await loadTrack(job.filename, job.bytes);
      if (stream.length) {
        const compact = downsampleStream(stream);
        streams[job.id] = {
          best_efforts: bestEfforts(stream),
          splits: mileSplits(stream),
          stream: compact,
          traj: buildTrajectory(stream), // internal: consumed by segment detection
          decoup: aerobicDecoupling(compact),
        };
        if (compact.latlng && compact.latlng.length) routes.push({ id: job.id, latlng: compact.latlng });
      } else {
        failures.push({ id: job.id, filename: job.filename, error: "empty stream" });
      }
    } catch (err) {
      // A single bad file shouldn't kill the build — skip it, keep going.
      failures.push({ id: job.id, filename: job.filename, error: err.message });
    }
    done++;
    if (done % 5 === 0 || done === jobs.length) {
      self.postMessage({ type: "progress", done, total: jobs.length });
    }
  }

  self.postMessage({ type: "done", streams, routes, failures });
};
