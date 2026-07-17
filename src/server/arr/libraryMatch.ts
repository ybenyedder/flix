// Library matching (D12): resolve a Radarr/Sonarr request back to an existing
// library row — primarily by the imported file's basename against media_files,
// falling back to a normalised title + year match. Pure w.r.t. module state:
// every function takes the db handle, so the request lifecycle in requests.ts
// (and its poller) can call them without owning any of this.

import type { Database as DB } from "better-sqlite3";
import { normalizeTitle } from "./statusMap";

export function fileBasename(p: string | null | undefined): string | null {
  if (!p) return null;
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const base = i >= 0 ? p.slice(i + 1) : p;
  return base || null;
}

/** Build a SQL LIKE suffix pattern that matches a filepath ending in `basename`,
 *  escaping LIKE metacharacters so a `%`/`_` in the filename can't wildcard. */
function likeSuffix(basename: string): string {
  return "%" + basename.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** Find a library movie id for a request: primary by the imported file's
 *  basename against media_files, fallback by normalised title + year. */
export function findLibraryMovieId(db: DB, opts: { title: string; year: number | null; fileBasename: string | null }): number | null {
  if (opts.fileBasename) {
    const row = db
      .prepare("SELECT movie_id AS id FROM media_files WHERE movie_id IS NOT NULL AND filepath LIKE ? ESCAPE '\\' LIMIT 1")
      .get(likeSuffix(opts.fileBasename)) as { id: number } | undefined;
    if (row) return row.id;
  }
  const target = normalizeTitle(opts.title);
  const candidates = db.prepare("SELECT id, title, year FROM movies").all() as { id: number; title: string; year: number | null }[];
  for (const c of candidates) {
    if (normalizeTitle(c.title) !== target) continue;
    if (opts.year != null && c.year != null && Math.abs(c.year - opts.year) > 1) continue;
    return c.id;
  }
  return null;
}

/** Find a library show id: primary by any episode file basename, fallback by
 *  normalised title + year. */
export function findLibraryShowId(db: DB, opts: { title: string; year: number | null; fileBasename: string | null }): number | null {
  if (opts.fileBasename) {
    const row = db
      .prepare(
        "SELECT e.show_id AS id FROM media_files mf JOIN episodes e ON e.id = mf.episode_id WHERE mf.episode_id IS NOT NULL AND mf.filepath LIKE ? ESCAPE '\\' LIMIT 1",
      )
      .get(likeSuffix(opts.fileBasename)) as { id: number } | undefined;
    if (row) return row.id;
  }
  const target = normalizeTitle(opts.title);
  const candidates = db.prepare("SELECT id, title, year FROM shows").all() as { id: number; title: string; year: number | null }[];
  for (const c of candidates) {
    if (normalizeTitle(c.title) !== target) continue;
    if (opts.year != null && c.year != null && Math.abs(c.year - opts.year) > 1) continue;
    return c.id;
  }
  return null;
}
