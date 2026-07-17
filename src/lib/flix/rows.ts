// Pure Home-row building blocks: sorting, genre aggregation, "related items"
// heuristic. These predate the Phase 7 taste engine (src/server/reco/engine.ts)
// and now serve as its cold-start fallback — a brand-new profile with zero
// watch history still gets a populated (if impersonal) Home/DetailModal.

import type { CatalogEntry } from "./types";
import { qualityLabel } from "./quality";

export type { CatalogEntry as CatalogItem } from "./types";

/** Newest-added first. Stable enough across renders (not random) so a Home
 *  reload doesn't shuffle the "featured" pick or the rows under it. */
export function sortByAddedDesc<T extends { addedAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.addedAt - a.addedAt);
}

/** The `limit` most common genres across `items`, most frequent first. Ties
 *  keep encounter order (Array.sort is stable). */
export function topGenres(items: { genres: string[] }[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const genre of item.genres) counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit))
    .map(([genre]) => genre);
}

export function itemsByGenre<T extends { genres: string[] }>(items: T[], genre: string): T[] {
  return items.filter((item) => item.genres.includes(genre));
}

export interface GenreRow {
  genre: string;
  items: CatalogEntry[];
}

/** Home's genre rows: the `maxRows` most-represented genres across the whole
 *  catalogue, each capped to `perRow` items (newest first). */
export function buildGenreRows(items: CatalogEntry[], maxRows: number, perRow: number): GenreRow[] {
  return topGenres(items, maxRows).map((genre) => ({
    genre,
    items: sortByAddedDesc(itemsByGenre(items, genre)).slice(0, perRow),
  }));
}

// --- Browse (Films/Séries) toolbar: combinable filters + sort ------------
// All pure so BrowseView stays a thin useState wrapper around these.

export type BrowseSort = "recent" | "alpha" | "year" | "duration";

export interface BrowseFilters {
  /** Multi-select genre chips — an item must carry EVERY selected genre
   *  (each added chip refines the grid rather than widening it). */
  genres: string[];
  /** Decade start year (1990 covers 1990–1999), or null for all years. */
  decade: number | null;
  /** Keep only titles the profile hasn't finished watching (see buildSeenKeys). */
  unseenOnly: boolean;
  /** Keep only titles whose best file is 4K (same threshold as the card badge). */
  fourK: boolean;
  hdr: boolean;
}

export const EMPTY_BROWSE_FILTERS: BrowseFilters = { genres: [], decade: null, unseenOnly: false, fourK: false, hdr: false };

export function hasActiveBrowseFilters(filters: BrowseFilters): boolean {
  return filters.genres.length > 0 || filters.decade !== null || filters.unseenOnly || filters.fourK || filters.hdr;
}

/** Decade of a year: 1994 -> 1990. */
export function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

/** Distinct decades present across `items`, newest first. Missing years are
 *  simply skipped (they can never match a decade filter anyway). */
export function availableDecades(items: { year: number | null }[]): number[] {
  const decades = new Set<number>();
  for (const item of items) if (item.year !== null) decades.add(decadeOf(item.year));
  return [...decades].sort((a, b) => b - a);
}

/** `"type:id"` keys of top-level titles the profile has FINISHED watching —
 *  a watched movie, or a show with at least one watched episode. Items merely
 *  in progress (started, unfinished) still count as "non vus": they already
 *  live in "Continuer à regarder", and "Surprends-moi" shouldn't re-suggest
 *  half-seen titles as surprises either way. */
export function buildSeenKeys(progress: { topType: "movie" | "show"; topId: number; watched: boolean }[]): Set<string> {
  const seen = new Set<string>();
  for (const entry of progress) if (entry.watched) seen.add(`${entry.topType}:${entry.topId}`);
  return seen;
}

/** A movie's runtime in seconds, or null when unknown (0) or when the item is
 *  a show — shows carry per-episode durations only, no meaningful total. */
function itemDuration(item: CatalogEntry): number | null {
  return item.type === "movie" && item.duration > 0 ? item.duration : null;
}

/** Compare two nullable numbers, nulls always LAST regardless of direction. */
function compareNullable(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * direction;
}

