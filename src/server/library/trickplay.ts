// Trickplay sprite generation + lookup: one JPEG sprite per media file (a
// frame every ~10s, 320px-wide tiles laid out on a fixed-column grid) with a
// JSON metadata sidecar, both under <cacheDir>/trickplay. Gated behind the
// FLIX_TRICKPLAY config flag (off by default — it's extra ffmpeg work per
// file) and produced by ONE ffmpeg pass per file via fps→scale→tile.
//
// Cache invalidation is by fileId + mtime: the pair is baked into the file
// names (`<fileId>-<mtime>.jpg/.json`), so a replaced/re-encoded video simply
// misses the cache and regenerates, and stale siblings of the same fileId are
// pruned at generation time. Every ffmpeg invocation follows the hardened
// pattern of ffprobe.ts/frameExtract.ts: array-of-arguments spawn only (never
// a shell), -nostdin, a hard timeout that SIGKILLs a stuck process, and a
// lowered scheduling priority so the background pass never competes with
// foreground playback.

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { getConfig } from "../config";
import { getDb } from "../db";
import { createLogger } from "../logger";
import { resolveRealLibraryPath } from "../paths";

const log = createLogger("trickplay");

export const TRICKPLAY_TILE_WIDTH = 320;
export const TRICKPLAY_COLS = 8;
export const TRICKPLAY_BASE_INTERVAL_SECONDS = 10;
/** Tile-count ceiling: past this the interval stretches instead (a 4h file at
 *  10s would otherwise mean a 1440-tile, ~30k-pixel-tall JPEG). */
export const TRICKPLAY_MAX_TILES = 400;

// A sprite pass decodes keyframes across the whole file — far heavier than a
// single frame grab, so the timeout is proportionally larger than
// frameExtract's 30s (but still hard: a stuck decode gets SIGKILLed).
const GENERATE_TIMEOUT_MS = 180_000;
const LOW_PRIORITY = 10; // os.setPriority niceness (POSIX: -20 high .. 19 low)
const JPEG_QUALITY = "5"; // ffmpeg -q:v (2 best .. 31 worst)

export interface TrickplayLayout {
  interval: number;
  cols: number;
  rows: number;
  count: number;
  tileWidth: number;
  tileHeight: number;
}

/** Full metadata sidecar persisted next to the sprite. The public shape served
 *  by /api/trickplay strips the identity fields (see publicMeta below). */
export interface TrickplayMetaFile extends TrickplayLayout {
  version: 1;
  fileId: number;
  mtime: number;
  duration: number;
  generatedAt: number;
}

/** What the API route serialises — mirrors TrickplayMeta in src/lib/flix/types.ts. */
export interface TrickplayPublicMeta {
  interval: number;
  tileWidth: number;
  tileHeight: number;
  cols: number;
  count: number;
  duration: number;
}

/**
 * Pure layout math (unit-tested without ffmpeg): sampling interval (stretched
 * past TRICKPLAY_MAX_TILES), tile count (fps=1/N emits a frame at t=0 then
 * every N seconds → floor(duration/interval)+1), grid columns/rows, and the
 * tile height derived from the source aspect ratio (16:9 fallback), rounded
 * to an even pixel count for the encoder. Null for an unknown duration —
 * there is nothing sensible to sample.
 */
export function computeTrickplayLayout(duration: number, videoWidth: number | null, videoHeight: number | null): TrickplayLayout | null {
  if (!(duration > 0)) return null;
  let interval = TRICKPLAY_BASE_INTERVAL_SECONDS;
  if (duration / interval + 1 > TRICKPLAY_MAX_TILES) interval = Math.ceil(duration / (TRICKPLAY_MAX_TILES - 1));
  const count = Math.min(TRICKPLAY_MAX_TILES, Math.floor(duration / interval) + 1);
  const cols = Math.min(TRICKPLAY_COLS, count);
  const rows = Math.ceil(count / cols);
  const ratio = videoWidth && videoHeight && videoWidth > 0 && videoHeight > 0 ? videoHeight / videoWidth : 9 / 16;
  const tileHeight = Math.max(2, Math.round((TRICKPLAY_TILE_WIDTH * ratio) / 2) * 2);
  return { interval, cols, rows, count, tileWidth: TRICKPLAY_TILE_WIDTH, tileHeight };
}

