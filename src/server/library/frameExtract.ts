// Frame extraction for generated backdrops/thumbs and embedded cover art.
// Every ffmpeg invocation here follows the same hardened pattern as ffprobe.ts
// and Auralis's analysis.ts: array-of-arguments spawn only (never a shell),
// `-nostdin`, a hard 30s timeout that SIGKILLs a stuck process, and a lowered
// scheduling priority so a background image pass never competes with
// foreground playback for CPU.
//
// Anti-black-frame: a fixed seek timestamp regularly lands on a black leader,
// a fade-to-black transition or a title card. We sample several candidate
// timestamps, score each with sharp's pixel statistics (mean luminance +
// stdev + entropy), and keep the best-scoring one instead of just the first.
//
// HDR→SDR tonemap: an HDR10/HLG/DV source decoded and scaled without care
// produces a washed-out or over-bright generated frame. When the local ffmpeg
// build actually ships zscale (checked once and memoised — many distro builds
// don't bundle libzimg), we route through zscale→tonemap→zscale before
// scaling; otherwise we degrade to a plain scale rather than fail extraction.

import { spawn } from "child_process";
import os from "os";
import { getConfig } from "../config";
import { createLogger } from "../logger";
import { getSharp } from "./images";
import type { HdrFormat } from "./ffprobe";

const log = createLogger("frameExtract");

const EXTRACT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const CANDIDATE_CONCURRENCY = 2;
const LOW_PRIORITY = 10; // os.setPriority niceness (POSIX: -20 high .. 19 low)

function ffmpegBin(): string {
  return getConfig().ffmpegPath;
}

// --- zscale capability probe (checked once per process, memoised) ----------

let zscaleAvailable: boolean | undefined;

export async function hasZscale(): Promise<boolean> {
  if (zscaleAvailable !== undefined) return zscaleAvailable;
  zscaleAvailable = await new Promise<boolean>((resolve) => {
    let proc;
    try {
      proc = spawn(/*turbopackIgnore: true*/ ffmpegBin(), ["-hide_banner", "-filters"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0 && Buffer.concat(chunks).toString("utf8").includes("zscale")));
  });
  return zscaleAvailable;
}

/** Reset the memoised zscale probe — tests only. */
export function resetZscaleCache(): void {
  zscaleAvailable = undefined;
}

// --- pure filter-chain builder ----------------------------------------------

export interface FrameFilterOptions {
  width: number;
  hdrFormat: HdrFormat | null;
  zscaleAvailable: boolean;
  /** Let ffmpeg's own `thumbnail` filter pick the sharpest/most representative
   *  of N decoded frames near the seek point, instead of the exact one landed on. */
  multiFrame?: boolean;
  /** Centre-crop the (landscape) frame to a 2:3 portrait BEFORE scaling, so a
   *  video frame can stand in for a missing sidecar/embedded poster. A tall
   *  centre slice of the frame beats a blank tile — the only offline poster
   *  source we have when no artwork ships with the file. */
  poster?: boolean;
}

/** Builds the -vf chain for a generated frame. Pure and independent of ffmpeg
 *  itself, so the exact string this produces is unit-testable. */
export function buildFrameFilter(opts: FrameFilterOptions): string {
  const parts: string[] = [];
  if (opts.hdrFormat && opts.hdrFormat !== "SDR" && opts.zscaleAvailable) {
    parts.push("zscale=t=linear:npl=100", "tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709", "format=yuv420p");
  }
  if (opts.multiFrame) parts.push("thumbnail=24");
  // Largest 2:3 rectangle that FITS the frame, centred (ffmpeg centres x/y by
  // default). `min()` on each axis keeps it within bounds for BOTH orientations:
  // landscape → out_w = ih*2/3 (height binds); a portrait/vertical source →
  // out_w = iw, out_h = iw*3/2 (width binds). A bare `crop=ih*2/3:ih` overflows
  // width on a portrait source and ffmpeg aborts the whole extraction. The `\,`
  // escapes the comma so the filtergraph parser doesn't read it as a separator.
  // Runs after thumbnail's best-of-N pick and before scale.
  if (opts.poster) parts.push("crop=min(iw\\,ih*2/3):min(ih\\,iw*3/2)");
  parts.push(`scale=${opts.width}:-2`);
  return parts.join(",");
}

// --- low-level ffmpeg frame grab --------------------------------------------

// "Binary not found" counter (spawn ENOENT), mirroring ffprobe.ts: the images
// pass snapshots it before each file and leaves images_at = 0 (retry next
// scan) only when it grew DURING that file, instead of stamping the file done
// while ffmpeg was simply missing (mistyped FFMPEG_PATH at first boot). A
// counter, not a pass-wide boolean latch: the latch also unstamped every file
// AFTER the first ENOENT — including sidecar-only files that never touch
// ffmpeg — so the pending set never drained and every scan replayed a full
// imaging pass for as long as ffmpeg stayed missing. Monotonic, never reset:
// consumers compare before/after, so a fixed FFMPEG_PATH heals on its own.
let spawnEnoentCount = 0;
export function ffmpegMissingCount(): number {
  return spawnEnoentCount;
}
function noteSpawnError(error: unknown): void {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") spawnEnoentCount++;
}

function runFfmpeg(args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      // stderr is "ignore", not "pipe": nothing reads it, and an unread pipe
      // blocks the child once its 64 KiB buffer fills (a file spewing decode
      // warnings would then hang until the SIGKILL timeout).
      proc = spawn(/*turbopackIgnore: true*/ ffmpegBin(), args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      noteSpawnError(error);
      log.warn("failed to spawn ffmpeg", { message: error instanceof Error ? error.message : String(error) });
      resolve(null);
      return;
    }
    if (typeof proc.pid === "number") {
      try {
        os.setPriority(proc.pid, LOW_PRIORITY);
      } catch {
        // niceness isn't available/permitted on every platform — best effort
      }
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    const killTimer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(null);
    }, EXTRACT_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_STDOUT_BYTES) {
        // A single JPEG frame never approaches the cap; overflowing it means
        // something is wrong. Abort rather than resolve a silently-truncated
        // buffer as if it were a valid frame (finish() is idempotent).
        proc.kill("SIGKILL");
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    proc.on("error", (error) => {
      noteSpawnError(error);
      finish(null);
    });
    proc.on("close", (code) => {
      if (code !== 0 || !chunks.length) {
        finish(null);
        return;
      }
      finish(Buffer.concat(chunks));
    });
  });
}

