// Resumable, chunked upload session manager. State lives entirely on disk under
// `<mediaDir>/.flix-uploads/` — a dot-directory the scanner and watcher both
// ignore, and on the SAME filesystem as the final target so finalize is an
// atomic rename. Each session is a `<uploadId>.part` data file plus a
// `<uploadId>.json` sidecar; the in-memory Map is a pure cache that can always
// be rebuilt from the sidecars, so a dev-server reload or a process restart
// resumes an in-flight upload cleanly.
//
// Every filesystem path is derived from a validated UUID and joined under the
// uploads dir, so nothing a caller supplies can escape it.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { getConfig } from "../config";
import { resolveLibraryPath } from "../paths";
import { createLogger } from "../logger";
import { VIDEO_EXTENSIONS } from "@/lib/flix/videoFormats";
import { movieTargetRel, episodeTargetRel, renameOnConflict } from "./targets";

const log = createLogger("upload");

const UPLOAD_DIR_NAME = ".flix-uploads";
const DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024; // 64 MiB
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024 * 1024; // 100 GiB
const FREE_SPACE_SLACK = 1024 * 1024 * 1024; // keep at least 1 GiB free
const CHUNK_SLACK = 64 * 1024; // tolerance over the advertised chunk size
const MAX_ACTIVE_SESSIONS = 3;
const STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const VIDEO_EXT_SET = new Set<string>(VIDEO_EXTENSIONS);
// crypto.randomUUID() shape — used to gate every id before it touches a path.
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown by every operation below; `status` maps straight onto an HTTP code and
 *  `message` is a ready-to-surface French string. `received` rides along on the
 *  offset-mismatch 409 so the route can hand the client the authoritative
 *  resume point. */
export class UploadError extends Error {
  readonly status: number;
  readonly received?: number;
  constructor(status: number, message: string, received?: number) {
    super(message);
    this.name = "UploadError";
    this.status = status;
    this.received = received;
  }
}

export type UploadDestination =
  | { kind: "movie"; title: string; year: number | null }
  | { kind: "episode"; show: string; showYear: number | null; season: number };

interface UploadSession {
  uploadId: string;
  targetRel: string;
  size: number;
  received: number;
  filename: string;
  createdAt: number;
  updatedAt: number;
}

export interface UploadSessionInfo {
  uploadId: string;
  filename: string;
  targetRel: string;
  size: number;
  received: number;
  updatedAt: number;
}

// Pure cache over the sidecars — never the source of truth.
const sessions = new Map<string, UploadSession>();

// --- path helpers (everything stays under <mediaDir>/.flix-uploads) ----------

function uploadsDir(): string {
  return path.join(getConfig().mediaDir, UPLOAD_DIR_NAME);
}
function partPath(id: string): string {
  return path.join(uploadsDir(), `${id}.part`);
}
function sidecarPath(id: string): string {
  return path.join(uploadsDir(), `${id}.json`);
}
function validId(id: unknown): id is string {
  return typeof id === "string" && UPLOAD_ID_RE.test(id);
}

// --- config knobs ------------------------------------------------------------

function configuredChunkSize(): number {
  const n = Number.parseInt(process.env.FLIX_UPLOAD_CHUNK_BYTES ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CHUNK_BYTES;
}
function configuredMaxBytes(): number {
  const n = Number.parseInt(process.env.FLIX_UPLOAD_MAX_BYTES ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

// --- sidecar persistence -----------------------------------------------------

function isSession(value: unknown): value is UploadSession {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.uploadId === "string" &&
    typeof s.targetRel === "string" &&
    typeof s.size === "number" &&
    typeof s.received === "number" &&
    typeof s.filename === "string" &&
    typeof s.createdAt === "number" &&
    typeof s.updatedAt === "number"
  );
}

function loadSidecar(id: string): UploadSession | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarPath(id), "utf8")) as unknown;
    return isSession(parsed) && parsed.uploadId === id ? parsed : null;
  } catch {
    return null;
  }
}

function writeSidecar(session: UploadSession): void {
  fs.writeFileSync(sidecarPath(session.uploadId), JSON.stringify(session, null, 2));
}

