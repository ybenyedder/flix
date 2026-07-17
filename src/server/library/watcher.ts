// Automatic library rescan: watches the media directory with
// fs.watch(recursive) and triggers the existing incremental scan ~30 s after
// the LAST filesystem event (a torrent/copy in progress emits a storm of
// events — the debounce collapses it into one scan once the tree settles).
//
// Everything here is best-effort by design: a watcher error must never crash
// the server, and a platform without recursive fs.watch simply degrades to
// manual scans (logged as a warning). The on/off toggle persists in the
// `settings` table (key `library.autoScan`, default ON) and is flipped hot by
// the admin settings route — no restart needed.

import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import { getDb } from "../db";
import { createLogger } from "../logger";
import { runScan, getScanProgress, subscribeScan } from "./scanner";

const log = createLogger("watcher");

export const AUTO_SCAN_KEY = "library.autoScan";
const DEBOUNCE_MS = 30_000;

// --- pure helpers (unit tested) ---------------------------------------------

// Files a watcher event must never wake a scan for: hidden files/dirs (the
// scanner skips dot-entries anyway), SQLite databases and their WAL/SHM
// side-files, and the usual in-flight download / temp suffixes whose final
// rename will fire its own event.
const IGNORED_EXTENSIONS = new Set([".db", ".db-wal", ".db-shm", ".sqlite", ".tmp", ".part", ".crdownload", ".log"]);

/** Whether a watch event's relative path should be ignored. A null filename
 *  (the platform couldn't tell us which file changed) is NOT ignored — missing
 *  a real change is worse than one extra debounced incremental scan. */
export function isIgnoredEvent(filename: string | null): boolean {
  if (!filename) return false;
  const segments = filename.split(/[\\/]/).filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) return true;
  const last = segments[segments.length - 1] ?? "";
  return IGNORED_EXTENSIONS.has(path.extname(last).toLowerCase());
}

export interface Debounced {
  /** (Re)arm the timer — `fn` fires `delayMs` after the LAST bump. */
  bump: () => void;
  cancel: () => void;
  pending: () => boolean;
}

/** Trailing-edge debounce. Extracted pure(-ish) so the timing contract is unit
 *  tested without touching the filesystem. The timer is unref'd: a pending
 *  debounce must never hold the process open on shutdown. */
export function createDebounce(delayMs: number, fn: () => void): Debounced {
  let timer: NodeJS.Timeout | null = null;
  return {
    bump() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, delayMs);
      timer.unref?.();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    pending() {
      return timer !== null;
    },
  };
}

// --- persisted toggle ---------------------------------------------------------

/** Read the persisted toggle — default ON when the key was never written. */
export function getAutoScan(): boolean {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(AUTO_SCAN_KEY) as { value: string | null } | undefined;
    if (!row || row.value === null) return true;
    return row.value !== "0";
  } catch {
    return true;
  }
}

/** Persist the toggle and apply it hot (start/stop the watcher immediately). */
export function setAutoScan(enabled: boolean): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(AUTO_SCAN_KEY, enabled ? "1" : "0");
  syncWatcher();
}

// --- watcher lifecycle ---------------------------------------------------------

let watcher: fs.FSWatcher | null = null;
let watchedDir: string | null = null;
let scanSubscribed = false;

const debounce = createDebounce(DEBOUNCE_MS, () => {
  try {
    // A scan already in flight would make runScan() a silent no-op and the
    // change that woke us could be missed — re-arm and try again later.
    if (getScanProgress().status === "scanning") {
      debounce.bump();
      return;
    }
    log.info("filesystem changes settled — triggering incremental scan", { dir: watchedDir });
    void runScan();
  } catch (error) {
    log.warn("auto-scan trigger failed", { message: error instanceof Error ? error.message : String(error) });
  }
});

export function stopWatcher(): void {
  debounce.cancel();
  // Forget the last root seen on the scan channel: a stopped watcher (fs.watch
  // error like inotify ENOSPC, unmounted dir, toggle) must be re-armable by
  // the NEXT scan even when it reports the same root — otherwise the scan
  // subscription's root-changed check would skip syncWatcher forever.
  lastScanRoot = null;
  if (!watcher) return;
  try {
    watcher.close();
  } catch {
    /* best effort */
  }
  watcher = null;
  watchedDir = null;
}

function startWatcher(dir: string): void {
  stopWatcher();
  try {
    // Linux (Node >= 20) supports recursive fs.watch; a platform that doesn't
    // throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM here and we degrade cleanly.
    const w = fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (isIgnoredEvent(typeof filename === "string" ? filename : null)) return;
      debounce.bump();
    });
    // An errored watcher (deleted/unmounted directory) is dead — close it so
    // the admin settings route reports it inactive instead of pretending.
    w.on("error", (error) => {
      log.warn("library watcher stopped on error — auto-scan disabled until the next scan re-arms it", {
        dir,
        message: error instanceof Error ? error.message : String(error),
      });
      stopWatcher();
    });
    // Like the debounce timer: watching must never hold the process open
    // (graceful shutdown, tests) — events still fire while the process lives.
    w.unref?.();
    watcher = w;
    watchedDir = dir;
    log.info("watching media directory for changes", { dir });
  } catch (error) {
    watcher = null;
    watchedDir = null;
    log.warn("recursive fs.watch unavailable — automatic rescan disabled", {
      dir,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// Repointing the library (/api/library/source) resets the config cache and
// immediately runs a scan on the new root. That scan's progress carries the
// new root, so following the scan channel is enough to re-home the watcher
// without touching the (frozen) source route. Keyed on the last root seen —
// NOT on the live watcher — so a repoint also revives a watcher that never
// started (media dir missing at boot), and the per-emit work stays a string
// compare.
let lastScanRoot: string | null = null;

function ensureScanSubscription(): void {
  if (scanSubscribed) return;
  scanSubscribed = true;
  subscribeScan((snapshot) => {
    if (!snapshot.root || snapshot.root === lastScanRoot) return;
    lastScanRoot = snapshot.root;
    try {
      syncWatcher();
    } catch {
      /* best effort */
    }
  });
}

/** Reconcile the watcher with the persisted toggle and the current media
 *  directory. Idempotent — safe to call from the toggle route, the scan
 *  subscription and boot alike. */
export function syncWatcher(): void {
  ensureScanSubscription();
  if (!getAutoScan()) {
    stopWatcher();
    return;
  }
  const { mediaDir } = getConfig();
  if (watcher && watchedDir === mediaDir) return;
  if (!fs.existsSync(mediaDir)) {
    // Nothing to watch (yet) — a later repoint re-syncs via the scan channel.
    stopWatcher();
    log.warn("media directory missing — automatic rescan idle", { dir: mediaDir });
    return;
  }
  startWatcher(mediaDir);
}

export interface WatcherStatus {
  autoScan: boolean;
  active: boolean;
  dir: string | null;
}

export function getWatcherStatus(): WatcherStatus {
  return { autoScan: getAutoScan(), active: watcher !== null, dir: watchedDir };
}

/** Boot hook (see bootstrap.ts) — never throws. */
export function initWatcher(): void {
  try {
    syncWatcher();
  } catch (error) {
    log.warn("watcher init failed", { message: error instanceof Error ? error.message : String(error) });
  }
}
