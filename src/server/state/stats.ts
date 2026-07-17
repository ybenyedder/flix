// « Mon activité » — per-profile viewing statistics aggregated from
// watch_events (historical signals, indexed by idx_watch_user_time) and
// progress (current watched flags). Pure aggregation helpers are separated
// from the single DB-access entry point (getUserStats) so the math is unit
// tested without a database, mirroring userState.ts's computeWatched split.

import { getDb } from "../db";

const DAY_MS = 86_400_000;

export const HISTORY_LIMIT = 20;
export const TOP_GENRES_LIMIT = 5;
// Hard ceiling on how many watch_events rows one stats read pulls into memory.
// A stats call otherwise loads the user's ENTIRE event history at once, so a
// pathological/inflated table could OOM a read. The aggregates below are plain
// sums (order-independent), so this changes nothing for any realistic profile;
// past the cap we keep the most RECENT rows (ORDER BY created_at DESC) so the
// 7-day/30-day windows stay exact and only the all-time total/top-genres become
// a best-effort approximation over the most recent MAX_STATS_EVENTS events.
export const MAX_STATS_EVENTS = 50_000;

// --- pure aggregation ------------------------------------------------------

export interface WatchSpan {
  seconds: number;
  createdAt: number;
}

export interface WatchTimeTotals {
  /** Seconds actually watched over the last 7 days. */
  seconds7d: number;
  /** Seconds actually watched over the last 30 days. */
  seconds30d: number;
  /** Seconds actually watched, all time. */
  secondsTotal: number;
}

/** Sum watched seconds into the 7-day / 30-day / all-time windows in one pass.
 *  Negative or absent seconds never subtract (a hostile row can't drain the
 *  totals); `now` is injectable for tests. */
export function aggregateWatchTime(spans: WatchSpan[], now: number = Date.now()): WatchTimeTotals {
  const since7d = now - 7 * DAY_MS;
  const since30d = now - 30 * DAY_MS;
  let seconds7d = 0;
  let seconds30d = 0;
  let secondsTotal = 0;
  for (const span of spans) {
    const seconds = Math.max(0, span.seconds);
    secondsTotal += seconds;
    if (span.createdAt >= since30d) seconds30d += seconds;
    if (span.createdAt >= since7d) seconds7d += seconds;
  }
  return { seconds7d, seconds30d, secondsTotal };
}

/** Parse a movies/shows `genres` JSON column ("[\"Drame\",\"Crime\"]") into a
 *  clean string list — tolerant of NULL, malformed JSON and non-string junk,
 *  same defensive posture as the scanner's flatten(). */
export function parseGenres(json: string | null): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

export interface GenreSpan {
  /** Raw `genres` JSON of the watched item's top-level title (movie/show). */
  genres: string | null;
  seconds: number;
}

export interface GenreStat {
  genre: string;
  seconds: number;
}

/** Top genres by actual viewing time. A title with several genres credits each
 *  of them fully (weighting by 1/n would just dilute multi-genre titles).
 *  Ties break alphabetically so the output is deterministic. */
export function aggregateTopGenres(spans: GenreSpan[], limit: number = TOP_GENRES_LIMIT): GenreStat[] {
  const totals = new Map<string, number>();
  for (const span of spans) {
    const seconds = Math.max(0, span.seconds);
    if (seconds <= 0) continue;
    for (const genre of parseGenres(span.genres)) totals.set(genre, (totals.get(genre) ?? 0) + seconds);
  }
  return [...totals.entries()]
    .map(([genre, seconds]) => ({ genre, seconds }))
    .sort((a, b) => b.seconds - a.seconds || a.genre.localeCompare(b.genre))
    .slice(0, Math.max(1, limit));
}

// --- DB access ---------------------------------------------------------------

export interface HistoryEntry {
  itemType: "movie" | "episode";
  topType: "movie" | "show";
  topId: number;
  title: string;
  /** "S1 : É3 — Titre" for an episode, null for a movie. */
  subtitle: string | null;
  kind: "complete" | "abandon";
  seconds: number;
  createdAt: number;
}

