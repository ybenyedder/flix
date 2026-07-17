// One-time library bootstrap. The first time the API is touched on a fresh
// data directory, kick off a background scan so the app fills itself without
// requiring the user to press anything.

import { getDb } from "./db";
import { runScan, getScanProgress } from "./library/scanner";

let kicked = false;

export function ensureLibraryReady(): void {
  if (kicked) return;
  kicked = true;
  // A crash (or a `kill -9` that skips db.ts's graceful-shutdown hook) can leave
  // stale ffmpeg HLS session directories behind. Nothing references them once
  // the process that made them is gone, so wipe the whole scratch dir once per
  // boot — dynamically imported to keep this module free of a hard dependency
  // on the playback subsystem. Goes through the memoised ensureBootPurge (not
  // purgeTranscodeDir directly) so this can never race a session that a
  // concurrent POST /api/play/session already started creating.
  void import("./playback/sessions").then((m) => m.ensureBootPurge()).catch(() => {});
  // Same idea for trickplay: reap `.tmp-<pid>` sprite temps orphaned by a crash
  // mid-generation. runTrickplayPass sweeps at its head too, but that only runs
  // on a scan — this covers a boot where the library is already populated.
  void import("./library/trickplay").then((m) => m.purgeTrickplayTemps()).catch(() => {});
  // Automatic-rescan watcher: reads the persisted `library.autoScan` toggle
  // (default ON) and starts watching the media directory when enabled. Same
  // dynamic-import/best-effort posture as the purge above — a watcher problem
  // must never block or crash a request.
  void import("./library/watcher").then((m) => m.initWatcher()).catch(() => {});
  // Reap abandoned chunked-upload sessions (`.part` + sidecar under
  // <mediaDir>/.flix-uploads) left by a browser that never finalized. Same
  // dynamic-import/best-effort posture — a cleanup problem must never block or
  // crash a request.
  void import("./upload/manager").then((m) => m.cleanupStaleUploads()).catch(() => {});
  // Opt-in *arr integration: consume the launch-time answer once and revive the
  // request poller if the feature is on and downloads were in flight. Same
  // dynamic-import/best-effort posture — dormant and harmless when disabled.
  void import("./arr/config").then((m) => m.initArr()).catch(() => {});
  try {
    const db = getDb();
    const movies = (db.prepare("SELECT COUNT(*) AS n FROM movies").get() as { n: number }).n;
    const episodes = (db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n;
    const scannedAt = db.prepare("SELECT value FROM settings WHERE key = 'scannedAt'").get();
    if (movies === 0 && episodes === 0 && !scannedAt && getScanProgress().status !== "scanning") {
      void runScan();
    }
  } catch {
    // never block the request on bootstrap problems
  }
}
