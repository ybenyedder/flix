// Per-profile state: my list, ratings (thumbs/love), watch progress. SQLite is
// the source of truth, scoped to the requesting account, so the web UI, the
// future desktop app and a future Android client all share the same state.
// Model: /home/pc/Documents/auralis_enterprise_grade/src/server/state/userState.ts
//
// toggleMyList/setRating/recordWatchEvent double as the Phase 7 taste engine's
// only write path (there is no separate /api/feedback — /api/state already
// covers my list/rating/watch events, so a second route would just duplicate
// this one), hence the invalidateReco() call at the end of each: the engine
// memoises a user's profile for a couple of seconds, and a write should never
// be visible-lagged behind that cache on the very next Home load.

import { getDb } from "../db";
import { invalidateReco } from "../reco/engine";
import { isAllowedForKids } from "@/lib/flix/kids";

export type ListItemType = "movie" | "show";
export type ProgressItemType = "movie" | "episode";
/** setWatched targets: a single movie/episode, or a whole show (fans out to
 *  every indexed episode — practical from the detail sheet, cheap in SQL). */
export type WatchedItemType = "movie" | "episode" | "show";

export interface MyListEntry {
  itemType: ListItemType;
  itemId: number;
  createdAt: number;
}

export interface RatingEntry {
  itemType: ListItemType;
  itemId: number;
  value: number;
  createdAt: number;
}

/** Progress row enriched with display info resolved server-side (episode ->
 *  season -> show), so the client never has to do that join itself. */
export interface ProgressSummary {
  itemType: ProgressItemType;
  itemId: number;
  mediaFileId: number | null;
  position: number;
  /** 0 when the row is dismissed — see the shaping note in getProgressSummaries. */
  duration: number;
  watched: boolean;
  /** Removed from "Continuer à regarder" without being marked watched. */
  dismissed: boolean;
  updatedAt: number;
  topType: ListItemType;
  topId: number;
  title: string;
  subtitle: string | null;
  posterHash: string | null;
  backdropHash: string | null;
  thumbHash: string | null;
}

export interface UserState {
  myList: MyListEntry[];
  ratings: RatingEntry[];
  progress: ProgressSummary[];
}

const PROGRESS_LIMIT = 200;
const WATCHED_RATIO = 0.92;
// A session can genuinely run long (a movie left paused overnight, a TV
// marathon); this just guards against a hostile/buggy client writing a
// nonsensical multi-day position/duration into the DB.
const MAX_POSITION_SECONDS = 24 * 3600;

/** Whether a position/duration pair counts as "watched" — pure so it's unit
 *  tested without touching the DB. */
export function computeWatched(position: number, duration: number): boolean {
  return duration > 0 && position / duration >= WATCHED_RATIO;
}

