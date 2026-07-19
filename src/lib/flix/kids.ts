// Simple, deliberately conservative content-rating gate for "kids" profiles
// (users.is_kids = 1). Real-world self-scanned libraries mix wildly
// inconsistent rating systems (MPAA, BBFC, French CSA, US TV parental
// guidelines, or nothing at all) with no single canonical field, so rather
// than an allowlist — which would hide everything whose rating we fail to
// recognise, including the common case of NO rating at all — this blocks a
// small, explicit set of "clearly adult" markers and lets everything else
// through. A real parental-control / reco engine can replace this later
// (Phase 7); this is intentionally simple for now, per the Phase 5 plan.

// Whole-string "clearly adult" markers NOT already covered by the numeric
// \b1[68]\b regex in isAllowedForKids ("18", "18+", "-18" would be redundant
// with it). "R18" stays: the regex needs a word boundary before the digits and
// "R18" has a letter there, so only this exact-match entry catches it.
const ADULT_MARKERS = new Set([
  "R",
  "NC-17",
  "NC17",
  "X",
  "XXX",
  "AO",
  "TV-MA",
  "R18",
  "INTERDIT AUX MOINS DE 18 ANS",
]);

/** Whether an item with this content rating should be visible to a kids
 *  profile. Missing/unrecognised ratings default to ALLOWED (fail-open) —
 *  see the module doc for why. */
export function isAllowedForKids(contentRating: string | null | undefined): boolean {
  if (!contentRating) return true;
  const normalized = contentRating.trim().toUpperCase();
  if (!normalized) return true;
  if (ADULT_MARKERS.has(normalized)) return false;
  // Catches French/European "-16"/"-18"/"16+"/"18+" variants embedded in a
  // longer label (e.g. "Déconseillé -16 ans") that the exact-match set above
  // won't hit verbatim.
  if (/\b1[68]\b/.test(normalized)) return false;
  return true;
}

/** Filter applied wherever a kids profile browses the catalogue. The server
 *  is the authoritative gate (GET /api/library filters the shared snapshot
 *  per-profile before it leaves the process); the client-side use in
 *  useCatalog.ts is defense in depth on top of that, not the only barrier. */
export function filterForProfile<T extends { contentRating: string | null }>(items: T[], isKids: boolean): T[] {
  if (!isKids) return items;
  return items.filter((item) => isAllowedForKids(item.contentRating));
}