/** All filters combine with AND. `seen` comes from buildSeenKeys() and is only
 *  consulted when `unseenOnly` is set. Never mutates `items`. */
export function applyBrowseFilters(items: CatalogEntry[], filters: BrowseFilters, seen: ReadonlySet<string> = new Set()): CatalogEntry[] {
  return items.filter((item) => {
    if (filters.genres.length > 0 && !filters.genres.every((genre) => item.genres.includes(genre))) return false;
    if (filters.decade !== null && (item.year === null || decadeOf(item.year) !== filters.decade)) return false;
    if (filters.fourK && qualityLabel(item.quality.height) !== "4K") return false;
    if (filters.hdr && !item.quality.hdr) return false;
    if (filters.unseenOnly && seen.has(`${item.type}:${item.id}`)) return false;
    return true;
  });
}

/** Stable sort (ties keep input order — Array.sort is stable), new array.
 *  "recent" newest-added first, "alpha" French-locale sortTitle, "year"
 *  newest year first, "duration" shortest first; missing year/duration last. */
export function sortBrowseItems(items: CatalogEntry[], sort: BrowseSort): CatalogEntry[] {
  const copy = [...items];
  switch (sort) {
    case "recent":
      return copy.sort((a, b) => b.addedAt - a.addedAt);
    case "alpha":
      return copy.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle, "fr", { sensitivity: "base" }));
    case "year":
      return copy.sort((a, b) => compareNullable(a.year, b.year, -1));
    case "duration":
      return copy.sort((a, b) => compareNullable(itemDuration(a), itemDuration(b), 1));
  }
}

// --- "Surprends-moi": weighted random pick --------------------------------

/** Random unwatched title, biased towards the recommendation rows: rank r of
 *  a row contributes weight 1/(r+1), summed across rows (a title surfaced by
 *  several rows weighs more). Refs missing from `catalog` (e.g. filtered out
 *  for a kids profile) and titles in `seen` are skipped. When the reco rows
 *  yield nothing, falls back to a uniform pick over unseen catalogue titles,
 *  then over the whole catalogue; null only when `catalog` is empty.
 *  `random` must return [0, 1) — injected for deterministic tests. */
export function pickSurprise(
  rows: { items: { type: "movie" | "show"; id: number }[] }[],
  catalog: CatalogEntry[],
  seen: ReadonlySet<string> = new Set(),
  random: () => number = Math.random,
): CatalogEntry | null {
  if (catalog.length === 0) return null;
  const byKey = new Map<string, CatalogEntry>();
  for (const item of catalog) byKey.set(`${item.type}:${item.id}`, item);

  const pool = new Map<string, { item: CatalogEntry; weight: number }>();
  for (const row of rows) {
    row.items.forEach((ref, index) => {
      const key = `${ref.type}:${ref.id}`;
      const item = byKey.get(key);
      if (!item || seen.has(key)) return;
      const weight = 1 / (index + 1);
      const existing = pool.get(key);
      if (existing) existing.weight += weight;
      else pool.set(key, { item, weight });
    });
  }

  if (pool.size > 0) {
    const entries = [...pool.values()];
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    let r = random() * total;
    for (const entry of entries) {
      r -= entry.weight;
      if (r < 0) return entry.item;
    }
    return entries[entries.length - 1].item; // float rounding edge
  }

  const unseen = catalog.filter((item) => !seen.has(`${item.type}:${item.id}`));
  const from = unseen.length > 0 ? unseen : catalog;
  return from[Math.min(from.length - 1, Math.floor(random() * from.length))];
}

/** "Plus comme ça" — items sharing the most genres with `target`, newest
 *  first as a tiebreak. Excludes the target itself. Zero shared genres are
 *  dropped entirely rather than padding the row with unrelated titles. */
export function relatedItems(target: { type: string; id: number; genres: string[] }, items: CatalogEntry[], limit = 20): CatalogEntry[] {
  const targetGenres = new Set(target.genres);
  if (targetGenres.size === 0) return [];
  return items
    .filter((item) => !(item.type === target.type && item.id === target.id))
    .map((item) => ({ item, score: item.genres.filter((g) => targetGenres.has(g)).length }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.addedAt - a.item.addedAt)
    .slice(0, limit)
    .map((entry) => entry.item);
}
