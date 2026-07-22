// Pure display-formatting helpers shared by every component that renders a
// duration (Card overlay, DetailModal, EpisodeRow) or the « Nouveau » badge
// (Card).

/** "1 h 42 min" / "48 min" — never negative, rounds to the nearest minute. */
export function formatDuration(totalSeconds: number): string {
  // Round to whole minutes FIRST, then split into hours/minutes. Rounding the
  // within-the-hour remainder separately can carry to 60 (3599s → « 60 min »,
  // 7199s → « 1 h 60 min ») instead of rolling into the next hour.
  const totalMinutes = Math.round(Math.max(0, totalSeconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} min`;
  return `${minutes} min`;
}

/** How long an item wears the « Nouveau » badge after being added. */
export const NEW_BADGE_WINDOW_MS = 14 * 24 * 3600 * 1000;

/** Whether an item counts as « Nouveau » : added strictly less than 14 days
 *  ago. An unknown addedAt (0 — the scanner's default) is never new; a
 *  slightly-future timestamp (clock skew between scanner and browser) still
 *  is. Pure — `now` is injectable for tests. */
export function isNew(addedAt: number, now: number = Date.now()): boolean {
  return addedAt > 0 && now - addedAt < NEW_BADGE_WINDOW_MS;
}

/** Whether the « Nouveau » badge still carries signal for a catalogue: true only
 *  when new items are a MINORITY (≤ 1/3). Right after a first import 100% of the
 *  library is "new" at once, so a pill on every tile is pure noise — suppress it
 *  then. Applied uniformly on Home AND the browse/search/list grids so the same
 *  catalogue never shows the badge on one surface and hides it on another. */
export function newBadgeMeaningful(items: { addedAt: number }[], now: number = Date.now()): boolean {
  if (items.length === 0) return true;
  return items.filter((i) => isNew(i.addedAt, now)).length <= items.length / 3;
}
