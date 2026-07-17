// Parental-control gate for the playback layer. The browse/search/detail
// routes already hide adult titles from kids profiles (is_kids = 1) behind a
// 404 — never a 403 — so their existence is never confirmed. But media_files
// and subtitles ids are small, enumerable integers: without the same gate on
// the routes that take them raw (/api/stream, /api/play/decision,
// /api/play/session, /api/subs), a kids profile could simply play any adult
// title directly. Both checks below resolve the file's parent item (movie, or
// episode → show) and apply the exact same content-rating rule as the rest of
// the app (isAllowedForKids); callers turn a refusal into their route's usual
// 404 shape.

import { getDb } from "../db";
import { isAllowedForKids } from "@/lib/flix/kids";

/** Whether this user may play this media file. Non-kids profiles may play
 *  everything. A missing fileId deliberately returns true — the caller's own
 *  lookup surfaces its usual 404, keeping "doesn't exist" and "hidden from
 *  kids" byte-identical to a probing client. */
export function isFileAllowedForUser(user: { is_kids: number }, fileId: number): boolean {
  if (user.is_kids !== 1) return true;
  const row = getDb()
    .prepare(
      `SELECT COALESCE(m.content_rating, s.content_rating) AS content_rating
       FROM media_files f
       LEFT JOIN movies m ON m.id = f.movie_id
       LEFT JOIN episodes e ON e.id = f.episode_id
       LEFT JOIN shows s ON s.id = e.show_id
       WHERE f.id = ?`,
    )
    .get(fileId) as { content_rating: string | null } | undefined;
  if (!row) return true;
  return isAllowedForKids(row.content_rating);
}

/** Same gate, keyed by subtitles.id — the subs route never sees a fileId. */
export function isSubtitleAllowedForUser(user: { is_kids: number }, subtitleId: number): boolean {
  if (user.is_kids !== 1) return true;
  const row = getDb().prepare("SELECT media_file_id FROM subtitles WHERE id = ?").get(subtitleId) as { media_file_id: number } | undefined;
  if (!row) return true;
  return isFileAllowedForUser(user, row.media_file_id);
}
