// Subtitle-to-WebVTT pipeline: embedded text subtitles are extracted lazily via
// ffmpeg on first request, external sidecars (.srt/.vtt/.ass/.ssa) are converted
// in plain JS (no ffmpeg needed for those), and every result is cached
// content-addressed (sha1 of the VTT text) so a repeat request — or a second
// user watching the same file — is a cache hit. Bitmap formats (PGS/VobSub,
// `is_text = 0`) are never handled here: they can only be burned into the
// picture by the transcode path (src/server/playback/sessions.ts), never
// served as a standalone <track>.

import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import { getDb } from "../db";
import { createLogger } from "../logger";
import { resolveRealAbsolutePath, resolveRealLibraryPath } from "../paths";

const log = createLogger("playback:subtitles");
const EXTRACT_TIMEOUT_MS = 30_000;
const MAX_VTT_BYTES = 8 * 1024 * 1024;

interface SubtitleRow {
  id: number;
  media_file_id: number;
  stream_index: number | null;
  source: string;
  external_path: string | null;
  format: string | null;
  is_text: number;
  vtt_hash: string | null;
}

// --- charset heuristic + format conversion (pure, unit-testable) -----------

function utf16beToString(buf: Buffer): string {
  const swapped = Buffer.alloc(buf.length - (buf.length % 2));
  for (let i = 0; i + 1 < buf.length; i += 2) {
    swapped[i] = buf[i + 1];
    swapped[i + 1] = buf[i];
  }
  return swapped.toString("utf16le");
}

/** Best-effort charset detection for sidecar subtitle files: BOM first, else a
 *  UTF-8 validity probe, else fall back to latin1 (a reasonable approximation
 *  of the legacy CP1252 encoding common in older French-subtitle releases). */
export function decodeSubtitleBuffer(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return utf16beToString(buf.subarray(2));
  const utf8 = buf.toString("utf8");
  // A byte sequence that isn't valid UTF-8 round-trips through the replacement
  // character (U+FFFD) when decoded as UTF-8 — a cheap, dependency-free mojibake test.
  if (!utf8.includes("�")) return utf8;
  return buf.toString("latin1");
}

function ensureVttHeader(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  return trimmed.startsWith("WEBVTT") ? trimmed : `WEBVTT\n\n${trimmed}`;
}

const SRT_TIMESTAMP_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/g;

/** Convert SubRip (.srt) text to WebVTT: drop the numeric cue-index lines and
 *  swap the `,`-millisecond separator for VTT's `.`. Cue text and ordering are
 *  otherwise untouched — SRT has no styling worth preserving that VTT can't
 *  already express identically. */
export function srtToVtt(srt: string): string {
  const normalized = srt.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return "WEBVTT\n\n";
  const body = normalized
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split("\n")
        .filter((line, i) => !(i === 0 && /^\d+$/.test(line.trim())))
        .join("\n"),
    )
    .filter(Boolean)
    .join("\n\n")
    .replace(SRT_TIMESTAMP_RE, (_m, h, mi, s, ms) => `${h.padStart(2, "0")}:${mi}:${s}.${ms}`);
  return `WEBVTT\n\n${body}\n`;
}

function assTimeToVtt(time: string | undefined): string | null {
  if (!time) return null;
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const [, h, mi, s, cs] = m;
  return `${h.padStart(2, "0")}:${mi}:${s}.${cs}0`; // centiseconds -> milliseconds
}

/** Best-effort Advanced SubStation Alpha (.ass/.ssa) -> WebVTT: reads the
 *  [Events] Dialogue lines using the file's own declared Format column order,
 *  strips `{...}` style override tags and `\N`/`\h` control codes. Karaoke
 *  timing, positioning and styling are intentionally NOT reproduced — WebVTT
 *  has no equivalent, and a plain readable cue beats a `<track>` full of
 *  literal ASS markup. */
