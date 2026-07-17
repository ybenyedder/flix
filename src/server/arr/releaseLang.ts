// Language-aware ranking for the per-request "Demander en français / VO" picker.
//
// Radarr's interactive search returns every indexer's releases, but its PARSED
// `languages` array is unreliable — a "MULTi" rip that carries a French track is
// routinely tagged `["English"]` (verified live on Captain America). So the
// French signal is taken primarily from the release TITLE (scene tags: MULTi,
// FRENCH, TRUEFRENCH, VFF/VFQ, VOSTFR…), with the languages array as a weak
// confirmation only. Pure + side-effect free so it's unit-tested directly.

import type { RadarrRelease } from "./client";
import type { RequestLanguage, RequestQuality } from "@/lib/flix/types";

// French scene markers. `multi` is included: a MULTi release bundles the original
// plus added dubs and, in the French-tracker ecosystem, almost always the FR one.
const FR_TITLE = /\b(multi|french|truefrench|vff|vfq|vfi|vf2|vof|vostfr|fra|fre)\b/i;
// Single-language foreign dubs with no English — deprioritised when VO is wanted.
const FOREIGN_DUB = /\b(french|truefrench|vff|vfq|vfi|vof|italian|ita|german|ger|spanish|castellano|latino|hindi|dublado|polish|lektor|rus|russian)\b/i;
const CYRILLIC = /[Ѐ-ӿ]/;

function hasLanguage(r: RadarrRelease, re: RegExp): boolean {
  return (r.languages ?? []).some((l) => re.test(l?.name ?? ""));
}

function resolutionOf(r: RadarrRelease): number {
  return r.quality?.quality?.resolution ?? 0;
}

/** Match strength of a release against the wanted language: 2 = strong, 1 =
 *  plausible, 0 = mismatch. */
export function languageScore(r: RadarrRelease, lang: "fr" | "vo"): number {
  const title = r.title ?? "";
  if (lang === "fr") {
    return FR_TITLE.test(title) || hasLanguage(r, /french/i) ? 2 : 0;
  }
  // vo = original English wanted.
  if (CYRILLIC.test(title)) return 0; // foreign-packaged (e.g. russian) release
  if (/\bmulti\b/i.test(title)) return 2; // multi-audio bundles the English original
  if (FOREIGN_DUB.test(title)) return 0; // foreign-only dub — even if the (unreliable) languages tag claims English
  if (hasLanguage(r, /english/i)) return 2;
  return 1; // untagged → assume the original (English) track
}

/** Map a resolution to its request-quality tier bucket. */
export function qualityTierOf(resolution: number): Exclude<RequestQuality, "any"> {
  if (resolution >= 2160) return "2160p";
  if (resolution >= 1080) return "1080p";
  if (resolution >= 720) return "720p";
  return "sd";
}

export interface PickResult {
  /** Best grabbable release under the sort, or null when none satisfy the
   *  constraints (e.g. no release exists at the requested quality tier). */
  release: RadarrRelease | null;
  /** Whether that pick satisfies the LANGUAGE preference (fr needs a strong
   *  match, vo needs at least a plausible English track, any is always ok). The
   *  caller grabs only when true. */
  matched: boolean;
}

export interface PickPreference {
  language: RequestLanguage;
  quality: RequestQuality;
}

/** Rank interactive-search results for a language + quality preference. Rejected
 *  releases are dropped; a non-"any" quality tier is a HARD filter (only that
 *  resolution bucket survives); the rest sort by language score → resolution →
 *  seeders → size. `matched` reports whether the language preference is met. */
export function pickRelease(releases: RadarrRelease[], { language, quality }: PickPreference): PickResult {
  let usable = releases.filter((r) => !r.rejected && r.guid && typeof r.indexerId === "number");
  if (quality !== "any") usable = usable.filter((r) => qualityTierOf(resolutionOf(r)) === quality);
  if (!usable.length) return { release: null, matched: false };

  const scored = usable
    .map((r) => ({ r, s: language === "any" ? 1 : languageScore(r, language) }))
    .sort((a, b) => b.s - a.s || resolutionOf(b.r) - resolutionOf(a.r) || (b.r.seeders ?? 0) - (a.r.seeders ?? 0) || (b.r.size ?? 0) - (a.r.size ?? 0));
  const best = scored[0];
  // fr demands a strong title match; vo demands at least a plausible English
  // track (excludes cyrillic-packaged / foreign-only dubs); any is unconstrained.
  const langOk = language === "fr" ? best.s >= 2 : language === "vo" ? best.s >= 1 : true;
  return { release: best.r, matched: langOk };
}

/** Backwards-compatible language-only helper (quality unconstrained). */
export function pickReleaseForLanguage(releases: RadarrRelease[], lang: "fr" | "vo"): PickResult {
  return pickRelease(releases, { language: lang, quality: "any" });
}
