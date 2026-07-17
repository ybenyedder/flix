// Quality-profile fallback for the *arr stall watchdog. When a download is stuck
// at ~0% for too long (typically a Remux/4K release nobody's seeding), Flix
// retunes the request's quality profile to a "balanced" set — WEB/x264-x265
// 1080p, no Remux/4K — which is far better seeded on public indexers, then
// re-searches. Mirrors the FLIX_ARR_QUALITY=balanced logic in
// deploy/arr/arr-init.mjs (kept in sync).
//
// Server-only.

import {
  radarrQualityProfile,
  sonarrQualityProfile,
  radarrUpdateQualityProfile,
  sonarrUpdateQualityProfile,
  type QualityProfileFull,
} from "./client";
import type { ArrService } from "./config";

/** Quality tokens the balanced profile disallows (cams, Remux, 4K, disc images). */
const BALANCED_BAD = ["workprint", "cam", "telesync", "telecine", "regional", "dvdscr", "2160p", "remux", "br-disk", "raw-hd"];

export function isBalancedBadQuality(name: string | undefined | null): boolean {
  const s = String(name || "").toLowerCase();
  return BALANCED_BAD.some((k) => s.includes(k));
}

/** The label the balanced profile is renamed to (also the idempotency marker:
 *  a profile already named this is left untouched). */
export const BALANCED_PROFILE_NAME = "Balanced (WEB/x264 1080p)";

/** Pure transform: given a full quality profile, return the balanced version —
 *  every Remux/4K/cam tier disallowed, cutoff pinned to WEB-1080p (or Bluray-1080p),
 *  renamed. Returns null when the profile is already balanced (no-op). */
export function toBalancedProfile(profile: QualityProfileFull): QualityProfileFull | null {
  if (profile.name === BALANCED_PROFILE_NAME) return null;
  const next: QualityProfileFull = { ...profile, items: profile.items.map((it) => ({ ...it })) };
  let web1080: number | null = null;
  for (const it of next.items) {
    if (it.quality) {
      it.allowed = !isBalancedBadQuality(it.quality.name);
    } else {
      it.allowed = !isBalancedBadQuality(it.name);
      if (String(it.name || "").toLowerCase().replace(/\s/g, "") === "web1080p" && typeof it.id === "number") web1080 = it.id;
    }
  }
  const bluray1080 = next.items.find((it) => it.quality && String(it.quality.name).toLowerCase() === "bluray-1080p");
  next.cutoff = web1080 ?? (bluray1080?.quality ? bluray1080.quality.id : profile.cutoff);
  next.upgradeAllowed = true;
  next.name = BALANCED_PROFILE_NAME;
  return next;
}

/** Fetch a profile, retune it to balanced, and PUT it back. Idempotent: a profile
 *  already balanced is left as-is. Returns true when a change was applied. */
export async function applyBalancedProfile(service: "radarr" | "sonarr", profileId: number): Promise<boolean> {
  const get = service === "radarr" ? radarrQualityProfile : sonarrQualityProfile;
  const put = service === "radarr" ? radarrUpdateQualityProfile : sonarrUpdateQualityProfile;
  const profile = await get(profileId);
  const balanced = toBalancedProfile(profile);
  if (!balanced) return false;
  await put(profileId, balanced);
  return true;
}

/** Narrow the two services this module handles (movies/series only). */
export function isDownloadService(service: ArrService): service is "radarr" | "sonarr" {
  return service === "radarr" || service === "sonarr";
}