export interface UserStats extends WatchTimeTotals {
  /** Titles currently marked watched (movies + episodes) — reflects « non vu ». */
  completedTitles: number;
  topGenres: GenreStat[];
  history: HistoryEntry[];
}

interface EventRow {
  seconds: number;
  created_at: number;
  genres: string | null;
}

interface HistoryRow {
  item_type: string;
  top_type: string;
  top_id: number;
  kind: string;
  seconds: number;
  created_at: number;
  movie_title: string | null;
  show_title: string | null;
  episode_number: number | null;
  episode_title: string | null;
  season_number: number | null;
}

/** Shape the joined history rows for display, dropping events whose top-level
 *  title has since been deleted from the library (same skip-stale policy as
 *  getProgressSummaries). Exported for direct unit testing. */
export function shapeHistory(rows: HistoryRow[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const row of rows) {
    const title = row.top_type === "movie" ? row.movie_title : row.show_title;
    if (!title) continue; // stale reference to a since-deleted item
    let subtitle: string | null = null;
    if (row.item_type === "episode" && row.season_number !== null && row.episode_number !== null) {
      subtitle = `S${row.season_number} : É${row.episode_number}${row.episode_title ? ` — ${row.episode_title}` : ""}`;
    }
    entries.push({
      itemType: row.item_type === "episode" ? "episode" : "movie",
      topType: row.top_type === "show" ? "show" : "movie",
      topId: row.top_id,
      title,
      subtitle,
      kind: row.kind === "abandon" ? "abandon" : "complete",
      seconds: row.seconds,
      createdAt: row.created_at,
    });
  }
  return entries;
}

/** All stats for one profile. Loads the user's own events only (bounded by
 *  their real viewing history — the reco engine already does the same), joins
 *  genres from movies/shows via the denormalised (top_type, top_id) pair, and
 *  counts completed titles from the live progress table so « marquer non vu »
 *  is reflected immediately. */
export function getUserStats(userId: number, now: number = Date.now()): UserStats {
  const db = getDb();

  const eventRows = db
    .prepare(
      // Bounded to the most recent MAX_STATS_EVENTS rows so an inflated table
      // can't OOM a stats read (see the constant's note — sums are
      // order-independent, so normal-sized histories are unaffected).
      `SELECT w.seconds AS seconds, w.created_at AS created_at,
              COALESCE(m.genres, sh.genres) AS genres
       FROM watch_events w
       LEFT JOIN movies m ON w.top_type = 'movie' AND m.id = w.top_id
       LEFT JOIN shows sh ON w.top_type = 'show' AND sh.id = w.top_id
       WHERE w.user_id = ?
       ORDER BY w.created_at DESC
       LIMIT ?`,
    )
    .all(userId, MAX_STATS_EVENTS) as EventRow[];

  const totals = aggregateWatchTime(
    eventRows.map((r) => ({ seconds: r.seconds, createdAt: r.created_at })),
    now,
  );
  const topGenres = aggregateTopGenres(eventRows.map((r) => ({ genres: r.genres, seconds: r.seconds })));

  const completedTitles = (
    db.prepare("SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND watched = 1").get(userId) as { n: number }
  ).n;

  const historyRows = db
    .prepare(
      `SELECT w.item_type AS item_type, w.top_type AS top_type, w.top_id AS top_id,
              w.kind AS kind, w.seconds AS seconds, w.created_at AS created_at,
              m.title AS movie_title,
              sh.title AS show_title,
              e.episode_number AS episode_number, e.title AS episode_title,
              se.season_number AS season_number
       FROM watch_events w
       LEFT JOIN movies m ON w.top_type = 'movie' AND m.id = w.top_id
       LEFT JOIN shows sh ON w.top_type = 'show' AND sh.id = w.top_id
       LEFT JOIN episodes e ON w.item_type = 'episode' AND e.id = w.item_id
       LEFT JOIN seasons se ON se.id = e.season_id
       WHERE w.user_id = ?
       ORDER BY w.created_at DESC
       LIMIT ?`,
    )
    .all(userId, HISTORY_LIMIT) as HistoryRow[];

  return { ...totals, completedTitles, topGenres, history: shapeHistory(historyRows) };
}
