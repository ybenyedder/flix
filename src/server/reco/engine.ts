// ============================================================================
// TASTE ENGINE — feedback-driven video recommendations
// ----------------------------------------------------------------------------
// Learns a per-user taste profile from watch_events/my_list/ratings and scores
// every catalogue item against it. Signals, oldest-to-strongest:
//
//   completed watch  → positive, scaled by how much of it was actually seen
//   abandoned watch   → negative, stronger the earlier the bail
//   my list           → positive (deliberate "I want this")
//   thumbs up         → strong positive
//   "love it"         → stronger positive
//   thumbs down       → strong negative + HARD exclude everywhere
//
// Every signal decays with a 45-day half-life, so the profile tracks CURRENT
// taste, not a year-old binge. Each item is scored on four axes:
//
//   direct         — the user's own verdict on THIS exact item (complete vs abandon)
//   content        — how close the item sits to what they complete/like, in
//                    genre/decade/duration/people/studio space (src/lib/flix/reco.ts)
//   genreAffinity  — standing signed affinity for the item's genre(s)
//   explore        — a small nudge for anything never watched
//
// The content axis is what generalises a single signal: abandon a couple of
// action films early and OTHER, never-watched action films cool down too —
// that's the genre-level "use real catalogue metadata" goal from the plan.
//
// This file owns the public facade and the module-level caches; the pure
// pieces live in sibling modules: catalogue indexing (./catalogIndex), signal
// aggregation (./aggregates) and the scoring math (./scoring).
//
// Model: /home/pc/Documents/auralis_enterprise_grade/src/server/reco/engine.ts
// ============================================================================

import { getDb } from "../db";
import { getSnapshotEtag } from "../library/repository";
import { isAllowedForKids } from "@/lib/flix/kids";
import { contentSimilarity } from "@/lib/flix/reco";
import { decay, scoreItem } from "./scoring";
import { buildAggregates, type Aggregates } from "./aggregates";
import { buildCatalogIndex, type ItemRow, type ItemType } from "./catalogIndex";

const DAY = 86_400_000;
const TOPTEN_WINDOW_MS = 30 * DAY;
const TOPTEN_HALF_LIFE_MS = 7 * DAY;

export interface ScoredRef {
  type: ItemType;
  id: number;
  score: number;
}

// ---------------------------------------------------------------------------
// Catalogue feature index — user-independent, rebuilt only when the library
// snapshot's own version changes (same fingerprint repository.ts's cache
// uses), never per user. The pure builder lives in ./catalogIndex; this owns
// the module-level cache.
// ---------------------------------------------------------------------------

let catalogCache: { version: string; items: Map<string, ItemRow> } | null = null;

function getCatalogIndex(): Map<string, ItemRow> {
  const version = getSnapshotEtag();
  if (catalogCache && catalogCache.version === version) return catalogCache.items;
  const items = buildCatalogIndex();
  catalogCache = { version, items };
  return items;
}

// ---------------------------------------------------------------------------
// Per-user cache — a burst of calls (Home fetching recommend + top10 + genre
// rows + because-you-watched together) computes the profile once. Cheap to
// recompute, so the TTL is short.
// ---------------------------------------------------------------------------

interface UserReco {
  agg: Aggregates;
  scores: Map<string, number>;
}

const cache = new Map<number, { at: number; value: UserReco }>();
const CACHE_TTL_MS = 2500;

function computeUserReco(userId: number, isKids: boolean, catalog: Map<string, ItemRow>): UserReco {
  const agg = buildAggregates(userId, catalog);
  const scores = new Map<string, number>();
  for (const item of catalog.values()) {
    const s = scoreItem(item, agg, catalog, isKids);
    if (s !== null) scores.set(item.key, s);
  }
  return { agg, scores };
}

function getState(userId: number, isKids: boolean): UserReco & { catalog: Map<string, ItemRow> } {
  const catalog = getCatalogIndex();
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, catalog };
  const value = computeUserReco(userId, isKids, catalog);
  cache.set(userId, { at: Date.now(), value });
  return { ...value, catalog };
}

/** Drop a user's memoised profile so the next request recomputes it — call
 *  after any write that changes their taste signals (my list, rating, watch
 *  event, kids-flag change). Best-effort: the short TTL would catch it anyway. */
export function invalidateReco(userId: number): void {
  cache.delete(userId);
}

function excludedFromDiscoveryRows(key: string, agg: Aggregates): boolean {
  return agg.recentlyCompleted.has(key) && !agg.rewatchEligible.has(key);
}

/** Raw score for every non-hard-excluded catalogue item — the source of the
 *  "match %" badge shown on every Card (via matchPercent()) as well as the
 *  ranking every row below is built from. */
export function scoreAll(userId: number, isKids: boolean): Map<string, number> {
  return getState(userId, isKids).scores;
}

/** The personalised "Notre sélection pour vous" row: every eligible item
 *  ranked by taste score, excluding anything finished too recently to be a
 *  useful suggestion (see REWATCH_AFTER_MS). */