function getMyList(userId: number): MyListEntry[] {
  const rows = getDb()
    .prepare("SELECT item_type, item_id, created_at FROM my_list WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as { item_type: string; item_id: number; created_at: number }[];
  return rows.map((r) => ({ itemType: r.item_type as ListItemType, itemId: r.item_id, createdAt: r.created_at }));
}

function getRatings(userId: number): RatingEntry[] {
  const rows = getDb()
    .prepare("SELECT item_type, item_id, value, created_at FROM ratings WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as { item_type: string; item_id: number; value: number; created_at: number }[];
  return rows.map((r) => ({ itemType: r.item_type as ListItemType, itemId: r.item_id, value: r.value, createdAt: r.created_at }));
}

interface ProgressRow {
  item_type: string;
  item_id: number;
  media_file_id: number | null;
  position: number;
  duration: number;
  watched: number;
  dismissed: number;
  updated_at: number;
}

// Every client-side "is this in progress?" predicate (the Continue Watching
// row, next-up picking) reads `duration > 0 && position > 5 && ratio < 0.92`
// over these summaries. A dismissed row is therefore emitted with duration 0 —
// position intact — so it drops out of all of them at once, while resume still
// works: the player resolves its resume offset from the row's position and the
// ITEM's own duration (file/detail metadata), never from this field. A new
// setProgress write resets the flag and the real duration reappears.
function shapeDuration(r: ProgressRow): number {
  return r.dismissed === 1 ? 0 : r.duration;
}

// `isKids` filters out titles barred for a kids profile: a profile flipped from
// adult to kids keeps its old progress rows, and these summaries carry their own
// denormalised poster/title/episode metadata — so without this gate "Continuer à
// regarder" would leak adult titles even though the catalogue itself is filtered
// (search/detail/reco all apply isAllowedForKids independently).
function getProgressSummaries(userId: number, isKids: boolean = false): ProgressSummary[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT item_type, item_id, media_file_id, position, duration, watched, dismissed, updated_at FROM progress WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?")
    .all(userId, PROGRESS_LIMIT) as ProgressRow[];
  if (!rows.length) return [];

  const movieIds = rows.filter((r) => r.item_type === "movie").map((r) => r.item_id);
  const episodeIds = rows.filter((r) => r.item_type === "episode").map((r) => r.item_id);

  const movieMap = new Map<number, { title: string; posterHash: string | null; backdropHash: string | null; contentRating: string | null }>();
  if (movieIds.length) {
    const placeholders = movieIds.map(() => "?").join(",");
    for (const m of db.prepare(`SELECT id, title, poster_hash, backdrop_hash, content_rating FROM movies WHERE id IN (${placeholders})`).all(...movieIds) as {
      id: number;
      title: string;
      poster_hash: string | null;
      backdrop_hash: string | null;
      content_rating: string | null;
    }[]) {
      movieMap.set(m.id, { title: m.title, posterHash: m.poster_hash, backdropHash: m.backdrop_hash, contentRating: m.content_rating });
    }
  }

  interface EpisodeJoinRow {
    episode_id: number;
    episode_number: number;
    episode_title: string | null;
    thumb_hash: string | null;
    season_number: number;
    show_id: number;
    show_title: string;
    poster_hash: string | null;
    backdrop_hash: string | null;
    content_rating: string | null;
  }
  const episodeMap = new Map<number, EpisodeJoinRow>();
  if (episodeIds.length) {
    const placeholders = episodeIds.map(() => "?").join(",");
    const rowsJoined = db
      .prepare(
        `SELECT e.id AS episode_id, e.episode_number AS episode_number, e.title AS episode_title, e.thumb_hash AS thumb_hash,
                se.season_number AS season_number,
                sh.id AS show_id, sh.title AS show_title, sh.poster_hash AS poster_hash, sh.backdrop_hash AS backdrop_hash,
                sh.content_rating AS content_rating
         FROM episodes e
         JOIN seasons se ON se.id = e.season_id
         JOIN shows sh ON sh.id = e.show_id
         WHERE e.id IN (${placeholders})`,
      )
      .all(...episodeIds) as EpisodeJoinRow[];
    for (const e of rowsJoined) episodeMap.set(e.episode_id, e);
  }

  const summaries: ProgressSummary[] = [];
  for (const r of rows) {
    if (r.item_type === "movie") {
      const m = movieMap.get(r.item_id);
      if (!m) continue; // stale reference to a since-deleted item — skip
      if (isKids && !isAllowedForKids(m.contentRating)) continue; // don't leak adult titles into a kids profile
      summaries.push({
        itemType: "movie",
        itemId: r.item_id,
        mediaFileId: r.media_file_id,
        position: r.position,
        duration: shapeDuration(r),
        watched: r.watched === 1,
        dismissed: r.dismissed === 1,
        updatedAt: r.updated_at,
        topType: "movie",
        topId: r.item_id,
        title: m.title,
        subtitle: null,
        posterHash: m.posterHash,
        backdropHash: m.backdropHash,
        thumbHash: null,
      });
    } else if (r.item_type === "episode") {
      const e = episodeMap.get(r.item_id);
      if (!e) continue;
      if (isKids && !isAllowedForKids(e.content_rating)) continue; // don't leak adult shows into a kids profile
      summaries.push({
        itemType: "episode",
        itemId: r.item_id,
        mediaFileId: r.media_file_id,
        position: r.position,
        duration: shapeDuration(r),
        watched: r.watched === 1,
        dismissed: r.dismissed === 1,
        updatedAt: r.updated_at,
        topType: "show",
        topId: e.show_id,
        title: e.show_title,
        subtitle: `S${e.season_number} : É${e.episode_number}${e.episode_title ? ` — ${e.episode_title}` : ""}`,
        posterHash: e.poster_hash,
        backdropHash: e.backdrop_hash,
        thumbHash: e.thumb_hash,
      });
    }
  }
  return summaries;
}

export function getUserState(userId: number, isKids: boolean = false): UserState {
  return { myList: getMyList(userId), ratings: getRatings(userId), progress: getProgressSummaries(userId, isKids) };
}

function itemExists(itemType: ListItemType, itemId: number): boolean {
  const table = itemType === "movie" ? "movies" : "shows";
  return Boolean(getDb().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(itemId));
}

export function toggleMyList(userId: number, itemType: ListItemType, itemId: number, add: boolean): { ok: boolean; error?: string } {
  if (add && !itemExists(itemType, itemId)) return { ok: false, error: "Introuvable" };
  const db = getDb();
  if (add) {
    db.prepare("INSERT INTO my_list (user_id, item_type, item_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, item_type, item_id) DO NOTHING").run(
      userId,
      itemType,
      itemId,
      Date.now(),
    );
  } else {
    db.prepare("DELETE FROM my_list WHERE user_id = ? AND item_type = ? AND item_id = ?").run(userId, itemType, itemId);
  }
  invalidateReco(userId);
  return { ok: true };
}

const VALID_RATING_VALUES = new Set([-1, 0, 1, 2]);

export function setRating(userId: number, itemType: ListItemType, itemId: number, value: number): { ok: boolean; error?: string } {
  if (!VALID_RATING_VALUES.has(value)) return { ok: false, error: "Valeur invalide" };
  const db = getDb();
  if (value === 0) {
    db.prepare("DELETE FROM ratings WHERE user_id = ? AND item_type = ? AND item_id = ?").run(userId, itemType, itemId);
    invalidateReco(userId);
    return { ok: true };
  }
  if (!itemExists(itemType, itemId)) return { ok: false, error: "Introuvable" };
  db.prepare(
    "INSERT INTO ratings (user_id, item_type, item_id, value, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET value = excluded.value",
  ).run(userId, itemType, itemId, value, Date.now());
  invalidateReco(userId);
  return { ok: true };
}

function progressItemExists(itemType: ProgressItemType, itemId: number): boolean {
  const table = itemType === "movie" ? "movies" : "episodes";
  return Boolean(getDb().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(itemId));
}

export function setProgress(
  userId: number,
  itemType: ProgressItemType,
  itemId: number,
  position: number,
  duration: number,
  mediaFileId: number | null,
): { ok: boolean; error?: string } {
  if (!progressItemExists(itemType, itemId)) return { ok: false, error: "Introuvable" };
  const clampedPosition = Math.max(0, Math.min(position, MAX_POSITION_SECONDS));
  const clampedDuration = Math.max(0, Math.min(duration, MAX_POSITION_SECONDS));
  const watched = computeWatched(clampedPosition, clampedDuration) ? 1 : 0;
  // dismissed is reset on every write: any new playback progress puts the item
  // back into "Continuer à regarder" (see dismissProgress below).
  getDb()
    .prepare(
      `INSERT INTO progress (user_id, item_type, item_id, media_file_id, position, duration, watched, dismissed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET
         media_file_id = excluded.media_file_id, position = excluded.position,
         duration = excluded.duration, watched = excluded.watched, dismissed = 0, updated_at = excluded.updated_at`,
    )
    .run(userId, itemType, itemId, mediaFileId, clampedPosition, clampedDuration, watched, Date.now());
  return { ok: true };
}

/** Force the state a 92% viewing produces naturally (progress row with
 *  position = duration + watched flag, plus a "complete" watch event for the
 *  reco engine on the unwatched -> watched transition), or erase it entirely
 *  ("non vu": the progress row goes away; watch_events stay — they're
 *  historical). A show fans out to every indexed episode in one transaction. */
export function setWatched(userId: number, itemType: WatchedItemType, itemId: number, watched: boolean): { ok: boolean; error?: string } {
  const db = getDb();

  // Resolve the progress-level targets and the (top_type, top_id) the watch
  // event is denormalised on, mirroring recordWatchEvent's resolveTop.
  let targets: { itemId: number; duration: number }[];
  let targetType: ProgressItemType;
  let top: { topType: ListItemType; topId: number };
  if (itemType === "show") {
    if (!itemExists("show", itemId)) return { ok: false, error: "Introuvable" };
    const episodes = db.prepare("SELECT id, duration FROM episodes WHERE show_id = ? ORDER BY id").all(itemId) as { id: number; duration: number }[];
    targets = episodes.map((e) => ({ itemId: e.id, duration: e.duration }));
    targetType = "episode";
    top = { topType: "show", topId: itemId };
  } else {
    if (!progressItemExists(itemType, itemId)) return { ok: false, error: "Introuvable" };
    const table = itemType === "movie" ? "movies" : "episodes";
    const row = db.prepare(`SELECT duration FROM ${table} WHERE id = ?`).get(itemId) as { duration: number };
    targets = [{ itemId, duration: row.duration }];
    targetType = itemType;
    const resolved = resolveTop(itemType, itemId);
    if (!resolved) return { ok: false, error: "Introuvable" };
    top = resolved;
  }

  const now = Date.now();
  const wasWatched = db.prepare("SELECT watched FROM progress WHERE user_id = ? AND item_type = ? AND item_id = ?");
  // MAX(excluded, progress): when the item's indexed duration is unknown (0)
  // but a real one was probed during playback, keep the real one — position
  // must land exactly on it so computeWatched-style ratios read 100%.
  const mark = db.prepare(
    `INSERT INTO progress (user_id, item_type, item_id, media_file_id, position, duration, watched, dismissed, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, 1, 0, ?)
     ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET
       position = MAX(excluded.duration, progress.duration),
       duration = MAX(excluded.duration, progress.duration),
       watched = 1, dismissed = 0, updated_at = excluded.updated_at`,
  );
  const unmark = db.prepare("DELETE FROM progress WHERE user_id = ? AND item_type = ? AND item_id = ?");
  const addEvent = db.prepare(
    `INSERT INTO watch_events (user_id, item_type, item_id, top_type, top_id, kind, ratio, seconds, created_at)
     VALUES (?, ?, ?, ?, ?, 'complete', 1, ?, ?)`,
  );

  db.transaction(() => {
    for (const target of targets) {
      if (!watched) {
        unmark.run(userId, targetType, target.itemId);
        continue;
      }
      const duration = Math.max(0, Math.min(target.duration, MAX_POSITION_SECONDS));
      const already = wasWatched.get(userId, targetType, target.itemId) as { watched: number } | undefined;
      mark.run(userId, targetType, target.itemId, duration, duration, now);
      // Only the unwatched -> watched transition emits a signal, so toggling
      // back and forth never stacks duplicate "complete" events for the engine.
      if (already?.watched !== 1) addEvent.run(userId, targetType, target.itemId, top.topType, top.topId, duration, now);
    }
  })();

  invalidateReco(userId);
  return { ok: true };
}

/** Remove one entry from "Continuer à regarder" WITHOUT marking it watched or
 *  destroying its position — resume from the detail sheet keeps working. The
 *  flag is cleared by the next setProgress write for the same item. */
export function dismissProgress(userId: number, itemType: ProgressItemType, itemId: number): { ok: boolean; error?: string } {
  const result = getDb().prepare("UPDATE progress SET dismissed = 1 WHERE user_id = ? AND item_type = ? AND item_id = ?").run(userId, itemType, itemId);
  if (result.changes === 0) return { ok: false, error: "Introuvable" };
  // No invalidateReco: dismissal writes nothing the reco engine reads
  // (my_list/ratings/watch_events are untouched).
  return { ok: true };
}

export type WatchEventKind = "complete" | "abandon";

/** Resolve a progress-scoped item to the (top_type, top_id) watch_events is
 *  denormalised on — a movie credits itself, an episode credits its show —
 *  so the Phase 7 reco engine can aggregate signals per series without a join. */
function resolveTop(itemType: ProgressItemType, itemId: number): { topType: ListItemType; topId: number } | null {
  if (itemType === "movie") return itemExists("movie", itemId) ? { topType: "movie", topId: itemId } : null;
  const row = getDb().prepare("SELECT show_id FROM episodes WHERE id = ?").get(itemId) as { show_id: number } | undefined;
  return row ? { topType: "show", topId: row.show_id } : null;
}

/** Record one watch signal (finished, or abandoned early) for the Phase 7
 *  taste engine to consume later. Purely additive/historical — never
 *  overwrites or reads back a prior row, unlike progress. */
export function recordWatchEvent(
  userId: number,
  itemType: ProgressItemType,
  itemId: number,
  kind: WatchEventKind,
  ratio: number,
  seconds: number,
): { ok: boolean; error?: string } {
  const top = resolveTop(itemType, itemId);
  if (!top) return { ok: false, error: "Introuvable" };
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const clampedSeconds = Math.max(0, Math.min(seconds, MAX_POSITION_SECONDS));
  getDb()
    .prepare(
      `INSERT INTO watch_events (user_id, item_type, item_id, top_type, top_id, kind, ratio, seconds, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, itemType, itemId, top.topType, top.topId, kind, clampedRatio, clampedSeconds, Date.now());
  invalidateReco(userId);
  return { ok: true };
}