/** The single -vf chain for the one-pass sprite build. Pure, unit-testable. */
export function buildTrickplayFilter(layout: TrickplayLayout): string {
  return `fps=1/${layout.interval},scale=${layout.tileWidth}:${layout.tileHeight},tile=${layout.cols}x${layout.rows}`;
}

function trickplayDir(): string {
  return path.join(getConfig().cacheDir, "trickplay");
}

function spritePathFor(fileId: number, mtime: number): string {
  return path.join(trickplayDir(), `${fileId}-${mtime}.jpg`);
}
function metaPathFor(fileId: number, mtime: number): string {
  return path.join(trickplayDir(), `${fileId}-${mtime}.json`);
}

interface FileRow {
  id: number;
  filepath: string;
  mtime: number;
  duration: number;
}

function videoDimensions(fileId: number): { width: number | null; height: number | null } {
  const row = getDb()
    .prepare("SELECT width, height FROM streams WHERE media_file_id = ? AND type = 'video' AND attached_pic = 0 ORDER BY stream_index LIMIT 1")
    .get(fileId) as { width: number | null; height: number | null } | undefined;
  return { width: row?.width ?? null, height: row?.height ?? null };
}

/** Delete other generations of the same fileId (older mtime — the video was
 *  replaced) so the cache never accumulates one sprite per re-encode. */
function pruneStaleFor(fileId: number, keepMtime: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(trickplayDir());
  } catch {
    return;
  }
  const keep = new Set([`${fileId}-${keepMtime}.jpg`, `${fileId}-${keepMtime}.json`]);
  const mine = new RegExp(`^${fileId}-\\d+\\.(jpg|json)$`);
  for (const entry of entries) {
    if (!mine.test(entry) || keep.has(entry)) continue;
    try {
      fs.rmSync(path.join(trickplayDir(), entry), { force: true });
    } catch {
      /* best effort */
    }
  }
}

function runFfmpegToFile(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const { ffmpegPath } = getConfig();
    let proc;
    try {
      proc = spawn(/*turbopackIgnore: true*/ ffmpegPath, args, { stdio: ["ignore", "ignore", "ignore"] });
    } catch (error) {
      log.warn("failed to spawn ffmpeg", { message: error instanceof Error ? error.message : String(error) });
      resolve(false);
      return;
    }
    if (typeof proc.pid === "number") {
      try {
        os.setPriority(proc.pid, LOW_PRIORITY);
      } catch {
        // niceness isn't available/permitted on every platform — best effort
      }
    }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(ok);
    };
    const killTimer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(false);
    }, GENERATE_TIMEOUT_MS);
    proc.on("error", () => finish(false));
    proc.on("close", (code) => finish(code === 0));
  });
}

/**
 * Generate the sprite + metadata for one media file. Idempotent (no-ops when
 * the current fileId+mtime generation already exists), silent no-op when the
 * FLIX_TRICKPLAY flag is off, and never throws — a failure is logged and
 * reported as false so a bad file can't abort the pass. The sprite is written
 * to a temp name and renamed into place so a concurrent reader can never see
 * a half-written JPEG; the metadata sidecar lands last (it is the "generation
 * committed" marker the read path keys on).
 */