export function recommend(userId: number, isKids: boolean, limit = 60): ScoredRef[] {
  const { agg, scores, catalog } = getState(userId, isKids);
  const out: ScoredRef[] = [];
  for (const [key, score] of scores) {
    if (excludedFromDiscoveryRows(key, agg)) continue;
    const item = catalog.get(key);
    if (item) out.push({ type: item.type, id: item.id, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, limit));
}

/** "À découvrir": items never watched, or watched 180+ days ago and loved
 *  enough to resurface as a deliberate rewatch pick. */
export function discover(userId: number, isKids: boolean, limit = 30): ScoredRef[] {
  const { agg, scores, catalog } = getState(userId, isKids);
  const out: ScoredRef[] = [];
  for (const [key, score] of scores) {
    if (agg.seen.has(key) && !agg.rewatchEligible.has(key)) continue;
    const item = catalog.get(key);
    if (item) out.push({ type: item.type, id: item.id, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, limit));
}

/** The 2-3 genres this user gravitates to most, each as a ranked row. Empty
 *  for a cold-start profile (no positive genre affinity yet) — the caller
 *  falls back to the simple "most represented genre" heuristic in that case. */
export function genreRows(userId: number, isKids: boolean, maxRows = 3, perRow = 20): { genre: string; items: ScoredRef[] }[] {
  const { agg, scores, catalog } = getState(userId, isKids);
  const topGenres = [...agg.genreAffinity.entries()]
    .filter(([, w]) => w > 0.05)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxRows)
    .map(([g]) => g);

  const rows = topGenres.map((genre) => {
    const items: ScoredRef[] = [];
    for (const [key, score] of scores) {
      const item = catalog.get(key);
      if (!item || !item.genres.includes(genre)) continue;
      if (excludedFromDiscoveryRows(key, agg)) continue;
      items.push({ type: item.type, id: item.id, score });
    }
    items.sort((a, b) => b.score - a.score);
    return { genre, items: items.slice(0, perRow) };
  });
  return rows.filter((row) => row.items.length > 0);
}

export interface BecauseRow {
  seedType: ItemType;
  seedId: number;
  seedTitle: string;
  items: ScoredRef[];
}

/** "Parce que vous avez regardé X": up to `maxSeeds` seed items the user is
 *  currently most positive about (freshest completions dominate as older signals
 *  decay, so these skew most-recent — but my-list/rating boosts count too, so it
 *  is NOT a strict chronological sort), each paired with its most content-similar
 *  UNSEEN items. Never recommends anything the user has already watched (any time,
 *  complete or abandoned), disliked, or — for a kids profile — content-gated. */
export function becauseYouWatched(userId: number, isKids: boolean, maxSeeds = 3, perSeed = 20): BecauseRow[] {
  const { agg, catalog } = getState(userId, isKids);

  // Seeds: the items the user is currently most positive about among those
  // they've actually watched — freshest completions dominate naturally since
  // older signals have already decayed, so this doubles as "most recent".
  const seeds = [...agg.pos.entries()]
    .filter(([key]) => agg.seen.has(key) && !agg.disliked.has(key) && catalog.has(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, maxSeeds))
    .map(([key]) => key);

  const rows: BecauseRow[] = [];
  for (const seedKey of seeds) {
    const seedItem = catalog.get(seedKey);
    if (!seedItem) continue;
    if (isKids && !isAllowedForKids(seedItem.contentRating)) continue;

    const scored: ScoredRef[] = [];
    for (const item of catalog.values()) {
      if (item.key === seedKey) continue;
      if (agg.seen.has(item.key)) continue;
      if (agg.disliked.has(item.key)) continue;
      if (isKids && !isAllowedForKids(item.contentRating)) continue;
      const sim = contentSimilarity(seedItem.features, item.features);
      scored.push({ type: item.type, id: item.id, score: sim });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length) rows.push({ seedType: seedItem.type, seedId: seedItem.id, seedTitle: seedItem.title, items: scored.slice(0, perSeed) });
  }
  return rows;
}

interface TopTenEventRow {
  top_id: number;
  kind: string;
  ratio: number;
  created_at: number;
}

/** Global "Top 10" for a content type: Σ over the last 30 days of
 *  decay(age,7d)·(complete:1, abandon:ratio·0.5) per top_id, across every
 *  profile on the server (Netflix's real Top 10 isn't personalised either).
 *  A kids profile never sees adult-gated content in the ranking. */
export function topTen(type: ItemType, isKids: boolean, limit = 10): ScoredRef[] {
  const db = getDb();
  const catalog = getCatalogIndex();
  const now = Date.now();
  const rows = db
    .prepare("SELECT top_id, kind, ratio, created_at FROM watch_events WHERE top_type = ? AND created_at >= ?")
    .all(type, now - TOPTEN_WINDOW_MS) as TopTenEventRow[];

  const totals = new Map<number, number>();
  for (const r of rows) {
    const item = catalog.get(`${type}:${r.top_id}`);
    if (!item) continue;
    if (isKids && !isAllowedForKids(item.contentRating)) continue;
    const d = decay(now - r.created_at, TOPTEN_HALF_LIFE_MS);
    const w = (r.kind === "complete" ? 1 : r.ratio * 0.5) * d;
    totals.set(r.top_id, (totals.get(r.top_id) ?? 0) + w);
  }

  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, limit))
    .map(([id, score]) => ({ type, id, score }));
}

/** The billboard pick: the user's own top personalised suggestion once they
 *  have any taste signal at all, else the most recently added eligible item
 *  (the same "fallback: ajout récent" BillboardHero.tsx already documents). */
export function pickBillboard(userId: number, isKids: boolean): ScoredRef | null {
  const { agg, scores, catalog } = getState(userId, isKids);

  if (agg.signals > 0) {
    let best: ScoredRef | null = null;
    for (const [key, score] of scores) {
      if (excludedFromDiscoveryRows(key, agg)) continue;
      if (!best || score > best.score) {
        const item = catalog.get(key);
        if (item) best = { type: item.type, id: item.id, score };
      }
    }
    if (best) return best;
  }

  let fallback: ScoredRef | null = null;
  let fallbackAddedAt = -Infinity;
  for (const [key, score] of scores) {
    const item = catalog.get(key);
    if (item && item.addedAt > fallbackAddedAt) {
      fallbackAddedAt = item.addedAt;
      fallback = { type: item.type, id: item.id, score };
    }
  }
  return fallback;
}
