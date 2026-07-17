"use client";

// Single choke point for "the catalogue this profile is allowed to see" — every
// view (Home, Browse, Search results rendering, My List) should read the
// catalogue through this hook rather than useLibraryStore directly, so the
// kids content-rating filter (src/lib/flix/kids.ts) can never be forgotten on
// one surface while applied on another.

import { useMemo } from "react";
import { useLibraryStore } from "@/store/library";
import { useProfileStore } from "@/store/profile";
import { filterForProfile } from "./kids";
import type { Movie, Show } from "./types";

export function useCatalog(): { movies: Movie[]; shows: Show[] } {
  const movies = useLibraryStore((s) => s.movies);
  const shows = useLibraryStore((s) => s.shows);
  const isKids = useProfileStore((s) => s.isKids);
  return useMemo(
    () => ({ movies: filterForProfile(movies, isKids), shows: filterForProfile(shows, isKids) }),
    [movies, shows, isKids],
  );
}
