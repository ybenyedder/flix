// ============================================================================
// Scoring math — pure, stateless functions that turn a candidate item plus a
// user's aggregated taste profile into a single score (or a hard exclusion).
// No DB, no caches, no module state: every dependency is passed in. Also holds
// the two shared numeric primitives (tanh squash, exponential decay) and the
// score-axis weights the engine is tuned around.
// ============================================================================

import { isAllowedForKids } from "@/lib/flix/kids";
import { contentSimilarity } from "@/lib/flix/reco";
import type { ItemRow } from "./catalogIndex";
import type { Aggregates, WeightedRef } from "./aggregates";

export const tanh = Math.tanh;
export const decay = (ageMs: number, halfLife: number): number => (ageMs <= 0 ? 1 : Math.pow(0.5, ageMs / halfLife));

// Score-axis weights — mirrors Auralis's W_DIRECT/W_CONTENT/W_MOOD relative
// magnitudes (that reference engine is what this file explicitly adapts).
const W_DIRECT = 1.0;
const W_CONTENT = 0.85;
const W_GENRE = 0.6;
const EXPLORE_BONUS = 0.18;
const CONTENT_NEG_WEIGHT = 0.6;

function weightedAvgSimilarity(item: ItemRow, weighted: WeightedRef[], catalog: Map<string, ItemRow>): number {
  let sum = 0;
  let wsum = 0;
  for (const { key, weight } of weighted) {
    if (key === item.key) continue;
    const other = catalog.get(key);
    if (!other) continue;
    sum += contentSimilarity(item.features, other.features) * weight;
    wsum += weight;
  }
  return wsum > 0 ? sum / wsum : 0;
}

function averageGenreAffinity(genres: string[], genreAffinity: Map<string, number>): number {
  if (!genres.length) return 0;
  let sum = 0;
  let n = 0;
  for (const g of genres) {
    const a = genreAffinity.get(g);
    if (a !== undefined) {
      sum += a;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Score one item against a user's profile, or null if hard-excluded
 *  (disliked, or blocked for a kids profile). */
export function scoreItem(item: ItemRow, agg: Aggregates, catalog: Map<string, ItemRow>, isKids: boolean): number | null {
  if (agg.disliked.has(item.key)) return null;
  if (isKids && !isAllowedForKids(item.contentRating)) return null;

  const pos = agg.pos.get(item.key) ?? 0;
  const neg = agg.neg.get(item.key) ?? 0;
  const direct = tanh(pos - neg);

  const posSim = weightedAvgSimilarity(item, agg.topPositive, catalog);
  const negSim = weightedAvgSimilarity(item, agg.topNegative, catalog);
  const content = posSim - CONTENT_NEG_WEIGHT * negSim;

  const genreAff = averageGenreAffinity(item.genres, agg.genreAffinity);
  const explore = agg.seen.has(item.key) ? 0 : EXPLORE_BONUS;

  return W_DIRECT * direct + W_CONTENT * content + W_GENRE * genreAff + explore;
}
