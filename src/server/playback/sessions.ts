// ffmpeg remux/transcode session manager. Owns the whole lifecycle of a live
// HLS session: spawning ffmpeg as a hardened array-of-arguments child process
// (never a shell), serving segments only from that session's own directory,
// seeking by killing + respawning ffmpeg at the right input timestamp, and
// sweeping idle sessions on timers so a client that vanishes (closed tab,
// crashed device) never leaves an ffmpeg process or a transcode directory
// behind forever.
//
// Design note on the HLS manifest: we never serve ffmpeg's own `.m3u8` (it
// writes one, but to `ffmpeg-internal.m3u8`, which nothing ever reads). The
// manifest a player actually receives is computed ONCE, entirely server-side,
// from the file's total duration and (for remux) its keyframe index — a
// complete, static, `#EXT-X-ENDLIST`-terminated VOD playlist from the very
// first response. That is what makes arbitrary-position seeking possible:
// hls.js (or any HLS client) can request ANY segment index up front, and our
// segment route below decides whether to serve it immediately, wait for the
// live process to reach it, or kill + reseek ffmpeg to produce it.
//
// Segmentation is fixed at 4s. In remux (`-c copy`) mode a cut can only ever
// land on a keyframe, so segment boundaries are the file's real keyframe
// timestamps (indexed once via ffprobe, cached in media_files.keyframes) —
// EXTINF values are the REAL inter-keyframe gaps, not a fake uniform 4s. In
// transcode mode we control encoding, so keyframes are forced every 4s
// (`-force_key_frames`) and boundaries are exactly uniform.

import { spawn, type ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { getConfig } from "../config";
import { getDb } from "../db";
import { createLogger } from "../logger";
import { resolveRealLibraryPath } from "../paths";
import { hasZscale } from "../library/frameExtract";
import { decide, getFileStreamsForPlayback } from "./decision";
import type { ClientCaps } from "@/lib/flix/caps";
import {
  buildPlaylist,
  buildRemuxArgs,
  buildTranscodeArgs,
  computeSegmentBoundaries,
  contiguousMaxProducedIndex,
  isRemuxCopyableAudio,
  SEG_SECONDS,
  SEGMENT_NAME_RE,
} from "./hlsArgs";

// The segment-boundary math, static VOD playlist rendering, segment-name
// allowlist and ffmpeg-argv builders now live in ./hlsArgs (pure, side-effect-
// free, unit-testable). They are re-exported here UNCHANGED so every existing
// importer — the playback routes and the test suite, which reads them off this
// module — keeps the exact same public surface: this is a pure file move.
export { SEG_SECONDS, computeSegmentBoundaries, buildPlaylist, SEGMENT_NAME_RE, isRemuxCopyableAudio, buildRemuxArgs, buildTranscodeArgs, contiguousMaxProducedIndex };
export type { RemuxArgsInput, TranscodeArgsInput } from "./hlsArgs";

const log = createLogger("playback:sessions");

const LOW_PRIORITY = 10; // os.setPriority niceness (POSIX: -20 high .. 19 low)
const PRODUCTION_HORIZON = 3; // segments ahead of the last produced one we'll wait for instead of reseeking
const SEGMENT_WAIT_MS = 20_000;
const SEGMENT_POLL_MS = 200;
const KEYFRAME_INDEX_TIMEOUT_MS = 60_000;
const STDERR_TAIL_BYTES = 8192;

let SWEEP_INTERVAL_MS = 30_000;
let IDLE_KILL_MS = 60_000;
let IDLE_PURGE_MS = 5 * 60_000;

/** Override the cleanup timers — manual/integration testing only, so a 5-minute
 *  idle purge can be exercised without actually waiting 5 minutes. */
export function setSessionTimersForTests(overrides: { sweepMs?: number; idleKillMs?: number; idlePurgeMs?: number }): void {
  if (overrides.sweepMs !== undefined) SWEEP_INTERVAL_MS = overrides.sweepMs;
  if (overrides.idleKillMs !== undefined) IDLE_KILL_MS = overrides.idleKillMs;
  if (overrides.idlePurgeMs !== undefined) IDLE_PURGE_MS = overrides.idlePurgeMs;
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    ensureSweep();
  }
}

