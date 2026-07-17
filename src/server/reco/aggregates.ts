// ============================================================================
// Per-user taste aggregates — folds a user's watch_events / my_list / ratings
// into the decayed, windowed signal profile the scorer consumes: positive /
// negative weights per item, signed genre affinity, seen / recently-completed /
// rewatch-eligible sets and the top-N signals used for content similarity.
// Pure builder: takes the catalogue index + userId, reads the DB, returns an
// Aggregates. The per-user memoisation cache lives in engine.ts.
// ============================================================================

import { getDb } from "../db";
import { tanh, decay } from "./scoring";
import type { ItemRow } from "./catalogIndex";

const DAY = 86_400_000;
const HALF_LIFE_MS = 45 * DAY;
// Events older than this no longer contribute WEIGHT (they've decayed to
// under 0.2% of their original strength — 11+ half-lives), so excluding them
// from the aggregation leaves the profile unchanged while bounding the work.
// This bounds computation only: "seen" status itself (below) is read from the
// full, unwindowed history, since a signal's exclusion-relevance must never
// expire just because its score contribution has.
const EVENTS_WINDOW_MS = 365 * DAY;
// A title finished less than this long ago is excluded from personalised
// discovery rows (recommend/genre rows) unless the user loved it enough to
// re-surface as a deliberate "regarder à nouveau" pick.
const REWATCH_AFTER_MS = 180 * DAY;
// Binge detection: N+ same-show episode completions within this rolling gap
// count as one binge session.
const BINGE_GAP_MS = 4 * 3600_000;
const BINGE_MIN_RUN = 3;
const BINGE_MULTIPLIER = 1.2;

const MY_LIST_WEIGHT = 2.0;
const THUMBS_UP_WEIGHT = 2.5;
const LOVE_WEIGHT = 3.5;
const THUMBS_DOWN_WEIGHT = 3.5;

const TOP_SIGNAL_COUNT = 30;

export interface WeightedRef {
  key: string;
  weight: number;
}

export interface Aggregates {
  pos: Map<string, number>;
  neg: Map<string, number>;
  disliked: Set<string>;
  /** Signed, tanh-normalised affinity per genre, roughly in [-1, 1]. */
  genreAffinity: Map<string, number>;
  /** Every top_id the user has ever completed or abandoned — never expires. */
  seen: Set<string>;
  /** Completed within the last 180 days — excluded from discovery rows. */
  recentlyCompleted: Set<string>;
  /** Completed 180+ days ago AND loved (my list or rating >= 1) — eligible "revoir". */
  rewatchEligible: Set<string>;
  topPositive: WeightedRef[];
  topNegative: WeightedRef[];
  /** Total weighted signals folded in (profile strength; 0 = cold start). */
  signals: number;
}

interface WatchEventRow {
  item_type: string;
  top_type: string;
  top_id: number;
  kind: string;
  ratio: number;
  created_at: number;
}