export function assToVtt(ass: string): string {
  const lines = ass.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  let inEvents = false;
  let format: string[] = [];
  const cues: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[Events\]/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (/^\[/.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(line)) {
      format = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((s) => s.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;

    const startIdx = format.indexOf("start");
    const endIdx = format.indexOf("end");
    const textIdx = format.indexOf("text");
    if (startIdx === -1 || endIdx === -1 || textIdx === -1) continue;

    const fields = line.slice(line.indexOf(":") + 1).split(",");
    if (fields.length <= textIdx) continue;
    const vttStart = assTimeToVtt(fields[startIdx]);
    const vttEnd = assTimeToVtt(fields[endIdx]);
    if (!vttStart || !vttEnd) continue;

    // Text is the last declared column but legitimately contains commas — take
    // everything from its column onward instead of a single split segment.
    const cleaned = fields
      .slice(textIdx)
      .join(",")
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\N/gi, "\n")
      .replace(/\\h/gi, " ")
      .trim();
    if (!cleaned) continue;
    cues.push(`${vttStart} --> ${vttEnd}\n${cleaned}`);
  }
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

// --- content-addressed cache -------------------------------------------------

function subsCacheDir(): string {
  return path.join(getConfig().cacheDir, "subs");
}
function subsCachePath(hash: string): string {
  return path.join(subsCacheDir(), `${hash}.vtt`);
}
function sha1(text: string): string {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex");
}

async function cacheVtt(content: string): Promise<string> {
  const hash = sha1(content);
  const file = subsCachePath(hash);
  if (!fs.existsSync(file)) {
    await fs.promises.mkdir(subsCacheDir(), { recursive: true });
    // Write-then-rename: a crash mid-write would otherwise leave a TRUNCATED
    // file under its final content-addressed name — every later regeneration
    // of the same content hashes to the same name, sees it "cached", and the
    // broken cue file is served (immutable!) forever. Same pattern as the HLS
    // sessions' -hls_flags temp_file.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, content, "utf8");
    await fs.promises.rename(tmp, file);
  }
  return hash;
}

// --- embedded extraction (ffmpeg, array-args only) ---------------------------

function extractEmbeddedVtt(absPath: string, streamIndex: number): Promise<string | null> {
  return new Promise((resolve) => {
    const { ffmpegPath } = getConfig();
    const args = ["-nostdin", "-v", "error", "-i", absPath, "-map", `0:${streamIndex}`, "-f", "webvtt", "-"];
    let proc;
    try {
      proc = spawn(/*turbopackIgnore: true*/ ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      log.warn("failed to spawn ffmpeg for subtitle extraction", { message: error instanceof Error ? error.message : String(error) });
      resolve(null);
      return;
    }
    // Only stdout is consumed, but stderr is piped too — drain it so a noisy or
    // corrupt subtitle stream can't fill the OS pipe buffer and block ffmpeg
    // until the 30s SIGKILL. A plain no-op drain is enough (we never read it).
    proc.stderr?.on("data", () => {});
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };
    const killTimer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(null);
    }, EXTRACT_TIMEOUT_MS);
    proc.stdout.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_VTT_BYTES) {
        // An over-limit track must FAIL, not silently truncate: the result is
        // cached content-addressed and pinned by vtt_hash in the DB, so a
        // truncated cue file would otherwise be served forever.
        proc.kill("SIGKILL");
        finish(null);
        return;
      }
      chunks.push(c);
    });
    proc.on("error", () => finish(null));
    proc.on("close", (code) => {
      if (code !== 0 || !chunks.length) {
        finish(null);
        return;
      }
      finish(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export interface VttResult {
  content: string;
  hash: string;
}

/** In-flight generations by subtitleId — N concurrent first requests for the
 *  same subtitle must share ONE extraction (each embedded-track cache miss
 *  spawns a full-file ffmpeg demux), not fork N identical ffmpeg processes. */
const inFlight = new Map<number, Promise<VttResult | null>>();

/** Resolve subtitles.id to servable WebVTT text, generating and caching it on
 *  first request. Returns null for a missing row, a bitmap-only subtitle
 *  (is_text = 0), or any extraction/read/decode failure. */
export function getVttForSubtitle(subtitleId: number): Promise<VttResult | null> {
  const pending = inFlight.get(subtitleId);
  if (pending) return pending;
  const promise = generateVttForSubtitle(subtitleId).finally(() => {
    inFlight.delete(subtitleId);
  });
  inFlight.set(subtitleId, promise);
  return promise;
}

async function generateVttForSubtitle(subtitleId: number): Promise<VttResult | null> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM subtitles WHERE id = ?").get(subtitleId) as SubtitleRow | undefined;
  if (!row || row.is_text === 0) return null;

  if (row.vtt_hash) {
    try {
      const content = await fs.promises.readFile(subsCachePath(row.vtt_hash), "utf8");
      return { content, hash: row.vtt_hash };
    } catch {
      // cache file missing (cache dir wiped, etc.) — fall through and regenerate
    }
  }

  let content: string | null;
  if (row.source === "embedded") {
    if (row.stream_index === null) return null;
    const media = db.prepare("SELECT filepath FROM media_files WHERE id = ?").get(row.media_file_id) as { filepath: string } | undefined;
    if (!media) return null;
    const absPath = await resolveRealLibraryPath(media.filepath);
    if (!absPath) return null;
    content = await extractEmbeddedVtt(absPath, row.stream_index);
  } else {
    if (!row.external_path) return null;
    // The scanner now records external_path RELATIVE to mediaDir (survives the
    // library being remounted at a different absolute path); absolute paths are
    // legacy rows from before that change, resolved as before until a rescan
    // rewrites them.
    const absPath = path.isAbsolute(row.external_path)
      ? await resolveRealAbsolutePath(row.external_path)
      : await resolveRealLibraryPath(row.external_path);
    if (!absPath) return null;
    let buf: Buffer;
    try {
      // Same ceiling as embedded extraction: anything bigger than
      // MAX_VTT_BYTES is not a subtitle, and readFile would otherwise buffer
      // the whole file in RAM (then decode it, doubling the allocation).
      const { size } = await fs.promises.stat(absPath);
      if (size > MAX_VTT_BYTES) {
        log.warn("external subtitle rejected: larger than the subtitle ceiling", { size });
        return null;
      }
      buf = await fs.promises.readFile(absPath);
    } catch {
      return null;
    }
    const text = decodeSubtitleBuffer(buf);
    content = row.format === "ass" ? assToVtt(text) : row.format === "webvtt" ? ensureVttHeader(text) : srtToVtt(text);
  }
  if (!content) return null;

  const hash = await cacheVtt(content);
  try {
    db.prepare("UPDATE subtitles SET vtt_hash = ? WHERE id = ?").run(hash, subtitleId);
  } catch {
    // best-effort cache pointer — the file on disk is what actually serves it next time
  }
  return { content, hash };
}