export type SessionMode = "remux" | "transcode";

export interface Session {
  id: string;
  fileId: number;
  userId: number;
  deviceId: string;
  dir: string;
  absPath: string;
  mode: SessionMode;
  videoStreamIndex: number;
  audioStreamIndex: number | null;
  audioNeedsTranscode: boolean;
  burnInSubtitleStreamIndex: number | null;
  hdrFormat: string | null;
  sourceHeight: number | null;
  duration: number;
  boundaries: number[];
  playlist: string;
  currentStartNumber: number;
  proc: ChildProcess | null;
  /** The one in-flight kill+reseek, if any — see respawnSerialized. */
  respawning: Promise<void> | null;
  /** Set the moment the session is torn down: an in-flight request holding a
   *  stale reference must never respawn ffmpeg into a directory being removed. */
  destroyed: boolean;
  stderrTail: string;
  createdAt: number;
  lastAccess: number;
}

const sessions = new Map<string, Session>();
const deviceSessions = new Map<string, string>(); // `${userId}:${deviceId}` -> sessionId

// ---------------------------------------------------------------------------
// Keyframe indexing (remux boundary source of truth), cached on media_files.
// ---------------------------------------------------------------------------

function indexKeyframes(absPath: string): Promise<number[] | null> {
  return new Promise((resolve) => {
    const { ffprobePath } = getConfig();
    const args = ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0", absPath];
    let proc;
    try {
      proc = spawn(/*turbopackIgnore: true*/ ffprobePath, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      log.warn("failed to spawn ffprobe for keyframe indexing", { message: error instanceof Error ? error.message : String(error) });
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    const MAX_BYTES = 8 * 1024 * 1024;
    let settled = false;
    const finish = (result: number[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };
    const killTimer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(null);
    }, KEYFRAME_INDEX_TIMEOUT_MS);
    proc.stdout.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_BYTES) {
        // NEVER truncate: a cut-off CSV still parses as valid numbers, and the
        // incomplete index would be persisted to media_files.keyframes forever
        // — wrong HLS segment boundaries near the end of the file with no
        // self-repair. Kill and report "no index" instead (same posture as
        // frameExtract's stdout cap).
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
      const times = Buffer.concat(chunks)
        .toString("utf8")
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0);
      finish(times.length ? times : null);
    });
  });
}

/** In-flight indexing runs by fileId — N rapid session creations for the same
 *  big (not yet indexed) file must share ONE full-file ffprobe, not fork N of
 *  them: the maxTranscodeSessions cap doesn't bound ffprobe processes. Same
 *  model as subtitles.ts's in-flight VTT extraction map. Exported for tests. */
const keyframeIndexInFlight = new Map<number, Promise<number[] | null>>();

export function indexKeyframesForFile(fileId: number, absPath: string): Promise<number[] | null> {
  const pending = keyframeIndexInFlight.get(fileId);
  if (pending) return pending;
  const promise = indexKeyframes(absPath).finally(() => {
    keyframeIndexInFlight.delete(fileId);
  });
  keyframeIndexInFlight.set(fileId, promise);
  return promise;
}

function persistKeyframes(fileId: number, keyframes: number[]): void {
  try {
    getDb().prepare("UPDATE media_files SET keyframes = ? WHERE id = ?").run(JSON.stringify(keyframes), fileId);
  } catch {
    // best-effort cache — a future session just re-indexes
  }
}