/** Extract the embedded cover art (the `attached_pic` disposition stream) as
 *  a single JPEG frame. */
export function extractAttachedPic(absPath: string, streamIndex: number): Promise<Buffer | null> {
  return runFfmpeg(["-nostdin", "-v", "error", "-i", absPath, "-map", `0:${streamIndex}`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-"]);
}

function extractFrameAt(absPath: string, atSeconds: number, vf: string): Promise<Buffer | null> {
  return runFfmpeg([
    "-nostdin",
    "-v",
    "error",
    "-ss",
    atSeconds.toFixed(2),
    "-i",
    absPath,
    "-frames:v",
    "1",
    "-vf",
    vf,
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "-",
  ]);
}

// --- anti-black-frame scoring (pure) -----------------------------------------

export interface FrameStats {
  mean: number; // 0..255 average luminance across R/G/B
  stdev: number; // 0..255 average per-channel standard deviation
  entropy: number; // sharp's greyscale entropy estimate
}

const BLACK_MEAN_THRESHOLD = 18;
const BLACK_STDEV_THRESHOLD = 12;

/** A near-uniform, near-black frame: a fade-to-black, a black leader, a
 *  blank title card. */
export function isBlackFrame(stats: FrameStats): boolean {
  return stats.mean < BLACK_MEAN_THRESHOLD || stats.stdev < BLACK_STDEV_THRESHOLD;
}

export function frameScore(stats: FrameStats): number {
  return stats.entropy * stats.mean;
}

export interface ScoredCandidate<T> {
  item: T;
  stats: FrameStats;
}

/** Picks the best-scoring candidate, preferring any that clear the black-frame
 *  threshold. If EVERY sampled timestamp is black (e.g. the whole clip opens
 *  on a long black leader past all our candidate points) falls back to the
 *  least-bad one instead of returning nothing. */
export function pickBestFrame<T>(candidates: ScoredCandidate<T>[]): T | null {
  if (!candidates.length) return null;
  const accepted = candidates.filter((c) => !isBlackFrame(c.stats));
  const pool = accepted.length ? accepted : candidates;
  return pool.reduce((best, c) => (frameScore(c.stats) > frameScore(best.stats) ? c : best)).item;
}

async function computeFrameStats(buf: Buffer): Promise<FrameStats | null> {
  const sharp = await getSharp();
  if (!sharp) return null;
  try {
    const stats = await sharp(buf, { failOn: "none" }).stats();
    const channels = stats.channels.slice(0, 3);
    if (!channels.length) return null;
    const mean = channels.reduce((a, c) => a + c.mean, 0) / channels.length;
    const stdev = channels.reduce((a, c) => a + c.stdev, 0) / channels.length;
    return { mean, stdev, entropy: stats.entropy };
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export interface GeneratedFrameOptions {
  duration: number;
  hdrFormat: HdrFormat | null;
  fractions: number[]; // candidate seek points as a fraction (0..1) of duration
  width: number;
  multiFrame?: boolean;
  /** Centre-crop each candidate to a 2:3 portrait — for a generated poster
   *  (see buildFrameFilter). Off for landscape backdrops/thumbs. */
  poster?: boolean;
}

/** Extract the best available frame from a video: samples every candidate
 *  fraction of the duration, scores each with sharp, and returns the winner.
 *  Returns null if the file has no usable duration or every extraction failed. */
export async function extractGeneratedFrame(absPath: string, opts: GeneratedFrameOptions): Promise<Buffer | null> {
  if (!(opts.duration > 0) || !opts.fractions.length) return null;

  const zscaleOk = await hasZscale();
  const vf = buildFrameFilter({ width: opts.width, hdrFormat: opts.hdrFormat, zscaleAvailable: zscaleOk, multiFrame: opts.multiFrame ?? true, poster: opts.poster });

  const rawBuffers = await mapWithConcurrency(opts.fractions, CANDIDATE_CONCURRENCY, (fraction) =>
    extractFrameAt(absPath, Math.max(0, opts.duration * fraction), vf),
  );
  const buffers = rawBuffers.filter((b): b is Buffer => b !== null);
  if (!buffers.length) return null;

  const scored: ScoredCandidate<Buffer>[] = [];
  for (const buf of buffers) {
    const stats = await computeFrameStats(buf);
    if (stats) scored.push({ item: buf, stats });
  }
  // sharp unavailable/failed on every candidate — best effort, unscored.
  return scored.length ? pickBestFrame(scored) : buffers[0];
}
