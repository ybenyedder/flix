// Incremental library scanner. Walks the media directory, classifies each
// video as a movie or an episode from its path, upserts into SQLite in
// batched transactions, probes new/changed files with ffprobe, re-reads NFO
// files that changed since the last scan, prunes deleted files/orphans, then
// rebuilds the FTS5 search index for whatever it touched. Emits live progress
// consumed by the scan SSE endpoint (src/app/api/library/events/route.ts).
//
// This file is the orchestrator: it owns the shared scan state (the live
// `progress` snapshot, the SSE subscriber set, and the single-flight `scanning`
// flag) and drives the phases in order. Each cohesive phase lives in its own
// module under ./scan/ (walk, upsert, probePass, nfoPass, prune, fts, cacheGc)
// and receives everything it needs — db, mediaDir, the per-scan caches, and
// (for the probe pass) the `emit` callback — as explicit parameters.

import fs from "fs";
import type { Database as DB } from "better-sqlite3";
import { getConfig } from "../config";
import { getDb } from "../db";
import { createLogger } from "../logger";
import { walk, type WalkedVideo } from "./scan/walk";
import { newCaches } from "./scan/caches";
import { processChangedBatch, refreshUnchangedSidecars } from "./scan/upsert";
import { runProbePass } from "./scan/probePass";
import { runNfoPass } from "./scan/nfoPass";
import { pruneMissingFiles } from "./scan/prune";
import { reindexFts } from "./scan/fts";
import { runCacheGc } from "./scan/cacheGc";

const log = createLogger("scanner");

const WRITE_BATCH = 200; // changed files per upsert transaction

export type ScanStatus = "idle" | "scanning" | "ready" | "error";

export interface ScanProgress {
  status: ScanStatus;
  phase: string;
  processed: number;
  total: number;
  added: number;
  updated: number;
  removed: number;
  probed: number;
  probeTotal: number;
  // Background image pass (Phase 3) — runs AFTER the scan reports "ready", so
  // it never touches `status`/`phase` above; it just layers its own progress
  // onto the same SSE channel while the last scan's result stays visible.
  imaging: boolean;
  imaged: number;
  imageTotal: number;
  startedAt: number | null;
  finishedAt: number | null;
  scannedAt: string | null;
  root: string;
  error: string | null;
}

const progress: ScanProgress = {
  status: "idle",
  phase: "idle",
  processed: 0,
  total: 0,
  added: 0,
  updated: 0,
  removed: 0,
  probed: 0,
  probeTotal: 0,
  imaging: false,
  imaged: 0,
  imageTotal: 0,
  startedAt: null,
  finishedAt: null,
  scannedAt: null,
  root: "",
  error: null,
};

type Listener = (snapshot: ScanProgress) => void;
const listeners = new Set<Listener>();

export function getScanProgress(): ScanProgress {
  return { ...progress };
}

export function subscribeScan(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(patch: Partial<ScanProgress>) {
  Object.assign(progress, patch);
  const snapshot = { ...progress };
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // a broken listener must not break the scan
    }
  }
}

/** Exposed for the background image pass (Phase 3) to report through the same channel. */
export function updateScanProgress(patch: Partial<ScanProgress>) {
  emit(patch);
}

