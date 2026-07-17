// Background poster/backdrop/thumb/logo extraction — runs once, fire-and-forget,
// at the end of every scan (see scanner.ts's dynamic import at the bottom of
// runScan()). Walks every media_files row still marked `images_at = 0`, and for
// each resolves the richest available source for every image kind it's
// missing: a Kodi-style sidecar file > an embedded cover (attached_pic stream)
// > a generated frame, in that priority order, then back-fills the matching
// *_hash column on the owning movie/show/season/episode. Mirrors the shape of
// /home/pc/Documents/auralis_enterprise_grade/src/server/library/analysis.ts's
// runAnalysis(): idempotent, self-throttling, reports through the scanner's
// progress channel, and a single bad file can never abort the whole pass.

import path from "path";
import type { Database as DB } from "better-sqlite3";
import { getConfig } from "../config";
import { getDb } from "../db";
import { createLogger } from "../logger";
import { updateScanProgress } from "./scanner";
import { cacheImageBuffer, cacheImageFile, cropToPosterAspect, findSeasonPoster, findSidecarImages, type ImageKind, type ImageSource } from "./images";
import { extractAttachedPic, extractGeneratedFrame, ffmpegWasMissing, resetFfmpegMissing } from "./frameExtract";
import type { HdrFormat } from "./ffprobe";

const log = createLogger("imagesPass");

const CONCURRENCY = 2;
const BACKDROP_FRACTIONS = [0.15, 0.3, 0.45, 0.6];
const BACKDROP_WIDTH = 1280;
const THUMB_WIDTH = 640;
const EPISODE_THUMB_FRACTION = 0.25;
// Poster (2:3) generated from a video frame — the LAST-RESORT offline source
// when a title ships no poster.jpg sidecar and no embedded cover art. Fewer
// candidate seek points than a backdrop (a screenshot poster is a graceful
// stand-in, not a hero image), each centre-cropped to portrait downstream.
const POSTER_FRACTIONS = [0.25, 0.5, 0.75];
const POSTER_WIDTH = 720;
// Progressive reveal: how many files to image between catalogue-version bumps
// during a pass, so a big import surfaces posters in waves instead of all at
// the end. Mirrors store/library.ts's client-side reveal cadence.
const REVEAL_BATCH = 24;

interface PendingFile {
  id: number;
  filepath: string;
  movie_id: number | null;
  episode_id: number | null;
  duration: number;
}

interface VideoStreamRow {
  stream_index: number;
  hdr_format: HdrFormat | null;
  attached_pic: number;
}

function primaryVideoStreams(db: DB, fileId: number): { main: VideoStreamRow | null; cover: VideoStreamRow | null } {
  const rows = db
    .prepare("SELECT stream_index, hdr_format, attached_pic FROM streams WHERE media_file_id = ? AND type = 'video'")
    .all(fileId) as VideoStreamRow[];
  return {
    main: rows.find((r) => !r.attached_pic) ?? null,
    cover: rows.find((r) => r.attached_pic) ?? null,
  };
}

interface ImageFallback {
  /** The fallback's true provenance — an embedded cover extraction and a
   *  generated frame are NOT interchangeable labels, so this must be supplied
   *  by the caller rather than assumed. */
  source: ImageSource;
  generate: () => Promise<Buffer | null>;
}

/** Cache a sidecar-or-fallback image for one *_hash column, trying the
 *  sidecar path first and only falling back to the (usually much costlier)
 *  embedded/generated extraction when no sidecar exists. `fallbacks` are tried
 *  in strict priority order (e.g. embedded cover before a generated frame): the
 *  first that yields bytes AND caches wins. Returns the new hash, or null if no
 *  source produced one. */
async function resolveImage(sidecarPath: string | null, kind: ImageKind, fallbacks: ImageFallback[]): Promise<string | null> {
  if (sidecarPath) {
    const hash = await cacheImageFile(sidecarPath, kind, "sidecar");
    if (hash) return hash;
  }
  for (const fallback of fallbacks) {
    const buf = await fallback.generate();
    if (buf) {
      const hash = await cacheImageBuffer(buf, kind, fallback.source);
      if (hash) return hash;
    }
  }
  return null;
}

