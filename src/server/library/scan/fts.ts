// FTS phase: rebuild the catalog_fts rows for every movie/show the scan
// touched, plus any item present in the DB but missing from the index (crash
// recovery: a scan that died between its committed upserts and this pass would
// otherwise leave those items unsearchable forever). Delete+insert per item in
// one transaction so a mid-reindex crash can't strand an item de-indexed.

import type { Database as DB } from "better-sqlite3";
import type { ScanCaches } from "./caches";

function flatten(json: string | null, key?: string): string {
  if (!json) return "";
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return "";
    if (key) return value.map((v) => (v && typeof v === "object" ? (v as Record<string, unknown>)[key] : "")).filter(Boolean).join(" ");
    return value.filter((v) => typeof v === "string").join(" ");
  } catch {
    return "";
  }
}

export function reindexFts(db: DB, caches: ScanCaches): void {
  // Crash-recovery completion: a movie/show present in the DB but absent from
  // catalog_fts (a previous scan crashed between its committed upsert batches
  // and this autocommit-era FTS pass) would otherwise stay unsearchable
  // forever — its files are unchanged, so nothing ever touches it again.
  const missingMovies = db
    .prepare("SELECT id FROM movies WHERE id NOT IN (SELECT item_id FROM catalog_fts WHERE item_type = 'movie')")
    .all() as { id: number }[];
  for (const row of missingMovies) caches.touchedMovieIds.add(row.id);
  const missingShows = db
    .prepare("SELECT id FROM shows WHERE id NOT IN (SELECT item_id FROM catalog_fts WHERE item_type = 'show')")
    .all() as { id: number }[];
  for (const row of missingShows) caches.touchedShowIds.add(row.id);

  // One transaction for the whole delete+insert pass: a crash mid-reindex must
  // never leave an item deleted from the index but not yet re-inserted.
  const tx = db.transaction(() => {
    const delMovie = db.prepare("DELETE FROM catalog_fts WHERE item_type = 'movie' AND item_id = ?");
    const insMovie = db.prepare(
      "INSERT INTO catalog_fts (item_type, item_id, title, original_title, genres, actors, synopsis) VALUES ('movie', ?, ?, ?, ?, ?, ?)",
    );
    const getMovie = db.prepare("SELECT title, original_title, genres, actors, synopsis FROM movies WHERE id = ?");
    for (const id of caches.touchedMovieIds) {
      delMovie.run(id);
      const row = getMovie.get(id) as { title: string; original_title: string | null; genres: string | null; actors: string | null; synopsis: string | null } | undefined;
      if (row) insMovie.run(id, row.title, row.original_title, flatten(row.genres), flatten(row.actors, "name"), row.synopsis);
    }

    const delShow = db.prepare("DELETE FROM catalog_fts WHERE item_type = 'show' AND item_id = ?");
    const insShow = db.prepare(
      "INSERT INTO catalog_fts (item_type, item_id, title, original_title, genres, actors, synopsis) VALUES ('show', ?, ?, NULL, ?, ?, ?)",
    );
    const getShow = db.prepare("SELECT title, genres, actors, synopsis FROM shows WHERE id = ?");
    for (const id of caches.touchedShowIds) {
      delShow.run(id);
      const row = getShow.get(id) as { title: string; genres: string | null; actors: string | null; synopsis: string | null } | undefined;
      if (row) insShow.run(id, row.title, flatten(row.genres), flatten(row.actors, "name"), row.synopsis);
    }
  });
  tx();
}
