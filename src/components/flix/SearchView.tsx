"use client";

// Debounced full-text search over /api/search (FTS5), driven by the query
// typed into Header's search box (useUiStore.searchQuery).
//
// "loading" and "are these results current" are both DERIVED from comparing
// results.query to the live (trimmed) query — deliberately no separate
// `loading` state set synchronously inside the effect (react-hooks/set-state-
// in-effect flags that pattern; setResults() below only ever runs inside an
// async .then()/.catch() callback, which is fine).

import { useEffect, useState } from "react";
import { api } from "@/lib/flix/api";
import type { SearchResults } from "@/lib/flix/types";
import { useUiStore } from "@/store/ui";
import { ProgressiveCardGrid } from "./ProgressiveCardGrid";
import { DiscoverSection } from "./DiscoverSection";
import { SkeletonGrid } from "./Skeletons";

const DEBOUNCE_MS = 250;

export function SearchView() {
  const query = useUiStore((s) => s.searchQuery);
  const [results, setResults] = useState<SearchResults | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    // `alive` guards the in-flight fetch, not just the debounce: without it a
    // slow response for an older query can land *after* the current one and
    // overwrite it, leaving `results.query !== trimmed` (= skeleton) forever.
    let alive = true;
    const handle = window.setTimeout(() => {
      api
        .get<SearchResults>(`/api/search?q=${encodeURIComponent(trimmed)}`)
        .then((data) => {
          if (alive) setResults(data);
        })
        .catch(() => {
          if (alive) setResults({ movies: [], shows: [], query: trimmed });
        });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, [query]);

  const trimmed = query.trim();
  const current = trimmed !== "" && results?.query === trimmed ? results : null;
  const loading = trimmed !== "" && current === null;
  const items = current ? [...current.movies, ...current.shows] : [];

  return (
    <div className="min-h-screen px-4 pb-20 pt-24 md:px-12">
      <h1 className="mb-6 font-display text-3xl font-bold tracking-tight text-white">{trimmed ? `Résultats pour « ${trimmed} »` : "Recherchez un titre, un genre…"}</h1>
      {loading && <SkeletonGrid />}
      {current && items.length === 0 && <p className="text-muted">Aucun résultat. Essayez un autre titre ou lancez une demande.</p>}
      {current && items.length > 0 && (
        // Keyed on the query: a new search remounts the grid and resets the
        // progressive batch counter.
        <ProgressiveCardGrid
          key={current.query}
          items={items}
          gridClassName="stagger-children grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7"
        />
      )}
      {/* External discovery (opt-in *arr): request titles not in the library.
          Self-hides for kids / when the feature is off. */}
      <DiscoverSection query={trimmed} />
    </div>
  );
}
