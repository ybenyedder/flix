// Upsert / indexing phase: turn classified walked files into movie/show/
// season/episode/media_file rows, refresh external subtitle sidecars, and
// re-arm the image pass for sidecars dropped next to unchanged files. All
// database access is threaded through explicit db/caches parameters; this
// module owns no shared scan state.

import path from "path";
import type { Database as DB } from "better-sqlite3";
import { sortTitle } from "../namingCommon";
import { type EpisodeMatch } from "../namingShows";
import { findSidecarSubtitles, SIDECAR_DIR_NAMES } from "../sidecarSubs";
import { findSidecarImages } from "../images";
import { createLogger } from "../../logger";
import { classify } from "./classify";
import type { WalkedVideo } from "./walk";
import type { ScanCaches } from "./caches";
import { statMtime } from "./fsStat";

const log = createLogger("scanner");

// Name-derived metadata seeds a movie/show/episode ONLY at creation time —
// never on a later re-upsert (e.g. a second version file landing in the same
// folder) — so it can never clobber a title an NFO pass already refined.
function upsertMovie(db: DB, folder: string, title: string, year: number | null, caches: ScanCaches): number {
  const cached = caches.movieByFolder.get(folder);
  if (cached !== undefined) return cached;
  const existing = db.prepare("SELECT id FROM movies WHERE folder = ? ORDER BY id LIMIT 1").get(folder) as { id: number } | undefined;
  if (existing) {
    caches.movieByFolder.set(folder, existing.id);
    return existing.id;
  }
  const info = db
    .prepare("INSERT INTO movies (title, sort_title, year, folder, added_at) VALUES (?, ?, ?, ?, ?)")
    .run(title, sortTitle(title), year, folder, Date.now());
  const id = Number(info.lastInsertRowid);
  caches.movieByFolder.set(folder, id);
  caches.touchedMovieIds.add(id);
  return id;
}

function upsertShow(db: DB, folder: string, title: string, year: number | null, caches: ScanCaches): number {
  const cached = caches.showByFolder.get(folder);
  if (cached !== undefined) return cached;
  const existing = db.prepare("SELECT id FROM shows WHERE folder = ?").get(folder) as { id: number } | undefined;
  if (existing) {
    caches.showByFolder.set(folder, existing.id);
    return existing.id;
  }
  const info = db
    .prepare("INSERT INTO shows (title, sort_title, year, folder, added_at) VALUES (?, ?, ?, ?, ?)")
    .run(title, sortTitle(title), year, folder, Date.now());
  const id = Number(info.lastInsertRowid);
  caches.showByFolder.set(folder, id);
  caches.touchedShowIds.add(id);
  return id;
}

function upsertSeason(db: DB, showId: number, seasonNumber: number, caches: ScanCaches): number {
  const key = `${showId}:${seasonNumber}`;
  const cached = caches.seasonByKey.get(key);
  if (cached !== undefined) return cached;
  const existing = db.prepare("SELECT id FROM seasons WHERE show_id = ? AND season_number = ?").get(showId, seasonNumber) as
    | { id: number }
    | undefined;
  if (existing) {
    caches.seasonByKey.set(key, existing.id);
    return existing.id;
  }
  const info = db.prepare("INSERT INTO seasons (show_id, season_number) VALUES (?, ?)").run(showId, seasonNumber);
  const id = Number(info.lastInsertRowid);
  caches.seasonByKey.set(key, id);
  return id;
}

