// Per-scan identity caches. movie/show/season/episode identity is looked up
// once per scan and cached — SELECT-then-INSERT/UPDATE within a single
// db.transaction sees its own prior writes, so the cache is a pure
// optimisation, not a correctness requirement. touched*Ids accumulate the rows
// the scan created or changed so the FTS pass reindexes only those. Created
// fresh per scan by runScan() and threaded explicitly through every phase.

export interface ScanCaches {
  movieByFolder: Map<string, number>;
  showByFolder: Map<string, number>;
  seasonByKey: Map<string, number>;
  episodeByKey: Map<string, number>;
  touchedMovieIds: Set<number>;
  touchedShowIds: Set<number>;
}

export function newCaches(): ScanCaches {
  return {
    movieByFolder: new Map(),
    showByFolder: new Map(),
    seasonByKey: new Map(),
    episodeByKey: new Map(),
    touchedMovieIds: new Set(),
    touchedShowIds: new Set(),
  };
}