/** Read a session from memory, rehydrating from its sidecar on a miss. */
function getSession(id: string): UploadSession | null {
  if (!validId(id)) return null;
  const cached = sessions.get(id);
  if (cached) return cached;
  const disk = loadSidecar(id);
  if (disk) sessions.set(id, disk);
  return disk;
}

// --- capability probe --------------------------------------------------------

/**
 * Real write probe on the uploads dir plus a free-space read. `writable:false`
 * on any ENxxx/EROFS (read-only media dir); `freeBytes:null` when statfs can't
 * be read (some network filesystems). `chunkSize` is what clients must use.
 */
export async function checkUploadCapability(): Promise<{ writable: boolean; freeBytes: number | null; chunkSize: number }> {
  const chunkSize = configuredChunkSize();
  const dir = uploadsDir();

  let writable = false;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${crypto.randomBytes(6).toString("hex")}`);
    await fs.promises.writeFile(probe, "");
    await fs.promises.unlink(probe);
    writable = true;
  } catch {
    writable = false;
  }

  let freeBytes: number | null = null;
  try {
    const stat = await fs.promises.statfs(getConfig().mediaDir);
    freeBytes = Number(stat.bavail) * Number(stat.bsize);
  } catch {
    freeBytes = null;
  }

  return { writable, freeBytes, chunkSize };
}

// --- listing -----------------------------------------------------------------

/** Rebuild the live session list from the sidecars on disk (survives a
 *  restart). Non-UUID or unparsable sidecars are ignored. */
export function listUploads(): UploadSessionInfo[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(uploadsDir());
  } catch {
    return [];
  }
  const out: UploadSessionInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!validId(id)) continue;
    const s = getSession(id);
    if (s) out.push({ uploadId: s.uploadId, filename: s.filename, targetRel: s.targetRel, size: s.size, received: s.received, updatedAt: s.updatedAt });
  }
  return out;
}

/** Resume point for a single session, or null if unknown. */
export function getUploadStatus(id: string): { uploadId: string; received: number; size: number; targetRel: string } | null {
  const s = getSession(id);
  if (!s) return null;
  return { uploadId: s.uploadId, received: s.received, size: s.size, targetRel: s.targetRel };
}

// --- init --------------------------------------------------------------------

export async function initUpload(input: {
  filename: string;
  size: number;
  destination: UploadDestination;
  conflict?: "rename" | "reject";
}): Promise<{ uploadId: string; chunkSize: number; received: number; targetRel: string }> {
  const filename = typeof input.filename === "string" ? input.filename : "";
  const size = Number(input.size);
  if (!Number.isInteger(size) || size <= 0) throw new UploadError(400, "Taille de fichier invalide");

  const ext = path.extname(filename).toLowerCase();
  if (!VIDEO_EXT_SET.has(ext)) throw new UploadError(400, "Type de fichier non pris en charge");

  const capability = await checkUploadCapability();
  if (!capability.writable) throw new UploadError(500, "Le dossier médias est en lecture seule — téléversement impossible");
  if (capability.freeBytes !== null && capability.freeBytes <= size + FREE_SPACE_SLACK) {
    throw new UploadError(507, "Espace disque insuffisant");
  }
  if (size > configuredMaxBytes()) throw new UploadError(413, "Fichier trop volumineux");
  if (listUploads().length >= MAX_ACTIVE_SESSIONS) throw new UploadError(429, "Trop de téléversements simultanés");

  let targetRel: string;
  try {
    targetRel =
      input.destination.kind === "movie"
        ? movieTargetRel(input.destination.title, input.destination.year, ext)
        : episodeTargetRel(input.destination.show, input.destination.showYear, input.destination.season, filename);
  } catch {
    throw new UploadError(400, "Destination invalide");
  }

  let finalAbs = resolveLibraryPath(targetRel);
  if (!finalAbs) throw new UploadError(400, "Chemin cible invalide");

  if (fs.existsSync(finalAbs)) {
    if (input.conflict !== "rename") throw new UploadError(409, "Un fichier existe déjà à cet emplacement");
    finalAbs = renameOnConflict(finalAbs);
    const rel = path.relative(getConfig().mediaDir, finalAbs).split(path.sep).join("/");
    if (!resolveLibraryPath(rel)) throw new UploadError(400, "Chemin cible invalide");
    targetRel = rel;
  }

  await fs.promises.mkdir(uploadsDir(), { recursive: true });
  const uploadId = crypto.randomUUID();
  const now = Date.now();
  const session: UploadSession = { uploadId, targetRel, size, received: 0, filename, createdAt: now, updatedAt: now };

  // Create (truncate) the data file, then persist the sidecar.
  await fs.promises.writeFile(partPath(uploadId), "");
  sessions.set(uploadId, session);
  writeSidecar(session);

  return { uploadId, chunkSize: capability.chunkSize, received: 0, targetRel };
}

// --- append ------------------------------------------------------------------

// Per-session write serialisation. The `offset === session.received` check
// alone is a TOCTOU: two concurrent PUTs carrying the same offset (a buggy
// resume client replaying a chunk still in flight) BOTH pass it, write the
// same region, and `received` gets bumped twice past the real byte count —
// wedging the session in a permanent 409 « Téléversement incomplet » at
// finalize. Chain every append/finalize per uploadId instead; entries are
// dropped once their chain drains so the map stays bounded.
const sessionLocks = new Map<string, Promise<void>>();
function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  sessionLocks.set(id, tail);
  void tail.then(() => {
    if (sessionLocks.get(id) === tail) sessionLocks.delete(id);
  });
  return run;
}

function mapWriteError(err: unknown): UploadError {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC") return new UploadError(507, "Espace disque insuffisant");
  return new UploadError(500, "Échec de l'écriture du bloc");
}

/**
 * Append one chunk at `offset`. The offset MUST equal the session's current
 * `received` (the resumable contract) — otherwise a 409 carrying the
 * authoritative `received` is thrown so the client can re-seek. Bytes are
 * streamed to the `.part` at the given position with backpressure, capped at
 * chunkSize + 64 KiB slack and never allowed past the declared total size.
 */
export function appendChunk(id: string, offset: number, stream: ReadableStream<Uint8Array> | null): Promise<{ received: number }> {
  return withSessionLock(id, () => doAppendChunk(id, offset, stream));
}

async function doAppendChunk(id: string, offset: number, stream: ReadableStream<Uint8Array> | null): Promise<{ received: number }> {
  const session = getSession(id);
  if (!session) throw new UploadError(404, "Session de téléversement introuvable");
  if (!Number.isInteger(offset) || offset < 0) throw new UploadError(400, "Décalage invalide");
  if (offset !== session.received) throw new UploadError(409, "Le décalage ne correspond pas à la position attendue", session.received);
  if (!stream) throw new UploadError(400, "Corps de requête manquant");
  if (session.received >= session.size) return { received: session.received };

  const maxAccept = configuredChunkSize() + CHUNK_SLACK;
  const room = session.size - session.received; // never write past the declared size
  let written = 0;

  await new Promise<void>((resolve, reject) => {
    const ws = fs.createWriteStream(partPath(id), { flags: "r+", start: offset });
    const rs = Readable.fromWeb(stream as unknown as NodeWebReadableStream);
    let settled = false;
    const fail = (err: UploadError) => {
      if (settled) return;
      settled = true;
      rs.destroy();
      ws.destroy();
      reject(err);
    };

    ws.on("error", (err) => fail(mapWriteError(err)));
    rs.on("error", () => fail(new UploadError(400, "Échec de la lecture du flux")));
    ws.on("finish", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });

    rs.on("data", (chunk: Buffer) => {
      if (settled) return;
      written += chunk.length;
      if (written > maxAccept || written > room) {
        fail(new UploadError(413, "Bloc trop volumineux"));
        return;
      }
      if (!ws.write(chunk)) {
        rs.pause();
        ws.once("drain", () => {
          if (!settled) rs.resume();
        });
      }
    });
    rs.on("end", () => {
      if (!settled) ws.end();
    });
  });

  session.received += written;
  session.updatedAt = Date.now();
  sessions.set(id, session);
  writeSidecar(session);
  return { received: session.received };
}

// --- finalize ----------------------------------------------------------------

/**
 * Move a fully-received `.part` into its final library location. Requires
 * received === size (and the on-disk size to agree). Creates the parent
 * movies/… or shows/… tree, does an atomic rename (EXDEV → copy-then-rename
 * fallback), drops the sidecar, and fires a background rescan.
 */
export function finalizeUpload(id: string): Promise<{ rel: string }> {
  return withSessionLock(id, () => doFinalizeUpload(id));
}

async function doFinalizeUpload(id: string): Promise<{ rel: string }> {
  const session = getSession(id);
  if (!session) throw new UploadError(404, "Session de téléversement introuvable");

  let onDisk: number;
  try {
    onDisk = (await fs.promises.stat(partPath(id))).size;
  } catch {
    throw new UploadError(404, "Fichier de téléversement introuvable");
  }
  if (session.received !== session.size || onDisk !== session.size) {
    throw new UploadError(409, "Téléversement incomplet", session.received);
  }

  let finalAbs = resolveLibraryPath(session.targetRel);
  if (!finalAbs) throw new UploadError(400, "Chemin cible invalide");

  // The init-time existence check is HOURS stale by now (a TOCTOU spanning the
  // whole upload): a file dropped/imported at the same path meanwhile — or a
  // second session initialised for the same title before either finalized —
  // would be silently OVERWRITTEN by the rename below. Re-check and divert to
  // the same "(n)" sibling init uses; rejecting instead would throw away a
  // fully-received multi-GB .part.
  if (fs.existsSync(finalAbs)) {
    finalAbs = renameOnConflict(finalAbs);
    const rel = path.relative(getConfig().mediaDir, finalAbs).split(path.sep).join("/");
    if (!resolveLibraryPath(rel)) throw new UploadError(400, "Chemin cible invalide");
    session.targetRel = rel;
  }

  await fs.promises.mkdir(path.dirname(finalAbs), { recursive: true });

  const part = partPath(id);
  try {
    await fs.promises.rename(part, finalAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "EXDEV") {
      // Different filesystem: copy to a sibling `.part` temp (watcher-ignored),
      // atomically rename it into place, then drop the source.
      const tmp = `${finalAbs}.part`;
      await fs.promises.copyFile(part, tmp);
      await fs.promises.rename(tmp, finalAbs);
      await fs.promises.unlink(part).catch(() => {});
    } else {
      throw mapWriteError(err);
    }
  }

  await fs.promises.unlink(sidecarPath(id)).catch(() => {});
  sessions.delete(id);

  // Fire-and-forget rescan so the new file is indexed without blocking the
  // response (mirrors the void runScan() pattern the source route uses).
  void import("../library/scanner")
    .then((m) => m.runScan())
    .catch((err) => log.warn("post-upload rescan failed", { message: err instanceof Error ? err.message : String(err) }));

  return { rel: session.targetRel };
}

// --- abort / cleanup ---------------------------------------------------------

/** Best-effort teardown: unlink both files and forget the session. */
export async function abortUpload(id: string): Promise<void> {
  if (!validId(id)) return;
  await fs.promises.unlink(partPath(id)).catch(() => {});
  await fs.promises.unlink(sidecarPath(id)).catch(() => {});
  sessions.delete(id);
}

/** Reap sessions whose sidecar hasn't been touched in `maxAgeMs` (abandoned
 *  uploads). Best-effort; never throws. */
export async function cleanupStaleUploads(maxAgeMs = STALE_MAX_AGE_MS): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(uploadsDir());
  } catch {
    return; // uploads dir doesn't exist yet — nothing to reap
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!validId(id)) continue;
    const s = loadSidecar(id);
    if (!s) continue;
    if (now - s.updatedAt > maxAgeMs) {
      await fs.promises.unlink(partPath(id)).catch(() => {});
      await fs.promises.unlink(sidecarPath(id)).catch(() => {});
      sessions.delete(id);
    }
  }
}
