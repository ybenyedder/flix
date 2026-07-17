// Pure content-similarity model for the Phase 7 taste engine — no DB, no
// fetch, safe to import from client or server code. Auralis places a track in
// a continuous "feeling space" (arousal/valence from real audio analysis);
// Flix's catalogue metadata is discrete instead (genres/people/studio/year),
// so the equivalent here is a weighted blend of set-similarity metrics rather
// than a Euclidean distance in a numeric space.
// Model: /home/pc/Documents/auralis_enterprise_grade/src/lib/auralis/reco.ts

export interface ContentFeatures {
  type: "movie" | "show";
  /** Normalised (trimmed/lowercased) genre labels. */
  genres: Set<string>;
  /** Release year folded to 0..1 over 1950-2030, or null if unknown. */
  decade: number | null;
  /** Runtime folded to a 0..1 log scale over 5min-4h, or null if unknown. */
  durationLog: number | null;
  /** Normalised actor + director names, unioned. */
  people: Set<string>;
  /** Normalised studio name, or null. */
  studio: string | null;
}

export interface ContentFeatureInput {
  type: "movie" | "show";
  genres: string[];
  year: number | null;
  durationSeconds: number | null;
  people: string[];
  studio: string | null;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const normalize = (s: string): string => s.trim().toLowerCase();

const DECADE_MIN_YEAR = 1950;
const DECADE_MAX_YEAR = 2030;
// 5 minutes .. 4 hours, log-scaled — the practical runtime range across movies
// and episodes. Log scale so "90 vs 100 min" reads as close while "20 min
// episode vs 3h film" reads as far apart, matching how viewers actually
// perceive "short vs long".
const DURATION_MIN_LOG = Math.log(5 * 60);
const DURATION_MAX_LOG = Math.log(4 * 3600);

/** Build a catalogue item's feature vector for similarity scoring. Pure —
 *  callers resolve genres/actors/directors/studio/year/duration themselves
 *  from whatever shape they have (CatalogMovie, CatalogShow, ...). */
export function buildFeatures(input: ContentFeatureInput): ContentFeatures {
  const genres = new Set(input.genres.map(normalize).filter(Boolean));
  const decade = input.year ? clamp01((input.year - DECADE_MIN_YEAR) / (DECADE_MAX_YEAR - DECADE_MIN_YEAR)) : null;
  const durationLog =
    input.durationSeconds && input.durationSeconds > 0
      ? clamp01((Math.log(input.durationSeconds) - DURATION_MIN_LOG) / (DURATION_MAX_LOG - DURATION_MIN_LOG))
      : null;
  const people = new Set(input.people.map(normalize).filter(Boolean));
  const studio = input.studio ? normalize(input.studio) : null;
  // `type` rides along for callers/debugging, but contentSimilarity deliberately
  // IGNORES it: a film and a series with the same genres/people are legitimately
  // "similar", and the engine already tracks item type separately (on ItemRow).
  return { type: input.type, genres, decade, durationLog, people, studio };
}

/** Cosine similarity of two binary (membership) sets: |A∩B| / sqrt(|A|·|B|). */
function cosineSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const v of a) if (b.has(v)) shared++;
  return shared / Math.sqrt(a.size * b.size);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const v of a) if (b.has(v)) shared++;
  const union = a.size + b.size - shared;
  return union > 0 ? shared / union : 0;
}

// Missing decade/duration data neutralises that axis at 0.5 (neither close
// nor far) rather than 0 or 1 — not knowing a title's year says nothing about
// how similar it is, so it shouldn't push the score either direction.
function proximity(a: number | null, b: number | null): number {
  if (a === null || b === null) return 0.5;
  return 1 - Math.abs(a - b);
}

/**
 * Weighted content similarity between two catalogue items, 0..1. Weights are
 * the Phase 7 spec exactly: 0.55 genre cosine + 0.15 decade proximity +
 * 0.10 duration proximity + 0.12 people (actors ∪ directors) Jaccard +
 * 0.08 same studio.
 */
export function contentSimilarity(a: ContentFeatures, b: ContentFeatures): number {
  const genreSim = cosineSets(a.genres, b.genres);
  const decadeSim = proximity(a.decade, b.decade);
  const durationSim = proximity(a.durationLog, b.durationLog);
  const peopleSim = jaccard(a.people, b.people);
  const studioSim = a.studio && b.studio && a.studio === b.studio ? 1 : 0;
  return 0.55 * genreSim + 0.15 * decadeSim + 0.1 * durationSim + 0.12 * peopleSim + 0.08 * studioSim;
}

/**
 * Netflix-style "match %" badge from a raw taste score: round(50 + 50·tanh(score)).
 * tanh keeps the badge inside [0,100] without a hand-tuned clamp, consistent
 * with how the engine already squashes its "direct" axis the same way.
 */
export function matchPercent(score: number): number {
  return Math.round(50 + 50 * Math.tanh(score));
}