function writeMeta(db: DB, scannedAt: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES ('scannedAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(scannedAt);
}

// --- orchestration ----------------------------------------------------------

let scanning = false;

export async function runScan(): Promise<ScanProgress> {
  if (scanning) return getScanProgress();

  try {
    // Latch INSIDE the try (not before it) so a throw during setup —
    // getConfig()/getDb() — is still covered by the finally that clears the
    // flag. Set before the try, a failed setup would leave `scanning` stuck true
    // and wedge every future auto/manual scan until a process restart.
    scanning = true;

    const { mediaDir } = getConfig();
    const db = getDb();
    const now = Date.now();

    emit({
      status: "scanning",
      phase: "walking",
      processed: 0,
      total: 0,
      added: 0,
      updated: 0,
      removed: 0,
      probed: 0,
      probeTotal: 0,
      imaging: false,
      imaged: 0,
      imageTotal: 0,
      startedAt: now,
      finishedAt: null,
      root: mediaDir,
      error: null,
    });

    if (!fs.existsSync(mediaDir)) {
      const scannedAt = new Date().toISOString();
      emit({ status: "ready", phase: "no-media-dir", scannedAt, finishedAt: Date.now() });
      writeMeta(db, scannedAt);
      return getScanProgress();
    }

    const { videos, walkErrors, truncated, dirMtimes } = await walk(mediaDir);
    emit({ phase: "indexing", total: videos.length });

    const existingFiles = new Map<string, { mtime: number; size: number }>();
    for (const row of db.prepare("SELECT filepath, mtime, size FROM media_files").all() as { filepath: string; mtime: number; size: number }[]) {
      existingFiles.set(row.filepath, { mtime: row.mtime, size: row.size });
    }

    // Last COMPLETED scan's timestamp — the reference point for "was this
    // directory touched since?" in the unchanged-file sidecar refresh. Missing
    // or unparsable → 0, which errs toward refreshing everything once.
    const lastScanRow = db.prepare("SELECT value FROM settings WHERE key = 'scannedAt'").get() as { value: string | null } | undefined;
    const parsedLastScan = lastScanRow?.value ? Date.parse(lastScanRow.value) : 0;
    const lastScanMs = Number.isFinite(parsedLastScan) ? parsedLastScan : 0;

    const seen = new Set<string>();
    const changed: WalkedVideo[] = [];
    let added = 0;
    let updated = 0;
    for (const video of videos) {
      seen.add(video.rel);
      const prev = existingFiles.get(video.rel);
      if (prev && prev.mtime === video.mtime && prev.size === video.size) continue;
      if (prev) updated++;
      else added++;
      changed.push(video);
    }

    const caches = newCaches();
    let processed = 0;
    for (let i = 0; i < changed.length; i += WRITE_BATCH) {
      processChangedBatch(db, mediaDir, changed.slice(i, i + WRITE_BATCH), caches);
      processed += Math.min(WRITE_BATCH, changed.length - i);
      emit({ processed, added, updated });
    }
    emit({ processed: videos.length, added, updated });

    refreshUnchangedSidecars(db, mediaDir, videos, new Set(changed.map((v) => v.rel)), dirMtimes, lastScanMs);

    await runProbePass(db, mediaDir, emit);

    emit({ phase: "nfo" });
    runNfoPass(db, mediaDir, caches);

    emit({ phase: "pruning" });
    const toRemove = Array.from(existingFiles.keys()).filter((filepath) => !seen.has(filepath));
    // A walk that errored (unreadable sub-mount: EACCES/EIO) or hit the
    // maxScanFiles ceiling has NOT proven those files are gone — pruning here
    // once cascaded an entire library away (and with it, via re-inserted
    // AUTOINCREMENT ids, every user's progress/list/ratings). Upserts and
    // probes above already ran normally; only the destructive phase is skipped.
    const pruneSkipped = walkErrors > 0 || truncated;
    if (pruneSkipped) {
      log.warn(`prune skipped: ${walkErrors} walk errors${truncated ? " + walk truncated" : ""} — refusing to remove entries that may still exist`, {
        walkErrors,
        truncated,
        candidates: toRemove.length,
      });
    } else {
      pruneMissingFiles(db, toRemove, caches);
    }
    const removed = pruneSkipped ? 0 : toRemove.length;

    emit({ phase: "indexing-fts" });
    reindexFts(db, caches);

    await runCacheGc(db);

    const scannedAt = new Date().toISOString();
    writeMeta(db, scannedAt);
    // Hold the scan channel open THROUGH the background image pass when there's
    // work for it: emit `ready` already carrying `imaging: true` if any file
    // still needs images. Otherwise the client (which closes its SSE and reloads
    // the catalogue the instant it sees `ready && !imaging`) would reload BEFORE
    // runImagesPass() — fired fire-and-forget below — flips `imaging` true on a
    // later tick, pulling a poster-less snapshot and never re-watching for the
    // posters that land moments later (they'd only show on a manual reload).
    // runImagesPass() clears `imaging` when it finishes (or finds nothing).
    const hasPendingImages = !!db.prepare("SELECT 1 FROM media_files WHERE images_at = 0 LIMIT 1").get();
    emit({ status: "ready", phase: "done", removed, scannedAt, finishedAt: Date.now(), imaging: hasPendingImages });
    log.info("scan complete", { total: videos.length, added, updated, removed, hasPendingImages });

    // Pre-build the catalogue read model off the request path so the client's
    // post-scan reload hits a warm cache instead of paying the build itself.
    void import("./repository").then((m) => m.getSnapshot()).catch(() => {/* best effort */});

    // Fire-and-forget background image extraction (Phase 3). Dynamically
    // imported to avoid a load cycle and to no-op cleanly before that phase exists.
    // The trickplay sprite pass (FLIX_TRICKPLAY, off by default) is CHAINED
    // after it rather than fired alongside, so the two background ffmpeg
    // consumers never run at the same time — and an images-pass failure still
    // lets trickplay proceed. Both stay best-effort: neither can fail the scan.
    void import("./imagesPass")
      .then((m) => m.runImagesPass())
      .catch(() => {/* best effort */})
      .then(() => import("./trickplay"))
      .then((m) => m.runTrickplayPass())
      .catch(() => {/* best effort */});
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown scan error";
    log.error("scan failed", { message });
    emit({ status: "error", phase: "error", error: message, finishedAt: Date.now() });
  } finally {
    scanning = false;
  }

  return getScanProgress();
}
