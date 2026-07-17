// Turn Radarr's interactive-search results into the cascading picker's real
// availability: which audio languages actually exist, and for each, which
// quality tiers — each with the best release to grab. No fixed/guessed tiers:
// a language or quality only appears if a (non-rejected) release provides it.
//
// Language is title-based (Radarr's parsed `languages` mislabels MULTi rips) via
// languageScore; a MULTi release provides BOTH French and VO, so it can surface
// under both. Server-only. Pure + side-effect free → unit-tested directly.

import type { RadarrRelease } from "./client";
import { languageScore, qualityTierOf } from "./releaseLang";
import type { RequestLanguage, RequestQuality, ReleaseLanguageOption, ReleaseOptions } from "@/lib/flix/types";

type Lang = Exclude<RequestLanguage, "any">;
type Tier = Exclude<RequestQuality, "any">;

const LANGUAGES: { code: Lang; label: string }[] = [
  { code: "fr", label: "Français" },
  { code: "vo", label: "VO" },
];
const TIER_LABEL: Record<Tier, string> = { "2160p": "4K (2160p)", "1080p": "1080p", "720p": "720p", sd: "SD" };
const TIER_ORDER: Tier[] = ["2160p", "1080p", "720p", "sd"];

/** Whether a release carries a usable audio track for the wanted language:
 *  French needs a strong title match, VO at least a plausible English track. */
export function providesLanguage(r: RadarrRelease, lang: Lang): boolean {
  return languageScore(r, lang) >= (lang === "fr" ? 2 : 1);
}

/** Build the per-language, per-quality availability from raw search results. */
export function buildReleaseOptions(releases: RadarrRelease[]): ReleaseLanguageOption[] {
  const usable = releases.filter((r) => !r.rejected && r.guid && typeof r.indexerId === "number");
  const out: ReleaseLanguageOption[] = [];

  for (const { code, label } of LANGUAGES) {
    const inLang = usable.filter((r) => providesLanguage(r, code));
    if (!inLang.length) continue;

    const byTier = new Map<Tier, RadarrRelease[]>();
    for (const r of inLang) {
      const tier = qualityTierOf(r.quality?.quality?.resolution ?? 0);
      const bucket = byTier.get(tier);
      if (bucket) bucket.push(r);
      else byTier.set(tier, [r]);
    }

    const qualities = TIER_ORDER.flatMap((tier) => {
      const list = byTier.get(tier);
      if (!list) return [];
      // Best = most seeders, then largest (usually the higher-bitrate encode).
      const best = [...list].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0) || (b.size ?? 0) - (a.size ?? 0))[0];
      return [
        {
          quality: tier,
          label: TIER_LABEL[tier],
          count: list.length,
          sizeBytes: best.size ?? 0,
          seeders: best.seeders ?? 0,
          guid: best.guid,
          indexerId: best.indexerId,
          title: best.title,
        },
      ];
    });

    if (qualities.length) out.push({ language: code, label, qualities });
  }
  return out;
}

/** Assemble the full picker payload (metadata + availability). */
export function assembleReleaseOptions(opts: { arrId: number; wasAdded: boolean; title: string; year: number | null; releases: RadarrRelease[] }): ReleaseOptions {
  return {
    arrId: opts.arrId,
    wasAdded: opts.wasAdded,
    title: opts.title,
    year: opts.year,
    languages: buildReleaseOptions(opts.releases),
  };
}
