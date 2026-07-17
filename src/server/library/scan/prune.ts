// Pruning phase: remove media_files whose paths vanished from the walk, then
// cascade away any episodes/seasons/shows/movies left with no files, keeping
// catalog_fts and the touched-id sets consistent. Only ever called when the
// walk proved the tree is fully readable (see runScan's pruneSkipped guard).

import type { Database as DB } from "better-sqlite3";
import type { ScanCaches } from "./caches";

// SQLite caps one statement at SQLITE_MAX_VARIABLE_NUMBER (32766) bound
// parameters. A single scan can orphan more rows than that at once (a whole
// show tree, or a mass library move), so id-list deletes are issued in
// fixed-size chunks instead of one `IN (?,?,…)` carrying one placeholder per id
// — which would throw "too many SQL variables" and abort the prune (and, since
// it runs inside runScan's try, the scan). Runs inside the caller's transaction.
const DELETE_ID_CHUNK = 500;

function deleteByIdChunks(db: DB, table: string, ids: number[]): void {
  for (let i = 0; i < ids.length; i += DELETE_ID_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`).run(...chunk);
  }
}

export function pruneMissingFiles(db: DB, toRemove: string[], caches: ScanCaches): void {
  if (!toRemove.length) return;
  const tx = db.transaction(() => {
    const del = db.prepare("DELETE FROM media_files WHERE filepath = ?");
    for (const filepath of toRemove) del.run(filepath);

    const orphanEpisodes = db
      .prepare("SELECT id FROM episodes WHERE id NOT IN (SELECT DISTINCT episode_id FROM media_files WHERE episode_id IS NOT NULL)")
      .all() as { id: number }[];
    if (orphanEpisodes.length) {
      deleteByIdChunks(db, "episodes", orphanEpisodes.map((e) => e.id));
    }

    db.prepare("DELETE FROM seasons WHERE id NOT IN (SELECT DISTINCT season_id FROM episodes)").run();

    const orphanShows = db.prepare("SELECT id FROM shows WHERE id NOT IN (SELECT DISTINCT show_id FROM seasons)").all() as { id: number }[];
    if (orphanShows.length) {
      deleteByIdChunks(db, "shows", orphanShows.map((s) => s.id));
      for (const s of orphanShows) {
        db.prepare("DELETE FROM catalog_fts WHERE item_type = 'show' AND item_id = ?").run(s.id);
        caches.touchedShowIds.delete(s.id);
      }
    }

    const orphanMovies = db
      .prepare("SELECT id FROM movies WHERE id NOT IN (SELECT DISTINCT movie_id FROM media_files WHERE movie_id IS NOT NULL)")
      .all() as { id: number }[];
    if (orphanMovies.length) {
      deleteByIdChunks(db, "movies", orphanMovies.map((m) => m.id));
      for (const m of orphanMovies) {
        db.prepare("DELETE FROM catalog_fts WHERE item_type = 'movie' AND item_id = ?").run(m.id);
        caches.touchedMovieIds.delete(m.id);
      }
    }
  });
  tx();
}