function getEmbeddedSubtitleStreamIndex(subtitleId: number): number | null {
  const row = getDb().prepare("SELECT stream_index, source FROM subtitles WHERE id = ?").get(subtitleId) as
    | { stream_index: number | null; source: string }
    | undefined;
  if (!row || row.source !== "embedded" || row.stream_index === null) return null;
  return row.stream_index;
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

let ffmpegProbe: Promise<boolean> | undefined;

/** Memoised "does the configured ffmpeg binary actually run?" probe (model:
 *  frameExtract's hasZscale). A misconfigured FFMPEG_PATH only surfaces as an
 *  ASYNC spawn ENOENT, so without this createSession would happily answer
 *  ok:true for a session whose ffmpeg can never start. Probed once per
 *  process — /api/health and createSession both await the same promise. */
export function probeFfmpegAvailable(): Promise<boolean> {
  if (ffmpegProbe) return ffmpegProbe;
  ffmpegProbe = new Promise<boolean>((resolve) => {
    const { ffmpegPath } = getConfig();
    let proc;
    try {
      proc = spawn(/*turbopackIgnore: true*/ ffmpegPath, ["-version"], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
  return ffmpegProbe;
}

function isProcessAlive(session: Session): boolean {
  return !!session.proc && session.proc.exitCode === null && session.proc.signalCode === null;
}

function killProc(session: Session): void {
  const proc = session.proc;
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  session.proc = null;
}

async function spawnForSession(session: Session, opts: { startNumber: number; seekTo: number | null }): Promise<void> {
  session.currentStartNumber = opts.startNumber;
  const { ffmpegPath, maxTranscodeHeight } = getConfig();

  let args: string[];
  if (session.mode === "remux") {
    args = buildRemuxArgs({
      absPath: session.absPath,
      videoStreamIndex: session.videoStreamIndex,
      audioStreamIndex: session.audioStreamIndex,
      audioNeedsTranscode: session.audioNeedsTranscode,
      startNumber: opts.startNumber,
      seekTo: opts.seekTo,
      dir: session.dir,
    });
  } else {
    const zscaleAvailable = await hasZscale();
    const targetHeight = Math.min(maxTranscodeHeight, session.sourceHeight ?? maxTranscodeHeight);
    args = buildTranscodeArgs({
      absPath: session.absPath,
      videoStreamIndex: session.videoStreamIndex,
      audioStreamIndex: session.audioStreamIndex,
      audioNeedsTranscode: session.audioNeedsTranscode,
      targetHeight,
      sourceHeight: session.sourceHeight,
      hdrFormat: session.hdrFormat,
      zscaleAvailable,
      burnInSubtitleStreamIndex: session.burnInSubtitleStreamIndex,
      startNumber: opts.startNumber,
      seekTo: opts.seekTo,
      dir: session.dir,
    });
  }

  let proc: ChildProcess;
  try {
    proc = spawn(/*turbopackIgnore: true*/ ffmpegPath, args, { cwd: session.dir, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    log.warn("failed to spawn ffmpeg session", { sessionId: session.id, message: error instanceof Error ? error.message : String(error) });
    session.proc = null;
    return;
  }
  if (typeof proc.pid === "number") {
    try {
      os.setPriority(proc.pid, LOW_PRIORITY);
    } catch {
      // niceness isn't available/permitted on every platform — best effort
    }
  }
  proc.stderr?.on("data", (chunk: Buffer) => {
    session.stderrTail = (session.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  proc.on("error", (err) => log.warn("ffmpeg session process error", { sessionId: session.id, message: err.message }));
  proc.on("exit", (code, signal) => log.info("ffmpeg session process exited", { sessionId: session.id, code, signal }));
  session.proc = proc;
}

async function respawnAt(session: Session, targetSegmentIndex: number): Promise<void> {
  if (session.destroyed) return;
  killProc(session);
  const seekTo = session.boundaries[targetSegmentIndex] ?? 0;
  await spawnForSession(session, { startNumber: targetSegmentIndex, seekTo });
}

/** Kill + reseek, serialised per session: two concurrent segment requests must
 *  never both fire respawnAt — the second would SIGKILL the ffmpeg the first
 *  had just spawned, leaving both requests polling a dead directory until the
 *  20s deadline (a guaranteed 504). A caller that finds a respawn already in
 *  flight waits it out, then re-checks `stillNeeded()` against the fresh
 *  process state — usually the first respawn already covers its segment (a
 *  player requests adjacent segments after a seek) and no second kill is
 *  needed at all. */
async function respawnSerialized(session: Session, targetSegmentIndex: number, stillNeeded: () => boolean): Promise<void> {
  if (session.destroyed) return;
  while (session.respawning) await session.respawning;
  if (session.destroyed || !stillNeeded()) return;
  // Everything between the loop exit and this assignment is synchronous, so no
  // concurrent request can slip its own respawn in between.
  const inFlight = respawnAt(session, targetSegmentIndex).finally(() => {
    if (session.respawning === inFlight) session.respawning = null;
  });
  session.respawning = inFlight;
  await inFlight;
}

// ---------------------------------------------------------------------------
// Session creation / teardown
// ---------------------------------------------------------------------------

export interface CreateSessionParams {
  fileId: number;
  userId: number;
  deviceId: string;
  caps: ClientCaps;
  audioIdx?: number;
  subtitleId?: number;
}

export type CreateSessionResult =
  | { ok: true; mode: "direct"; url: string }
  | { ok: true; mode: SessionMode; id: string; playlistUrl: string }
  | { ok: false; status: number; error: string };

export async function createSession(params: CreateSessionParams): Promise<CreateSessionResult> {
  // Must complete before ANY session directory can be created in this process
  // — see ensureBootPurge's doc comment for why this ordering is what makes
  // the boot-time purge safe for a session that's already live.
  await ensureBootPurge();

  const decision = decide(params.fileId, params.caps, { audioIdx: params.audioIdx, subtitleId: params.subtitleId });
  if (!decision) return { ok: false, status: 404, error: "Fichier introuvable" };
  if (decision.mode === "direct") return { ok: true, mode: "direct", url: decision.url ?? `/api/stream/${params.fileId}` };

  // Direct play never depends on ffmpeg (the check above already returned) —
  // but remux/transcode can't exist without it, and a spawn ENOENT is an async
  // event createSession would otherwise never see: fail loud and diagnosable
  // instead of answering ok:true for a session that can never produce a byte.
  if (!(await probeFfmpegAvailable())) {
    return { ok: false, status: 503, error: "ffmpeg est introuvable ou non exécutable sur le serveur — vérifiez FFMPEG_PATH ; seule la lecture directe est disponible" };
  }

  const info = getFileStreamsForPlayback(params.fileId);
  if (!info || !info.video) return { ok: false, status: 422, error: "Aucun flux vidéo exploitable pour ce fichier" };
  // A zero/unknown duration (partial probe) would make computeSegmentBoundaries
  // return [0, 0]: a "valid" one-segment VOD playlist that plays ~4s then
  // stops, with no error a client can act on. Refuse up front instead.
  if (!(info.duration > 0)) {
    return { ok: false, status: 422, error: "Durée du fichier inconnue — relancez une analyse de la bibliothèque" };
  }

  // Replacing this device's existing session BEFORE the capacity check means a
  // page reload / video switch on the same device never eats into the cap —
  // only genuinely new concurrent (user, device) pairs do.
  const deviceKey = `${params.userId}:${params.deviceId}`;
  const previousId = deviceSessions.get(deviceKey);
  if (previousId) destroySessionInternal(previousId);

  if (sessions.size >= getConfig().maxTranscodeSessions && !evictStalestDeadSession()) {
    return { ok: false, status: 429, error: "Trop de sessions de lecture actives — réessayez dans un instant" };
  }

  const id = crypto.randomUUID();
  const dir = path.join(getConfig().transcodeDir, id);

  const audioTrack = decision.audioTracks.find((t) => t.streamIndex === decision.audioStreamIndex);
  // Re-encode the audio when the client can't decode it OR when it can't be
  // copied into fMP4 (e.g. FLAC/DTS/TrueHD/PCM/Vorbis): copying the latter
  // aborts ffmpeg and playback fails with "Impossible de lire cette vidéo".
  // This is MODE-INDEPENDENT — both remux and transcode emit the same fMP4 HLS
  // container, so the copyability + client-decodability constraint is identical;
  // gating it on remux-only would let a transcode session (e.g. a 4K HEVC remux
  // that fell back to transcode) `-c:a copy` a non-copyable codec and abort.
  const audioNeedsTranscode = !!audioTrack && (!audioTrack.supported || !isRemuxCopyableAudio(audioTrack.codec));
  const burnInSubtitleStreamIndex = decision.requiresBurnIn && decision.subtitleId !== null ? getEmbeddedSubtitleStreamIndex(decision.subtitleId) : null;

  // The capacity slot is reserved SYNCHRONOUSLY, before the first await below
  // — path resolution and keyframe indexing (up to 60s) would otherwise let N
  // concurrent requests all pass the `sessions.size` check above before any of
  // them registered. The still-starting session is unreachable from outside
  // (its id isn't returned until startup completes) and is rolled back from
  // the maps on any startup failure.
  const session: Session = {
    id,
    fileId: params.fileId,
    userId: params.userId,
    deviceId: params.deviceId,
    dir,
    absPath: "", // resolved below, before anything reads it
    mode: decision.mode,
    videoStreamIndex: info.video.streamIndex,
    audioStreamIndex: decision.audioStreamIndex,
    audioNeedsTranscode,
    burnInSubtitleStreamIndex,
    hdrFormat: info.video.hdrFormat,
    sourceHeight: info.video.height,
    duration: info.duration,
    boundaries: [0, 0], // computed below (remux needs the keyframe index first)
    playlist: "",
    currentStartNumber: 0,
    proc: null,
    respawning: null,
    destroyed: false,
    stderrTail: "",
    createdAt: Date.now(),
    lastAccess: Date.now(),
  };
  sessions.set(id, session);
  deviceSessions.set(deviceKey, id);

  try {
    const absPath = await resolveRealLibraryPath(info.filepath);
    if (!absPath) {
      destroySessionInternal(id);
      return { ok: false, status: 404, error: "Fichier introuvable" };
    }
    session.absPath = absPath;

    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

    let keyframes = info.keyframes;
    if (decision.mode === "remux" && !keyframes) {
      keyframes = await indexKeyframesForFile(params.fileId, absPath);
      if (keyframes) persistKeyframes(params.fileId, keyframes);
    }

    session.boundaries = computeSegmentBoundaries(info.duration, decision.mode === "remux" ? keyframes : null);
    session.playlist = buildPlaylist(session.boundaries);

    await spawnForSession(session, { startNumber: 0, seekTo: null });
  } catch (error) {
    destroySessionInternal(id);
    throw error;
  }

  // A concurrent createSession for the same (user, device) may have replaced
  // this reservation while it was still starting — its ffmpeg must not be left
  // running against a session that no longer exists in the maps.
  if (sessions.get(id) !== session) {
    killProc(session);
    void removeDir(session.dir);
    return { ok: false, status: 409, error: "Session remplacée par une demande de lecture plus récente" };
  }

  ensureSweep();

  log.info("playback session created", { sessionId: id, fileId: params.fileId, mode: decision.mode });
  return { ok: true, mode: decision.mode, id, playlistUrl: `/api/play/session/${id}/stream.m3u8` };
}

/** At capacity, a session whose ffmpeg was already idle-killed (60s) still
 *  holds a slot until the 5-minute purge — reclaim the least recently accessed
 *  such corpse instead of 429-ing a live request over it. Returns true when a
 *  slot was freed. Deliberately never touches a session that is still starting
 *  up, mid-respawn, or was accessed within the idle-kill window (its segments
 *  may still be actively served from disk after a fast remux run completed). */
function evictStalestDeadSession(): boolean {
  const now = Date.now();
  let stalest: Session | null = null;
  for (const [, s] of sessions) {
    if (isProcessAlive(s) || s.respawning || now - s.lastAccess <= IDLE_KILL_MS) continue;
    if (!stalest || s.lastAccess < stalest.lastAccess) stalest = s;
  }
  if (!stalest) return false;
  log.info("capacity reached — evicting idle session with a dead process", { sessionId: stalest.id, idleMs: now - stalest.lastAccess });
  destroySessionInternal(stalest.id);
  return true;
}

async function removeDir(dir: string): Promise<void> {
  // Best-effort with a couple of retries — a segment file can still be mid-write
  // for a brief moment right after the kill signal (or held open on Windows).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

function destroySessionInternal(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.destroyed = true;
  killProc(session);
  sessions.delete(id);
  for (const [key, sid] of deviceSessions) {
    if (sid === id) deviceSessions.delete(key);
  }
  void removeDir(session.dir);
}

/** Destroy a session — only its owner may. Returns false if it doesn't exist
 *  or belongs to someone else (never distinguishes the two to the caller). */
export function destroySession(id: string, userId: number): boolean {
  const session = sessions.get(id);
  if (!session || session.userId !== userId) return false;
  destroySessionInternal(id);
  log.info("playback session destroyed", { sessionId: id });
  return true;
}

/** Look up a session, scoped to its owner — every segment/playlist request
 *  goes through this so a session can never be read cross-account. */
export function getOwnedSession(id: string, userId: number): Session | null {
  const session = sessions.get(id);
  if (!session || session.userId !== userId) return null;
  return session;
}

export function getActiveSessionCount(): number {
  return sessions.size;
}

// ---------------------------------------------------------------------------
// Asset serving (playlist / init segment / media segments), including the
// wait-or-reseek logic that makes arbitrary seeking work.
// ---------------------------------------------------------------------------

function currentMaxProducedIndex(session: Session): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(session.dir);
  } catch {
    return session.currentStartNumber - 1;
  }
  const produced: number[] = [];
  for (const entry of entries) {
    const m = /^seg(\d{5})\.m4s$/.exec(entry);
    if (m) produced.push(Number(m[1]));
  }
  return contiguousMaxProducedIndex(produced, session.currentStartNumber);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A produced HLS asset is only servable once it is NON-EMPTY on disk. Segments
 *  are written atomically (`-hls_flags temp_file` renames a fully written
 *  `.tmp` into place — see hlsOutputArgs), so they are never observed at 0
 *  bytes. init.mp4 is NOT covered by that flag, though: ffmpeg's fMP4 muxer
 *  creates the init file up front but only writes its ftyp+moov once it has
 *  parsed enough input to know the track layout — so init.mp4 sits present-but-
 *  empty for the first few hundred ms of a session. Serving it in that window
 *  hands hls.js a zero-byte initialization segment and playback dies before the
 *  first frame (the whole remux/transcode library becomes unplayable). Gating
 *  on size > 0 waits that window out for init.mp4 while staying a no-op for the
 *  already-atomic segments. */
function assetReady(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

export type SessionAsset = { kind: "playlist"; body: string } | { kind: "file"; path: string } | { kind: "timeout" } | { kind: "not-found" };

/** Resolve one requested asset name (already validated against
 *  SEGMENT_NAME_RE by the route) to something servable. Segments beyond the
 *  live process's near-term production horizon — or requested while the
 *  process is dead — trigger a kill + reseek before polling for the file. */
export async function getSessionAsset(session: Session, filename: string): Promise<SessionAsset> {
  if (session.destroyed) return { kind: "not-found" };
  session.lastAccess = Date.now();
  if (!SEGMENT_NAME_RE.test(filename)) return { kind: "not-found" };
  if (filename === "stream.m3u8") return { kind: "playlist", body: session.playlist };

  const filePath = path.join(session.dir, filename);
  if (assetReady(filePath)) return { kind: "file", path: filePath };

  if (filename === "init.mp4") {
    // A dead process that never wrote its init segment (spawn failure, or a
    // crash right after starting) would otherwise just poll out the full 20s
    // below and 504 — give it ONE restart from the beginning instead. An init
    // that exists but is still empty (ffmpeg hasn't flushed ftyp+moov yet) is
    // NOT a reason to restart — a live process is about to fill it — so this
    // keys off assetReady + liveness, not mere existence.
    const needsRestart = () => !assetReady(filePath) && !isProcessAlive(session);
    if (needsRestart()) await respawnSerialized(session, 0, needsRestart);
    const deadline = Date.now() + SEGMENT_WAIT_MS;
    while (Date.now() < deadline) {
      if (session.destroyed) return { kind: "not-found" };
      if (assetReady(filePath)) return { kind: "file", path: filePath };
      if (!isProcessAlive(session)) break;
      await sleep(SEGMENT_POLL_MS);
    }
    return assetReady(filePath) ? { kind: "file", path: filePath } : { kind: "timeout" };
  }

  const match = /^seg(\d{5})\.m4s$/.exec(filename);
  const idx = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(idx) || idx < 0 || idx >= session.boundaries.length - 1) return { kind: "not-found" };

  const needsRespawn = () => !isProcessAlive(session) || idx < session.currentStartNumber || idx > currentMaxProducedIndex(session) + PRODUCTION_HORIZON;
  if (needsRespawn()) {
    log.info("segment beyond production horizon — reseeking ffmpeg", { sessionId: session.id, requested: idx, currentStartNumber: session.currentStartNumber });
    await respawnSerialized(session, idx, needsRespawn);
  }

  const deadline = Date.now() + SEGMENT_WAIT_MS;
  while (Date.now() < deadline) {
    if (session.destroyed) return { kind: "not-found" };
    if (assetReady(filePath)) return { kind: "file", path: filePath };
    // A dead process (ENOSPC, corrupt source, failed respawn) will never write
    // this segment — polling out the full deadline would just turn every
    // request into a guaranteed 20s 504. Same model as the init.mp4 loop above;
    // an in-flight respawn is about to bring a fresh process, so keep waiting.
    if (!isProcessAlive(session) && !session.respawning) break;
    await sleep(SEGMENT_POLL_MS);
  }
  // One last look — the process may have written the segment (or died) between
  // the final check and the break.
  return assetReady(filePath) ? { kind: "file", path: filePath } : { kind: "timeout" };
}

// ---------------------------------------------------------------------------
// Idle cleanup + global teardown
// ---------------------------------------------------------------------------

let sweepTimer: NodeJS.Timeout | null = null;

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

function sweep(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const idle = now - session.lastAccess;
    if (idle > IDLE_PURGE_MS) {
      log.info("session idle beyond purge threshold — removing", { sessionId: id, idleMs: idle });
      destroySessionInternal(id);
      continue;
    }
    if (idle > IDLE_KILL_MS && isProcessAlive(session)) {
      log.info("session idle beyond kill threshold — stopping ffmpeg (segments kept for a quick resume)", { sessionId: id, idleMs: idle });
      killProc(session);
    }
  }
}

/** Kill and remove every session belonging to one user — called on logout so
 *  signing out never leaves that user's own ffmpeg session running behind
 *  them. Deliberately scoped to the one user (unlike killAllSessions): a
 *  multi-profile household must not have one profile's logout interrupt
 *  another profile's active stream. */
export function killSessionsForUser(userId: number): void {
  for (const [id, session] of sessions) {
    if (session.userId === userId) destroySessionInternal(id);
  }
}

/** Kill every live ffmpeg session process. Called from db.ts's graceful
 *  shutdown hook and from logout, so a restart or a sign-out never leaves an
 *  orphaned encoder running. Directory removal is best-effort/fire-and-forget
 *  (a process shutdown must not block on filesystem I/O); purgeTranscodeDir()
 *  sweeps anything left behind on the next boot. */
export function killAllSessions(): void {
  // Doesn't go through destroySessionInternal (bulk teardown skips per-id map
  // scans), so the destroyed flag is set here too — same stale-reference
  // respawn guard.
  for (const [, session] of sessions) {
    session.destroyed = true;
    killProc(session);
    void removeDir(session.dir);
  }
  sessions.clear();
  deviceSessions.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Wipe the whole transcode scratch directory — run once at boot so a crash
 *  (or a kill -9 of the whole process, which skips the graceful shutdown hook)
 *  never leaves stale session directories accumulating on disk forever. Never
 *  touches a directory that belongs to a session already tracked in THIS
 *  process's `sessions` map — belt-and-braces on top of the ordering
 *  guarantee in {@link ensureBootPurge} (createSession always awaits the boot
 *  purge before creating its own directory), so a slow first request can
 *  never race a live session's on-disk segments out from under it. */
export async function purgeTranscodeDir(): Promise<void> {
  const { transcodeDir } = getConfig();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(transcodeDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => !sessions.has(name))
      .map((name) => fs.promises.rm(path.join(transcodeDir, name), { recursive: true, force: true }).catch(() => {})),
  );
}

let bootPurge: Promise<void> | null = null;

/** Memoised entry point for the boot-time purge — whichever fires first
 *  (a library scan/read touching bootstrap.ts, or the very first playback
 *  session) runs it exactly once; every other caller (including every later
 *  createSession call) just awaits the same settled promise. This is what
 *  makes the purge race-free: createSession() awaits this BEFORE creating its
 *  own directory, so by construction no session directory exists yet the one
 *  time entries actually get deleted. */
export function ensureBootPurge(): Promise<void> {
  if (!bootPurge) bootPurge = purgeTranscodeDir();
  return bootPurge;
}