function upsertEpisode(db: DB, showId: number, seasonId: number, match: EpisodeMatch, caches: ScanCaches): number {
  const key = `${seasonId}:${match.episode}`;
  const cached = caches.episodeByKey.get(key);
  if (cached !== undefined) return cached;
  const existing = db.prepare("SELECT id FROM episodes WHERE season_id = ? AND episode_number = ?").get(seasonId, match.episode) as
    | { id: number }
    | undefined;
  if (existing) {
    caches.episodeByKey.set(key, existing.id);
    return existing.id;
  }
  const info = db
    .prepare("INSERT INTO episodes (show_id, season_id, episode_number, episode_end, title, added_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(showId, seasonId, match.episode, match.episodeEnd, match.episodeTitle, Date.now());
  const id = Number(info.lastInsertRowid);
  caches.episodeByKey.set(key, id);
  return id;
}

function upsertMediaFile(db: DB, video: WalkedVideo, parent: { movieId: number | null; episodeId: number | null }): number {
  const existing = db.prepare("SELECT id FROM media_files WHERE filepath = ?").get(video.rel) as { id: number } | undefined;
  if (existing) {
    db.prepare("UPDATE media_files SET size = ?, mtime = ?, movie_id = ?, episode_id = ?, probed_at = 0, images_at = 0 WHERE id = ?").run(
      video.size,
      video.mtime,
      parent.movieId,
      parent.episodeId,
      existing.id,
    );
    return existing.id;
  }
  const info = db
    .prepare(
      "INSERT INTO media_files (movie_id, episode_id, filepath, size, mtime, probed_at, images_at, added_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)",
    )
    .run(parent.movieId, parent.episodeId, video.rel, video.size, video.mtime, Date.now());
  return Number(info.lastInsertRowid);
}

function refreshSidecarSubtitles(db: DB, mediaFileId: number, absPath: string, mediaDir: string): void {
  db.prepare("DELETE FROM subtitles WHERE media_file_id = ? AND source = 'external'").run(mediaFileId);
  const insert = db.prepare(
    "INSERT INTO subtitles (media_file_id, source, external_path, language, is_forced, is_sdh, format, is_text) VALUES (?, 'external', ?, ?, ?, ?, ?, ?)",
  );
  for (const sub of findSidecarSubtitles(absPath)) {
    // Stored RELATIVE to mediaDir (posix separators, like media_files.filepath)
    // so remounting the library at another absolute path (container vs host)
    // doesn't strand every external subtitle. Absolute rows written before this
    // change are rewritten relative the next time this refresh runs; the read
    // path (src/server/playback/subtitles.ts) still resolves both shapes.
    const rel = path.relative(mediaDir, sub.path).split(path.sep).join("/");
    insert.run(mediaFileId, rel, sub.language, sub.isForced ? 1 : 0, sub.isSdh ? 1 : 0, sub.format, sub.format === "vobsub" ? 0 : 1);
  }
}

export function processChangedBatch(db: DB, mediaDir: string, batch: WalkedVideo[], caches: ScanCaches): void {
  const tx = db.transaction((files: WalkedVideo[]) => {
    for (const video of files) {
      const classified = classify(video);
      let movieId: number | null = null;
      let episodeId: number | null = null;
      if (classified.kind === "movie") {
        movieId = upsertMovie(db, classified.folder, classified.title, classified.year, caches);
      } else {
        const showId = upsertShow(db, classified.match.showFolder, classified.showTitle, classified.showYear, caches);
        const seasonId = upsertSeason(db, showId, classified.match.season, caches);
        episodeId = upsertEpisode(db, showId, seasonId, classified.match, caches);
      }
      const mediaFileId = upsertMediaFile(db, video, { movieId, episodeId });
      refreshSidecarSubtitles(db, mediaFileId, video.abs, mediaDir);
    }
  });
  tx(batch);
}

// A subtitle/poster dropped NEXT TO an already-indexed video never changes the
// video's own mtime/size, so the changed-file path above never sees it. The
// drop DOES bump its directory's mtime though — so for UNCHANGED files whose
// parent dir (or an adjacent Subs/ dir) is newer than the last completed scan,
// re-run the sidecar subtitle refresh, and re-arm the image pass when a
// sidecar image is newer than the file's images_at stamp.
export function refreshUnchangedSidecars(
  db: DB,
  mediaDir: string,
  videos: WalkedVideo[],
  changedRel: Set<string>,
  dirMtimes: Map<string, number>,
  lastScanMs: number,
): void {
  const dirTouched = (relDir: string): boolean => {
    const own = dirMtimes.get(relDir);
    if (own !== undefined && own > lastScanMs) return true;
    for (const sub of SIDECAR_DIR_NAMES) {
      const m = dirMtimes.get(relDir ? `${relDir}/${sub}` : sub);
      if (m !== undefined && m > lastScanMs) return true;
    }
    return false;
  };

  const candidates = videos.filter((v) => !changedRel.has(v.rel) && dirTouched(v.dirParts.join("/")));
  if (!candidates.length) return;

  const getRow = db.prepare("SELECT id, images_at FROM media_files WHERE filepath = ?");
  const rearmImages = db.prepare("UPDATE media_files SET images_at = 0 WHERE id = ?");
  let rearmed = 0;
  const tx = db.transaction(() => {
    for (const video of candidates) {
      const row = getRow.get(video.rel) as { id: number; images_at: number } | undefined;
      if (!row) continue;
      refreshSidecarSubtitles(db, row.id, video.abs, mediaDir);
      if (row.images_at > 0 && sidecarImageNewerThan(video, row.images_at)) {
        rearmImages.run(row.id);
        rearmed++;
      }
    }
  });
  tx();
  log.info("refreshed sidecars for unchanged files in touched directories", { files: candidates.length, imagesRearmed: rearmed });
}

/** Any Kodi-convention sidecar image (poster/fanart/thumb/logo — the exact set
 *  the image pass consumes, via the same lookup) newer than `sinceMs`? */
function sidecarImageNewerThan(video: WalkedVideo, sinceMs: number): boolean {
  const dir = path.dirname(video.abs);
  const basename = path.basename(video.abs, path.extname(video.abs));
  const sidecars = findSidecarImages(dir, basename);
  for (const p of [sidecars.poster, sidecars.backdrop, sidecars.thumb, sidecars.logo]) {
    if (!p) continue;
    const mtime = statMtime(p);
    if (mtime !== null && mtime > sinceMs) return true;
  }
  return false;
}