/** Ordered poster fallbacks used when a title has no poster sidecar, in strict
 *  priority: an embedded cover (`attached_pic`, real artwork) > a 2:3 crop of
 *  the backdrop frame we already extracted (`backdropFrame`, no extra ffmpeg) >
 *  a dedicated cropped frame extraction. The crop is listed before the
 *  dedicated extraction so the common artwork-less case pays ONE ffmpeg pass
 *  (the backdrop) instead of two; the dedicated extraction stays as the safety
 *  net for when there's no backdrop frame to reuse (sidecar backdrop) or sharp
 *  is unavailable (cropToPosterAspect returns null). Better a screenshot poster
 *  than a blank text tile — the old behaviour left `poster_hash` null forever
 *  for artwork-less files. */
function posterFallbacks(abs: string, cover: VideoStreamRow | null, duration: number, hdrFormat: HdrFormat | null, backdropFrame: Buffer | null): ImageFallback[] {
  const fallbacks: ImageFallback[] = [];
  if (cover) fallbacks.push({ source: "embedded", generate: () => extractAttachedPic(abs, cover.stream_index) });
  if (backdropFrame) fallbacks.push({ source: "generated", generate: () => cropToPosterAspect(backdropFrame) });
  if (duration > 0) {
    fallbacks.push({
      source: "generated",
      generate: () => extractGeneratedFrame(abs, { duration, hdrFormat, fractions: POSTER_FRACTIONS, width: POSTER_WIDTH, poster: true }),
    });
  }
  return fallbacks;
}

/** Ordered fallbacks for a generated landscape frame (episode thumb): a single
 *  scored extraction, or nothing when the file has no usable duration to seek
 *  into. */
function framePassFallbacks(abs: string, duration: number, hdrFormat: HdrFormat | null, fractions: number[], width: number): ImageFallback[] {
  if (!(duration > 0)) return [];
  return [{ source: "generated", generate: () => extractGeneratedFrame(abs, { duration, hdrFormat, fractions, width }) }];
}

/** Resolve a backdrop (sidecar > generated frame) AND hand back the generated
 *  frame buffer when the backdrop came from one, so the poster can be a 2:3 crop
 *  of that same frame instead of a second ffmpeg extraction. `frame` is null for
 *  a sidecar backdrop (nothing extracted) or when no frame could be produced. */
async function resolveBackdrop(sidecarPath: string | null, abs: string, duration: number, hdrFormat: HdrFormat | null): Promise<{ hash: string | null; frame: Buffer | null }> {
  if (sidecarPath) {
    const hash = await cacheImageFile(sidecarPath, "backdrop", "sidecar");
    if (hash) return { hash, frame: null };
  }
  if (duration > 0) {
    const frame = await extractGeneratedFrame(abs, { duration, hdrFormat, fractions: BACKDROP_FRACTIONS, width: BACKDROP_WIDTH });
    if (frame) return { hash: await cacheImageBuffer(frame, "backdrop", "generated"), frame };
  }
  return { hash: null, frame: null };
}