export function buildAggregates(userId: number, catalog: Map<string, ItemRow>): Aggregates {
  const db = getDb();
  const now = Date.now();

  const pos = new Map<string, number>();
  const neg = new Map<string, number>();
  const genreSigned = new Map<string, number>();
  let signals = 0;

  const bumpGenre = (key: string, signed: number) => {
    const item = catalog.get(key);
    if (!item) return;
    for (const g of item.genres) genreSigned.set(g, (genreSigned.get(g) ?? 0) + signed);
  };

  // Unwindowed on purpose: "seen" and "last completed at" must never expire
  // just because a signal's WEIGHT has decayed away — only the weight
  // contribution below is bounded by EVENTS_WINDOW_MS.
  const events = db
    .prepare("SELECT item_type, top_type, top_id, kind, ratio, created_at FROM watch_events WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId) as WatchEventRow[];

  const seen = new Set<string>();
  const lastCompleteAt = new Map<string, number>();
  const episodeCompletesByShow = new Map<number, number[]>();

  for (const e of events) {
    const key = `${e.top_type}:${e.top_id}`;
    seen.add(key);
    if (e.kind === "complete") {
      if (e.created_at > (lastCompleteAt.get(key) ?? 0)) lastCompleteAt.set(key, e.created_at);
      if (e.item_type === "episode" && e.top_type === "show") {
        const arr = episodeCompletesByShow.get(e.top_id);
        if (arr) arr.push(e.created_at);
        else episodeCompletesByShow.set(e.top_id, [e.created_at]);
      }
    }

    const age = now - e.created_at;
    if (age > EVENTS_WINDOW_MS) continue;
    const d = decay(age, HALF_LIFE_MS);
    if (e.kind === "complete") {
      const w = (0.5 + 0.5 * e.ratio) * d;
      pos.set(key, (pos.get(key) ?? 0) + w);
      bumpGenre(key, w);
      signals += w;
    } else {
      const w = (0.9 * (1 - e.ratio) + 0.1) * d;
      neg.set(key, (neg.get(key) ?? 0) + w);
      bumpGenre(key, -w);
      signals += w;
    }
  }

  // Binge bonus: N+ same-show episode completions within a rolling gap window
  // multiply that show's positive weight once — capped, never stacked further
  // by additional episodes in the same or another binge session.
  for (const [showId, timestamps] of episodeCompletesByShow) {
    timestamps.sort((a, b) => a - b);
    let run = 1;
    let bingeing = false;
    for (let i = 1; i < timestamps.length; i++) {
      run = timestamps[i] - timestamps[i - 1] <= BINGE_GAP_MS ? run + 1 : 1;
      if (run >= BINGE_MIN_RUN) bingeing = true;
    }
    if (bingeing) {
      const key = `show:${showId}`;
      const current = pos.get(key) ?? 0;
      if (current > 0) pos.set(key, current * BINGE_MULTIPLIER);
    }
  }

  const myListRows = db.prepare("SELECT item_type, item_id, created_at FROM my_list WHERE user_id = ?").all(userId) as {
    item_type: string;
    item_id: number;
    created_at: number;
  }[];
  const myList = new Set<string>();
  for (const r of myListRows) {
    const key = `${r.item_type}:${r.item_id}`;
    myList.add(key);
    const w = MY_LIST_WEIGHT * decay(now - (r.created_at || now), HALF_LIFE_MS);
    pos.set(key, (pos.get(key) ?? 0) + w);
    bumpGenre(key, w);
    signals += w;
  }

  const ratingRows = db.prepare("SELECT item_type, item_id, value, created_at FROM ratings WHERE user_id = ?").all(userId) as {
    item_type: string;
    item_id: number;
    value: number;
    created_at: number;
  }[];
  const disliked = new Set<string>();
  const positiveRating = new Set<string>();
  for (const r of ratingRows) {
    const key = `${r.item_type}:${r.item_id}`;
    const d = decay(now - (r.created_at || now), HALF_LIFE_MS);
    if (r.value === -1) {
      disliked.add(key);
      const w = THUMBS_DOWN_WEIGHT * d;
      neg.set(key, (neg.get(key) ?? 0) + w);
      bumpGenre(key, -w);
      signals += w;
    } else if (r.value === 1 || r.value === 2) {
      positiveRating.add(key);
      const w = (r.value === 2 ? LOVE_WEIGHT : THUMBS_UP_WEIGHT) * d;
      pos.set(key, (pos.get(key) ?? 0) + w);
      bumpGenre(key, w);
      signals += w;
    }
  }

  const recentlyCompleted = new Set<string>();
  const rewatchEligible = new Set<string>();
  for (const [key, ts] of lastCompleteAt) {
    if (now - ts < REWATCH_AFTER_MS) recentlyCompleted.add(key);
    else if (positiveRating.has(key) || myList.has(key)) rewatchEligible.add(key);
  }

  const genreAffinity = new Map<string, number>();
  const scale = Math.max(1, ...[...genreSigned.values()].map((v) => Math.abs(v)));
  for (const [g, w] of genreSigned) genreAffinity.set(g, tanh((w / scale) * 1.5));

  const topPositive = [...pos.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_SIGNAL_COUNT).map(([key, weight]) => ({ key, weight }));
  const topNegative = [...neg.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_SIGNAL_COUNT).map(([key, weight]) => ({ key, weight }));

  return { pos, neg, disliked, genreAffinity, seen, recentlyCompleted, rewatchEligible, topPositive, topNegative, signals };
}
