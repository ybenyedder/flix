// SQLite access layer (better-sqlite3). Single shared connection per process,
// WAL mode for concurrent reads during a scan, and a tiny forward-only migration
// runner keyed on PRAGMA user_version.

import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { getConfig } from "./config";
import { createLogger } from "./logger";

const log = createLogger("db");

let connection: DB | null = null;

/** Ordered DDL migrations. Append-only; never edit a shipped migration in place. */
const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS movies (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    title          TEXT NOT NULL,
    sort_title     TEXT NOT NULL,
    original_title TEXT,
    year           INTEGER,
    duration       REAL NOT NULL DEFAULT 0,
    synopsis       TEXT,
    tagline        TEXT,
    genres         TEXT,
    actors         TEXT,
    directors      TEXT,
    studio         TEXT,
    content_rating TEXT,
    poster_hash    TEXT,
    backdrop_hash  TEXT,
    thumb_hash     TEXT,
    logo_hash      TEXT,
    folder         TEXT NOT NULL,
    nfo_path       TEXT,
    nfo_mtime      INTEGER NOT NULL DEFAULT 0,
    added_at       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_movies_folder ON movies(folder);

  CREATE TABLE IF NOT EXISTS shows (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    title          TEXT NOT NULL,
    sort_title     TEXT NOT NULL,
    year           INTEGER,
    synopsis       TEXT,
    genres         TEXT,
    actors         TEXT,
    studio         TEXT,
    content_rating TEXT,
    status         TEXT,
    poster_hash    TEXT,
    backdrop_hash  TEXT,
    logo_hash      TEXT,
    folder         TEXT UNIQUE NOT NULL,
    nfo_mtime      INTEGER NOT NULL DEFAULT 0,
    added_at       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    season_number INTEGER NOT NULL,
    title TEXT,
    poster_hash TEXT,
    UNIQUE(show_id, season_number)
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id   INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    episode_number INTEGER NOT NULL,
    episode_end    INTEGER,
    title TEXT,
    synopsis TEXT,
    air_date TEXT,
    duration REAL NOT NULL DEFAULT 0,
    thumb_hash TEXT,
    nfo_mtime INTEGER NOT NULL DEFAULT 0,
    added_at  INTEGER NOT NULL DEFAULT 0,
    UNIQUE(season_id, episode_number)
  );
  CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes(show_id, season_id, episode_number);

  CREATE TABLE IF NOT EXISTS media_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    movie_id   INTEGER REFERENCES movies(id)   ON DELETE CASCADE,
    episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
    filepath   TEXT UNIQUE NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    container  TEXT,
    duration   REAL NOT NULL DEFAULT 0,
    bitrate    INTEGER,
    version    TEXT,
    chapters   TEXT,
    keyframes  TEXT,
    probed_at  INTEGER NOT NULL DEFAULT 0,
    images_at  INTEGER NOT NULL DEFAULT 0,
    added_at   INTEGER NOT NULL DEFAULT 0,
    CHECK ((movie_id IS NULL) != (episode_id IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_files_movie ON media_files(movie_id);
  CREATE INDEX IF NOT EXISTS idx_files_episode ON media_files(episode_id);
  CREATE INDEX IF NOT EXISTS idx_files_pending_probe  ON media_files(probed_at);
  CREATE INDEX IF NOT EXISTS idx_files_pending_images ON media_files(images_at);

  CREATE TABLE IF NOT EXISTS streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    stream_index INTEGER NOT NULL,
    type TEXT NOT NULL,
    codec TEXT,
    profile TEXT,
    level INTEGER,
    width INTEGER,
    height INTEGER,
    bit_depth INTEGER,
    frame_rate REAL,
    pixel_format TEXT,
    color_transfer TEXT,
    color_primaries TEXT,
    hdr_format TEXT,
    channels INTEGER,
    channel_layout TEXT,
    sample_rate INTEGER,
    language TEXT,
    title TEXT,
    bitrate INTEGER,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_forced INTEGER NOT NULL DEFAULT 0,
    attached_pic INTEGER NOT NULL DEFAULT 0,
    UNIQUE(media_file_id, stream_index)
  );

  CREATE TABLE IF NOT EXISTS subtitles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    stream_index INTEGER,
    source TEXT NOT NULL,
    external_path TEXT,
    language TEXT,
    title TEXT,
    is_forced INTEGER NOT NULL DEFAULT 0,
    is_sdh INTEGER NOT NULL DEFAULT 0,
    format TEXT,
    is_text INTEGER NOT NULL DEFAULT 1,
    vtt_hash TEXT
  );

  CREATE TABLE IF NOT EXISTS images (
    hash   TEXT PRIMARY KEY,
    kind   TEXT NOT NULL,
    source TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    accent TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_kids INTEGER NOT NULL DEFAULT 0,
    avatar TEXT NOT NULL DEFAULT 'red',
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    media_file_id INTEGER,
    position REAL NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,
    watched INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, item_type, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_progress_user_time ON progress(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS watch_events (
    user_id INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    top_type TEXT NOT NULL,
    top_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ratio REAL NOT NULL DEFAULT 0,
    seconds REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_watch_user_time ON watch_events(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_watch_top ON watch_events(top_type, top_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS my_list (
    user_id INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, item_type, item_id)
  );

  CREATE TABLE IF NOT EXISTS ratings (
    user_id INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    value INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, item_type, item_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
    item_type UNINDEXED, item_id UNINDEXED,
    title, original_title, genres, actors, synopsis,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,

  // v2 — subtitles was the only per-file child table with no index on its
  // foreign key (streams gets one implicitly from UNIQUE(media_file_id,
  // stream_index)), so every per-file subtitle lookup in the repository was a
  // full-table scan — multiplied per file when opening a movie/show detail.
  `
  CREATE INDEX IF NOT EXISTS idx_subtitles_file ON subtitles(media_file_id);
  `,

  // v3 — "Retirer de Continuer à regarder": a dismissed progress row keeps its
  // position (resume from the detail sheet still works) but is hidden from the
  // Continue Watching row until a new playback progress write resets the flag
  // (see setProgress/dismissProgress in src/server/state/userState.ts).
  `
  ALTER TABLE progress ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0;
  `,

  // v4 — opt-in *arr download integration (see src/server/arr/*). Tracks a
  // user-initiated request through its Radarr/Sonarr lifecycle so the "Demandes"
  // view can show live status even across restarts (a download in flight when
  // the server bounces). All of this stays dormant unless the operator enables
  // the feature (settings key `arr.enabled`); an untouched install never writes
  // a row here. `arr_id` is the Radarr movie / Sonarr series id; status churns
  // (requested→searching→downloading→importing→available|failed), so dedupe is
  // enforced in code rather than via a partial unique index.
  `
  CREATE TABLE IF NOT EXISTS arr_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    tmdb_id INTEGER,
    tvdb_id INTEGER,
    title TEXT NOT NULL,
    year INTEGER,
    poster_url TEXT,
    arr_id INTEGER,
    status TEXT NOT NULL DEFAULT 'requested',
    progress REAL NOT NULL DEFAULT 0,
    error TEXT,
    library_item_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_arr_requests_status ON arr_requests(status);
  `,

  // v5 — stall watchdog for the *arr integration: when a download sits at ~0%
  // with no progress for too long (a dead/poorly-seeded release, common with a
  // "max"/Remux quality profile on niche titles), Flix falls back to the
  // "balanced" quality profile and re-searches. `stalled_since` timestamps when a
  // request's download first stopped advancing at low progress (cleared once it
  // moves); `quality_fallback` records that the one-time balanced fallback already
  // fired for this request, so it isn't retriggered in a loop.
  `
  ALTER TABLE arr_requests ADD COLUMN stalled_since INTEGER;
  ALTER TABLE arr_requests ADD COLUMN quality_fallback INTEGER NOT NULL DEFAULT 0;
  `,
];

function migrate(db: DB) {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= MIGRATIONS.length) return;

  for (let version = current; version < MIGRATIONS.length; version++) {
    // BEGIN IMMEDIATE takes the write lock up front, then user_version is
    // re-read INSIDE the transaction: two processes opening the same fresh DB
    // would otherwise both read a stale version and both apply the same
    // migration (an ALTER TABLE then fails the loser with "duplicate column").
    db.exec("BEGIN IMMEDIATE");
    try {
      const applied = db.pragma("user_version", { simple: true }) as number;
      if (applied >= version + 1) {
        db.exec("COMMIT");
        continue;
      }
      log.info("applying migration", { to: version + 1 });
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

let shutdownHooked = false;

// A SIGTERM/SIGINT lands mid-write without this (process manager restart,
// `docker stop`, Electron's `serverProcess.kill()` on quit — all send SIGTERM).
// Node's default reaction just dies immediately, leaving WAL frames unmerged
// into the main db file; better-sqlite3's own `.close()` only does a passive
// checkpoint attempt, not a guaranteed one. Hooked once per process, the first
// time a connection is opened, so every entrypoint (web, standalone, desktop's
// forked child) gets it for free without each needing its own shutdown wiring.
function hookGracefulShutdown(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    // Best-effort: kill any live ffmpeg remux/transcode sessions before the DB
    // closes, so a restart never leaves orphaned processes writing into a
    // transcode dir nobody will clean up anymore. Imported dynamically to avoid
    // a hard dependency from db.ts on the playback subsystem (Phase 4).
    import("./playback/sessions")
      .then((m) => m.killAllSessions())
      .catch(() => {})
      .finally(() => {
        closeDb();
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export function getDb(): DB {
  if (connection) return connection;

  const { dbPath } = getConfig();
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);

  connection = db;
  hookGracefulShutdown();
  log.info("database ready", { dbPath });
  return db;
}

/** Write a consistent point-in-time copy of the database to `destinationFile`,
 *  via SQLite's online backup API (better-sqlite3's `.backup()`) — safe to run
 *  against a live WAL-mode connection with concurrent readers/writers, unlike a
 *  plain filesystem copy of the .db file (which could grab it mid-write or miss
 *  data still sitting in the WAL). Used by the admin backup-download route. */
export async function backupDbTo(destinationFile: string): Promise<void> {
  await getDb().backup(destinationFile);
}

/** Close the connection — used by tests and graceful shutdown. */
export function closeDb(): void {
  if (connection) {
    // TRUNCATE forces a full checkpoint (merge WAL into the main file, then
    // reset it to empty) rather than the default PASSIVE mode's best-effort
    // partial checkpoint, so an interrupted shutdown never sees a fatter WAL
    // than the writes since the last natural checkpoint actually warranted.
    try {
      connection.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // best effort — still close the handle below even if the checkpoint failed
    }
    connection.close();
  }
  connection = null;
}