export async function generateTrickplay(fileId: number): Promise<boolean> {
  const config = getConfig();
  if (!config.trickplay) return false;

  const file = getDb().prepare("SELECT id, filepath, mtime, duration FROM media_files WHERE id = ?").get(fileId) as FileRow | undefined;
  if (!file) return false;

  const metaPath = metaPathFor(file.id, file.mtime);
  const spritePath = spritePathFor(file.id, file.mtime);
  if (hasValidTrickplay(file.id, file.mtime)) return true;

  const { width, height } = videoDimensions(file.id);
  const layout = computeTrickplayLayout(file.duration, width, height);
  if (!layout) return false;

  const abs = await resolveRealLibraryPath(file.filepath);
  if (!abs) return false;

  try {
    fs.mkdirSync(trickplayDir(), { recursive: true });
  } catch {
    return false;
  }

  // -skip_frame nokey decodes keyframes only — the fps filter then holds each
  // one until the next sample point, which is exactly the coarse-but-cheap
  // look trickplay wants (a full decode of a 2h file would take minutes).
  const tmpPath = `${spritePath}.tmp-${process.pid}`;
  const args = [
    "-nostdin",
    "-v",
    "error",
    "-skip_frame",
    "nokey",
    "-i",
    abs,
    "-an",
    "-sn",
    "-vf",
    buildTrickplayFilter(layout),
    "-frames:v",
    "1",
    "-q:v",
    JPEG_QUALITY,
    "-f",
    "image2",
    "-y",
    tmpPath,
  ];

  const ok = await runFfmpegToFile(args);
  if (!ok || !fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best effort */
    }
    log.warn("sprite generation failed", { filepath: file.filepath });
    return false;
  }

  const meta: TrickplayMetaFile = {
    version: 1,
    fileId: file.id,
    mtime: file.mtime,
    duration: file.duration,
    generatedAt: Date.now(),
    ...layout,
  };
  // The meta sidecar is the "generation committed" marker the read path keys on,
  // so write it atomically too (temp + rename), like the sprite — a torn
  // meta.json from a crash/disk-full mid-write would otherwise exist on disk yet
  // read as invalid forever. The `.tmp-` suffix keeps purgeTrickplayTemps sweeping it.
  const metaTmp = `${metaPath}.tmp-${process.pid}`;
  try {
    fs.renameSync(tmpPath, spritePath);
    fs.writeFileSync(metaTmp, JSON.stringify(meta));
    fs.renameSync(metaTmp, metaPath);
  } catch (error) {
    log.warn("failed to persist sprite", { filepath: file.filepath, message: error instanceof Error ? error.message : String(error) });
    try {
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(metaTmp, { force: true });
      fs.rmSync(spritePath, { force: true });
      fs.rmSync(metaPath, { force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
  pruneStaleFor(file.id, file.mtime);
  return true;
}

/** Whether the required fields of a parsed meta match the file it claims to
 *  describe. Shared by the read path and the generation/pass idempotency checks
 *  so "is this generation complete?" has exactly ONE definition. */
function metaIsValid(parsed: TrickplayMetaFile, fileId: number, mtime: number): boolean {
  return (
    parsed.version === 1 &&
    parsed.fileId === fileId &&
    parsed.mtime === mtime &&
    parsed.interval > 0 &&
    parsed.count > 0 &&
    parsed.cols > 0 &&
    parsed.tileWidth > 0 &&
    parsed.tileHeight > 0
  );
}

/** A COMMITTED, valid generation exists for this file+mtime — sprite present AND
 *  meta parseable/valid. Unlike a bare existsSync this rejects a torn meta.json
 *  (a crash between the sprite rename and the meta write), so the pass and the
 *  idempotency check regenerate it instead of treating it as "done" forever
 *  while the read path 404s on it. */
function hasValidTrickplay(fileId: number, mtime: number): boolean {
  if (!fs.existsSync(spritePathFor(fileId, mtime))) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPathFor(fileId, mtime), "utf8")) as TrickplayMetaFile;
    return metaIsValid(parsed, fileId, mtime);
  } catch {
    return false;
  }
}

/** Read the committed generation for a file's CURRENT mtime. Null when the
 *  flag is off for generation but reads are still honest: absent/stale/corrupt
 *  metadata (or a missing sprite) → null → the route's 404. */
