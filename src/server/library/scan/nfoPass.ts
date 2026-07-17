// NFO pass: re-read Kodi-convention .nfo sidecars that changed since the last
// scan and merge their metadata into movies/shows/episodes (COALESCE so an NFO
// only fills fields it actually provides). Change detection is per-candidate
// stat() against the stored nfo_mtime, so in-place .nfo edits are caught even
// when the video file itself never changed.

import path from "path";
import type { Database as DB } from "better-sqlite3";
import { parseMovieNfo, parseTvShowNfo, parseEpisodeNfo, readNfoFile, type NfoActor } from "../nfo";
import { sortTitle, stripExtension } from "../namingCommon";
import type { ScanCaches } from "./caches";
import { statMtime } from "./fsStat";

function newestNfo(candidates: string[]): { path: string; mtime: number } | null {
  let best: { path: string; mtime: number } | null = null;
  for (const candidate of candidates) {
    const mtime = statMtime(candidate);
    if (mtime === null) continue;
    if (!best || mtime > best.mtime) best = { path: candidate, mtime };
  }
  return best;
}

function safeParse<T>(xml: string | null, fn: (xml: string) => T | null): T | null {
  if (!xml) return null;
  try {
    return fn(xml);
  } catch {
    return null;
  }
}

function jsonOrNull(items: string[] | NfoActor[]): string | null {
  return items.length ? JSON.stringify(items) : null;
}

export function runNfoPass(db: DB, mediaDir: string, caches: ScanCaches): void {
  // All owner→filepath associations preloaded in ONE query — the previous
  // shape issued a media_files SELECT per movie and per episode, on every
  // scan, even a no-op rescan (2N+1 queries for an N-item library).
  // The per-candidate stat() below is deliberately kept for every item: an
  // .nfo edited in place never touches its video file's mtime, so statting
  // each candidate against the stored nfo_mtime IS the change-detection
  // mechanism — restricting it to files touched by the current scan would
  // make NFO-only edits invisible until the video itself changed.
  const filesByMovie = new Map<number, string[]>();
  const filesByEpisode = new Map<number, string[]>();
  const fileRows = db.prepare("SELECT movie_id, episode_id, filepath FROM media_files").all() as {
    movie_id: number | null;
    episode_id: number | null;
    filepath: string;
  }[];
  for (const row of fileRows) {
    if (row.movie_id !== null) {
      const arr = filesByMovie.get(row.movie_id);
      if (arr) arr.push(row.filepath);
      else filesByMovie.set(row.movie_id, [row.filepath]);
    } else if (row.episode_id !== null) {
      const arr = filesByEpisode.get(row.episode_id);
      if (arr) arr.push(row.filepath);
      else filesByEpisode.set(row.episode_id, [row.filepath]);
    }
  }

  const movies = db.prepare("SELECT id, folder, nfo_mtime FROM movies").all() as { id: number; folder: string; nfo_mtime: number }[];
  for (const movie of movies) {
    const dir = path.join(mediaDir, ...movie.folder.split("/").filter(Boolean));
    const files = filesByMovie.get(movie.id) ?? [];
    const candidates = [path.join(dir, "movie.nfo"), ...files.map((f) => path.join(mediaDir, `${stripExtension(f)}.nfo`))];
    const found = newestNfo(candidates);
    if (!found || found.mtime <= movie.nfo_mtime) continue;

    const parsed = safeParse(readNfoFile(found.path), parseMovieNfo);
    if (!parsed) {
      db.prepare("UPDATE movies SET nfo_path = ?, nfo_mtime = ? WHERE id = ?").run(found.path, found.mtime, movie.id);
      continue;
    }
    db.prepare(
      `UPDATE movies SET
         title = COALESCE(?, title), sort_title = COALESCE(?, sort_title),
         original_title = COALESCE(?, original_title), year = COALESCE(?, year),
         synopsis = COALESCE(?, synopsis), tagline = COALESCE(?, tagline),
         genres = COALESCE(?, genres), actors = COALESCE(?, actors), directors = COALESCE(?, directors),
         studio = COALESCE(?, studio), content_rating = COALESCE(?, content_rating),
         nfo_path = ?, nfo_mtime = ?
       WHERE id = ?`,
    ).run(
      parsed.title,
      parsed.title ? sortTitle(parsed.title) : null,
      parsed.originalTitle,
      parsed.year,
      parsed.plot,
      parsed.tagline,
      jsonOrNull(parsed.genres),
      jsonOrNull(parsed.actors),
      jsonOrNull(parsed.directors),
      parsed.studio,
      parsed.contentRating,
      found.path,
      found.mtime,
      movie.id,
    );
    caches.touchedMovieIds.add(movie.id);
  }

  const shows = db.prepare("SELECT id, folder, nfo_mtime FROM shows").all() as { id: number; folder: string; nfo_mtime: number }[];
  for (const show of shows) {
    const tvshowPath = path.join(mediaDir, ...show.folder.split("/").filter(Boolean), "tvshow.nfo");
    const mtime = statMtime(tvshowPath);
    if (mtime === null || mtime <= show.nfo_mtime) continue;

    const parsed = safeParse(readNfoFile(tvshowPath), parseTvShowNfo);
    if (!parsed) {
      db.prepare("UPDATE shows SET nfo_mtime = ? WHERE id = ?").run(mtime, show.id);
      continue;
    }
    db.prepare(
      `UPDATE shows SET
         title = COALESCE(?, title), sort_title = COALESCE(?, sort_title), year = COALESCE(?, year),
         synopsis = COALESCE(?, synopsis), genres = COALESCE(?, genres), actors = COALESCE(?, actors),
         studio = COALESCE(?, studio), content_rating = COALESCE(?, content_rating), status = COALESCE(?, status),
         nfo_mtime = ?
       WHERE id = ?`,
    ).run(
      parsed.title,
      parsed.title ? sortTitle(parsed.title) : null,
      parsed.year,
      parsed.plot,
      jsonOrNull(parsed.genres),
      jsonOrNull(parsed.actors),
      parsed.studio,
      parsed.contentRating,
      parsed.status,
      mtime,
      show.id,
    );
    caches.touchedShowIds.add(show.id);
  }

  const episodes = db.prepare("SELECT id, nfo_mtime FROM episodes").all() as { id: number; nfo_mtime: number }[];
  for (const episode of episodes) {
    const candidates = (filesByEpisode.get(episode.id) ?? []).map((f) => path.join(mediaDir, `${stripExtension(f)}.nfo`));
    const found = newestNfo(candidates);
    if (!found || found.mtime <= episode.nfo_mtime) continue;

    const parsed = safeParse(readNfoFile(found.path), parseEpisodeNfo);
    if (!parsed) {
      db.prepare("UPDATE episodes SET nfo_mtime = ? WHERE id = ?").run(found.mtime, episode.id);
      continue;
    }
    db.prepare("UPDATE episodes SET title = COALESCE(?, title), synopsis = COALESCE(?, synopsis), air_date = COALESCE(?, air_date), nfo_mtime = ? WHERE id = ?").run(
      parsed.title,
      parsed.plot,
      parsed.aired,
      found.mtime,
      episode.id,
    );
  }
}