function applyUpdates(db: DB, table: "movies" | "shows" | "seasons" | "episodes", id: number, updates: Record<string, string>): void {
  const keys = Object.keys(updates);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE ${table} SET ${sets} WHERE id = @id`).run({ ...updates, id });
}

interface MovieImageRow {
  poster_hash: string | null;
  backdrop_hash: string | null;
  thumb_hash: string | null;
  logo_hash: string | null;
}

async function processMovieFile(db: DB, file: PendingFile, abs: string): Promise<void> {
  const movieId = file.movie_id;
  if (!movieId) return;
  const row = db.prepare("SELECT poster_hash, backdrop_hash, thumb_hash, logo_hash FROM movies WHERE id = ?").get(movieId) as MovieImageRow | undefined;
  if (!row) return;

  const dir = path.dirname(abs);
  const basename = path.basename(abs, path.extname(abs));
  const sidecars = findSidecarImages(dir, basename);
  const { main, cover } = primaryVideoStreams(db, file.id);
  const updates: Record<string, string> = {};

  // Backdrop first: its generated frame is reused (cropped 2:3) as the poster
  // and (verbatim) as the thumb, so a single ffmpeg extraction feeds all three.
  const backdrop = !row.backdrop_hash
    ? await resolveBackdrop(sidecars.backdrop, abs, file.duration, main?.hdr_format ?? null)
    : { hash: null as string | null, frame: null as Buffer | null };
  if (backdrop.hash) updates.backdrop_hash = backdrop.hash;

  if (!row.poster_hash) {
    const hash = await resolveImage(sidecars.poster, "poster", posterFallbacks(abs, cover, file.duration, main?.hdr_format ?? null, backdrop.frame));
    if (hash) updates.poster_hash = hash;
  }

  // The movie's "thumb" (used for compact continue-watching style cards) is
  // just a smaller rendering of the same backdrop frame — no reason to spend a
  // second ffmpeg extraction generating a near-identical image.
  if (!row.thumb_hash) {
    const backdropHash = updates.backdrop_hash ?? row.backdrop_hash;
    if (backdropHash) updates.thumb_hash = backdropHash;
  }

  if (!row.logo_hash && sidecars.logo) {
    const hash = await cacheImageFile(sidecars.logo, "logo", "sidecar");
    if (hash) updates.logo_hash = hash;
  }

  applyUpdates(db, "movies", movieId, updates);
}

interface EpisodeOwnerRow {
  show_id: number;
  season_id: number;
  season_number: number;
  show_folder: string;
  show_poster_hash: string | null;
  show_backdrop_hash: string | null;
  show_logo_hash: string | null;
  season_poster_hash: string | null;
  episode_thumb_hash: string | null;
}

function getEpisodeOwner(db: DB, episodeId: number): EpisodeOwnerRow | undefined {
  return db
    .prepare(
      `SELECT sh.id AS show_id, se.id AS season_id, se.season_number,
              sh.folder AS show_folder,
              sh.poster_hash AS show_poster_hash, sh.backdrop_hash AS show_backdrop_hash, sh.logo_hash AS show_logo_hash,
              se.poster_hash AS season_poster_hash,
              e.thumb_hash AS episode_thumb_hash
       FROM episodes e
       JOIN seasons se ON se.id = e.season_id
       JOIN shows sh ON sh.id = e.show_id
       WHERE e.id = ?`,
    )
    .get(episodeId) as EpisodeOwnerRow | undefined;
}

async function processEpisodeFile(db: DB, mediaDir: string, file: PendingFile, abs: string): Promise<void> {
  const episodeId = file.episode_id;
  if (!episodeId) return;
  const owner = getEpisodeOwner(db, episodeId);
  if (!owner) return;

  const dir = path.dirname(abs);
  const basename = path.basename(abs, path.extname(abs));
  const showDir = path.join(mediaDir, ...owner.show_folder.split("/").filter(Boolean));
  const { main, cover } = primaryVideoStreams(db, file.id);

  if (!owner.episode_thumb_hash) {
    const sidecarThumb = findSidecarImages(dir, basename).thumb;
    const hash = await resolveImage(sidecarThumb, "thumb", framePassFallbacks(abs, file.duration, main?.hdr_format ?? null, [EPISODE_THUMB_FRACTION], THUMB_WIDTH));
    if (hash) applyUpdates(db, "episodes", episodeId, { thumb_hash: hash });
  }

  if (!owner.season_poster_hash) {
    const sidecar = findSeasonPoster(showDir, owner.season_number) ?? findSidecarImages(dir, null).poster;
    if (sidecar) {
      const hash = await cacheImageFile(sidecar, "poster", "sidecar");
      if (hash) applyUpdates(db, "seasons", owner.season_id, { poster_hash: hash });
    }
  }

  if (owner.show_poster_hash && owner.show_backdrop_hash && owner.show_logo_hash) return;

  const showSidecars = findSidecarImages(showDir, null);
  const showUpdates: Record<string, string> = {};

  // Backdrop first — its generated frame is reused (cropped 2:3) for the show
  // poster below, so an artwork-less show pays one ffmpeg pass, not two.
  const showBackdrop = !owner.show_backdrop_hash
    ? await resolveBackdrop(showSidecars.backdrop, abs, file.duration, main?.hdr_format ?? null)
    : { hash: null as string | null, frame: null as Buffer | null };
  if (showBackdrop.hash) showUpdates.backdrop_hash = showBackdrop.hash;

  if (!owner.show_poster_hash) {
    // Last resort for a show with no tvshow.nfo / poster.jpg at all: this
    // episode's embedded cover, else a 2:3 crop of its backdrop frame — better
    // than a blank tile (posterFallbacks encodes that priority order).
    const hash = await resolveImage(showSidecars.poster, "poster", posterFallbacks(abs, cover, file.duration, main?.hdr_format ?? null, showBackdrop.frame));
    if (hash) showUpdates.poster_hash = hash;
  }
  if (!owner.show_logo_hash && showSidecars.logo) {
    const hash = await cacheImageFile(showSidecars.logo, "logo", "sidecar");
    if (hash) showUpdates.logo_hash = hash;
  }

  applyUpdates(db, "shows", owner.show_id, showUpdates);
}

let running = false;
let pendingRerun = false;

/** Whether a pass is currently in flight — the scanner's cache GC checks this
 *  so it never deletes an image cached between its reference collection and
 *  the *_hash column update that would reference it. */
export function isImagesPassRunning(): boolean {
  return running;
}

/** Extract every still-pending poster/backdrop/thumb/logo. Safe to call
 *  repeatedly — a call landing while a pass is already running is remembered
 *  and replayed once the current pass finishes (files indexed by that second
 *  scan would otherwise wait for a third one), and any single file's failure
 *  (corrupt video, missing ffmpeg, permissions) is logged and skipped rather
 *  than aborting the rest of the pass. */
export async function runImagesPass(): Promise<void> {
  if (running) {
    pendingRerun = true;
    return;
  }

  const db = getDb();
  const pending = db.prepare("SELECT id, filepath, movie_id, episode_id, duration FROM media_files WHERE images_at = 0").all() as PendingFile[];
  if (!pending.length) {
    // Nothing to extract — but the scanner may have optimistically flipped
    // `imaging` true (holding the client's SSE open) after seeing a pending row
    // that a concurrent pass has since drained. Clear it so the scan channel
    // doesn't wedge the client waiting on a pass that will never report done.
    updateScanProgress({ imaging: false });
    return;
  }

  running = true;
  resetFfmpegMissing(); // a fixed FFMPEG_PATH since the last pass must clear the latch
  let warnedMissingFfmpeg = false;
  const { mediaDir } = getConfig();
  const total = pending.length;
  let done = 0;
  log.info("image pass started", { total });
  updateScanProgress({ imaging: true, imaged: 0, imageTotal: total });

  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const file = pending[cursor++];
      const abs = path.join(mediaDir, ...file.filepath.split("/"));
      try {
        if (file.movie_id) await processMovieFile(db, file, abs);
        else if (file.episode_id) await processEpisodeFile(db, mediaDir, file, abs);
      } catch (error) {
        log.warn("image extraction failed", { filepath: file.filepath, message: error instanceof Error ? error.message : String(error) });
      }
      if (ffmpegWasMissing()) {
        // The ffmpeg BINARY is missing (spawn ENOENT) — that's a deployment
        // problem, not this file's: leave images_at = 0 so the file is retried
        // on the next scan once ffmpeg is installed/FFMPEG_PATH fixed.
        if (!warnedMissingFfmpeg) {
          warnedMissingFfmpeg = true;
          log.warn("ffmpeg binary not found — images left pending, will retry on the next scan", { filepath: file.filepath });
        }
      } else {
        try {
          db.prepare("UPDATE media_files SET images_at = ? WHERE id = ?").run(Date.now(), file.id);
        } catch {
          // row vanished mid-run (pruned by a concurrent rescan) — nothing left to stamp
        }
      }
      done++;
      if (done % 5 === 0 || done === total) updateScanProgress({ imaged: done });
      // Progressive reveal: bump the catalogue version every REVEAL_BATCH images
      // so a client reloading mid-pass (see store/library.ts) sees the posters
      // extracted so far instead of waiting for the whole pass. libraryVersion()
      // folds in this 'imagesAt' stamp; the definitive stamp still lands at the
      // end. Single-threaded `done++` fires this exactly once per boundary.
      if (done % REVEAL_BATCH === 0 && done !== total) {
        try {
          db.prepare("INSERT INTO settings (key, value) VALUES ('imagesAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now()));
        } catch {
          // best effort — a missed stamp just defers the reveal to the next batch
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()));
    db.prepare("INSERT INTO settings (key, value) VALUES ('imagesAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now()));
    // Refresh the catalogue cache off the request path — libraryVersion() folds
    // in the 'imagesAt' stamp above, so this rebuild actually picks up the
    // freshly-written poster/backdrop hashes instead of replaying a stale one.
    void import("./repository")
      .then((m) => m.getSnapshot())
      .catch(() => {/* best effort */});
    log.info("image pass complete", { total, imaged: done });
  } catch (error) {
    log.error("image pass failed", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
    // Keep `imaging` TRUE if a rerun is queued (a second scan finished mid-pass
    // and short-circuited into pendingRerun): the rerun below continues the pass
    // and emits the real `imaging:false` at ITS end. Emitting false here would
    // make the client close its SSE and reload, then miss the rerun's freshly
    // imaged posters (they'd only surface on a later manual/auto reload).
    updateScanProgress({ imaging: pendingRerun, imaged: done, imageTotal: total });
  }

  if (pendingRerun) {
    pendingRerun = false;
    await runImagesPass();
  }
}