export function getTrickplayForFile(fileId: number): { meta: TrickplayPublicMeta; spritePath: string; mtime: number } | null {
  const file = getDb().prepare("SELECT mtime FROM media_files WHERE id = ?").get(fileId) as { mtime: number } | undefined;
  if (!file) return null;
  const metaPath = metaPathFor(fileId, file.mtime);
  const spritePath = spritePathFor(fileId, file.mtime);
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath, "utf8");
  } catch {
    return null;
  }
  let parsed: TrickplayMetaFile;
  try {
    parsed = JSON.parse(raw) as TrickplayMetaFile;
  } catch {
    return null;
  }
  if (!metaIsValid(parsed, fileId, file.mtime)) return null;
  if (!fs.existsSync(spritePath)) return null;
  return {
    meta: {
      interval: parsed.interval,
      tileWidth: parsed.tileWidth,
      tileHeight: parsed.tileHeight,
      cols: parsed.cols,
      count: parsed.count,
      duration: parsed.duration,
    },
    spritePath,
    mtime: file.mtime,
  };
}

/**
 * Sweep sprite temps orphaned by a crash (or kill -9) mid-generation: an
 * ffmpeg pass writes `<fileId>-<mtime>.jpg.tmp-<pid>` and only renames it into
 * place on success, so a process that dies in between leaves a temp nothing
 * ever renames or references again — pure leaked cache disk. Best-effort and
 * idempotent (a missing cache dir is a no-op). Matches only the `.tmp-` suffix,
 * so committed `.jpg`/`.json` generations are never touched.
 *
 * Exported so the boot hook (bootstrap.ts ensureLibraryReady, out of this
 * group) can call it once per boot; also invoked at the head of every
 * runTrickplayPass below, which covers the fresh-install first-boot scan.
 */
export async function purgeTrickplayTemps(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(trickplayDir());
  } catch {
    return; // no cache dir yet — nothing to sweep
  }
  await Promise.all(
    entries
      .filter((name) => name.includes(".tmp-"))
      .map((name) => fs.promises.rm(path.join(trickplayDir(), name), { force: true }).catch(() => {})),
  );
}

let running = false;

/**
 * Build every still-missing sprite, strictly sequentially (one ffmpeg at a
 * time — deliberately NOT the images pass's concurrency: a sprite pass decodes
 * whole files, and two of those next to live playback would starve it).
 * Fire-and-forget from the scanner, after the images pass; safe to call
 * repeatedly (no-ops while already running), and any single file's failure is
 * logged and skipped. Silent no-op when FLIX_TRICKPLAY is off.
 */
export async function runTrickplayPass(): Promise<void> {
  if (running) return;
  const config = getConfig();
  if (!config.trickplay) return;

  // Claim the single-flight slot BEFORE the first await (the temp sweep) so a
  // concurrent caller can't slip past the `running` guard while we yield.
  running = true;
  try {
    // Reap temps orphaned by a crash mid-generation before building — safe to
    // run unconditionally here because `running` now single-flights the pass and
    // generation is strictly sequential, so no live temp of our own can exist yet.
    await purgeTrickplayTemps();

    const db = getDb();
    // Only probed files: an unprobed row has no trustworthy duration to sample.
    const pending = db.prepare("SELECT id, filepath, mtime, duration FROM media_files WHERE probed_at > 0 AND duration > 0").all() as FileRow[];
    const missing = pending.filter((f) => !hasValidTrickplay(f.id, f.mtime));
    if (!missing.length) return;

    log.info("trickplay pass started", { total: missing.length });
    let built = 0;
    for (const file of missing) {
      try {
        if (await generateTrickplay(file.id)) built++;
      } catch (error) {
        log.warn("trickplay generation failed", { filepath: file.filepath, message: error instanceof Error ? error.message : String(error) });
      }
    }
    log.info("trickplay pass complete", { total: missing.length, built });
  } finally {
    running = false;
  }
}
