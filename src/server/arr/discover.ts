// External discovery: search Radarr/Sonarr's metadata lookup (they proxy TMDB/
// TVDB) for titles not in the library, annotated with whether Flix already has
// them and whether the household already requested them. Posters come back as
// same-origin proxy paths so the CSP img-src 'self' holds.

import { radarrLookup, sonarrLookup, type RadarrMovie, type SonarrSeries } from "./client";
import { isInLibrary, requestStatusesByExternalId } from "./requests";
import { proxyPoster, pickPoster } from "./posters";
import type { ArrDiscoverItem } from "@/lib/flix/types";

const PER_TYPE_LIMIT = 10;

/** Search both services concurrently (allSettled: one being down still returns
 *  the other's results) and return a flat, annotated, capped list. */
export async function discover(query: string): Promise<ArrDiscoverItem[]> {
  const [movieRes, showRes] = await Promise.allSettled([radarrLookup(query), sonarrLookup(query)]);
  const statuses = requestStatusesByExternalId();
  const items: ArrDiscoverItem[] = [];

  if (movieRes.status === "fulfilled") {
    for (const m of (movieRes.value as RadarrMovie[]).slice(0, PER_TYPE_LIMIT)) {
      const title = typeof m.title === "string" ? m.title : "";
      if (!title) continue;
      const year = typeof m.year === "number" ? m.year : null;
      const tmdbId = typeof m.tmdbId === "number" ? m.tmdbId : null;
      items.push({
        mediaType: "movie",
        tmdbId,
        tvdbId: null,
        title,
        year,
        overview: typeof m.overview === "string" ? m.overview : null,
        posterUrl: proxyPoster(pickPoster(m)),
        inLibrary: isInLibrary("movie", title, year),
        requestStatus: (tmdbId != null ? statuses.get(`movie:${tmdbId}`) : undefined) ?? null,
      });
    }
  }

  if (showRes.status === "fulfilled") {
    for (const s of (showRes.value as SonarrSeries[]).slice(0, PER_TYPE_LIMIT)) {
      const title = typeof s.title === "string" ? s.title : "";
      if (!title) continue;
      const year = typeof s.year === "number" ? s.year : null;
      const tvdbId = typeof s.tvdbId === "number" ? s.tvdbId : null;
      items.push({
        mediaType: "show",
        tmdbId: null,
        tvdbId,
        title,
        year,
        overview: typeof s.overview === "string" ? s.overview : null,
        posterUrl: proxyPoster(pickPoster(s)),
        inLibrary: isInLibrary("show", title, year),
        requestStatus: (tvdbId != null ? statuses.get(`show:${tvdbId}`) : undefined) ?? null,
      });
    }
  }

  return items;
}
