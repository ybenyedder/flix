"use client";

// Films / Séries grid: multi-genre chips + a sort/filter toolbar (decade,
// unseen-only, 4K/HDR). All the filtering/sorting logic is pure and lives in
// src/lib/flix/rows.ts (applyBrowseFilters / sortBrowseItems), tested in
// test/rows.test.ts — this component is just useState + markup.

import { useMemo, useState } from "react";
import { useCatalog } from "@/lib/flix/useCatalog";
import { useStateStore } from "@/store/state";
import {
  topGenres,
  availableDecades,
  buildSeenKeys,
  applyBrowseFilters,
  sortBrowseItems,
  hasActiveBrowseFilters,
  EMPTY_BROWSE_FILTERS,
  type BrowseFilters,
  type BrowseSort,
  type CatalogItem,
} from "@/lib/flix/rows";
import { ProgressiveCardGrid } from "./ProgressiveCardGrid";

const SORT_OPTIONS: { id: BrowseSort; label: string }[] = [
  { id: "recent", label: "Récents" },
  { id: "alpha", label: "A–Z" },
  { id: "year", label: "Année" },
  { id: "duration", label: "Durée" },
];

function chipClass(selected: boolean): string {
  return (
    "rounded-full border px-3 py-1 text-sm transition-colors " +
    (selected ? "border-white bg-white text-black" : "border-white/30 text-muted hover:border-white/60 hover:bg-white/5 hover:text-white")
  );
}

const selectClass = "rounded-field bg-white/5 px-2 py-1 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-accent/60";

export function BrowseView({ kind }: { kind: "movie" | "show" }) {
  // Keyed on kind so switching Films <-> Séries resets filters and sort —
  // genres/decades picked in one catalogue rarely make sense in the other.
  return <BrowseInner key={kind} kind={kind} />;
}

function BrowseInner({ kind }: { kind: "movie" | "show" }) {
  const { movies, shows } = useCatalog();
  const progress = useStateStore((s) => s.progress);

  const base = useMemo<CatalogItem[]>(() => (kind === "movie" ? movies : shows), [kind, movies, shows]);
  const genres = useMemo(() => topGenres(base, 12), [base]);
  const decades = useMemo(() => availableDecades(base), [base]);
  const seen = useMemo(() => buildSeenKeys(progress), [progress]);

  const [filters, setFilters] = useState<BrowseFilters>(EMPTY_BROWSE_FILTERS);
  const [sort, setSort] = useState<BrowseSort>("recent");

  // Shows carry no single runtime, so "Durée" only makes sense for Films.
  const sortOptions = kind === "movie" ? SORT_OPTIONS : SORT_OPTIONS.filter((o) => o.id !== "duration");

  const items = useMemo(() => sortBrowseItems(applyBrowseFilters(base, filters, seen), sort), [base, filters, seen, sort]);

  const toggleGenre = (genre: string) =>
    setFilters((f) => ({ ...f, genres: f.genres.includes(genre) ? f.genres.filter((g) => g !== genre) : [...f.genres, genre] }));

  const dirty = hasActiveBrowseFilters(filters) || sort !== "recent";
  const reset = () => {
    setFilters(EMPTY_BROWSE_FILTERS);
    setSort("recent");
  };

  return (
    <div className="min-h-screen px-4 pb-20 pt-24 md:px-12">
      <h1 className="mb-4 font-display text-2xl font-semibold text-white">{kind === "movie" ? "Films" : "Séries"}</h1>

      {genres.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => setFilters((f) => ({ ...f, genres: [] }))} className={chipClass(filters.genres.length === 0)}>
            Tous
          </button>
          {genres.map((genre) => (
            <button key={genre} type="button" onClick={() => toggleGenre(genre)} aria-pressed={filters.genres.includes(genre)} className={chipClass(filters.genres.includes(genre))}>
              {genre}
            </button>
          ))}
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-muted">
          Trier&nbsp;:
          <select value={sort} onChange={(e) => setSort(e.target.value as BrowseSort)} className={selectClass}>
            {sortOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {decades.length > 0 && (
          <select
            value={filters.decade ?? ""}
            onChange={(e) => setFilters((f) => ({ ...f, decade: e.target.value === "" ? null : Number(e.target.value) }))}
            aria-label="Filtrer par décennie"
            className={selectClass}
          >
            <option value="">Toutes les années</option>
            {decades.map((decade) => (
              <option key={decade} value={decade}>
                Années {decade}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          onClick={() => setFilters((f) => ({ ...f, unseenOnly: !f.unseenOnly }))}
          aria-pressed={filters.unseenOnly}
          title="Non vus seulement"
          className={chipClass(filters.unseenOnly)}
        >
          Non vus
        </button>
        <button type="button" onClick={() => setFilters((f) => ({ ...f, fourK: !f.fourK }))} aria-pressed={filters.fourK} className={chipClass(filters.fourK)}>
          4K
        </button>
        <button type="button" onClick={() => setFilters((f) => ({ ...f, hdr: !f.hdr }))} aria-pressed={filters.hdr} className={chipClass(filters.hdr)}>
          HDR
        </button>

        <span className="ml-auto text-sm text-muted">
          {items.length} titre{items.length > 1 ? "s" : ""}
        </span>
        {dirty && (
          <button type="button" onClick={reset} className="text-sm text-muted underline underline-offset-2 transition-colors hover:text-white">
            Réinitialiser
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-muted">{base.length === 0 ? "Aucun titre." : "Aucun titre ne correspond aux filtres."}</p>
      ) : (
        // Keyed on the filter/sort tuple: changing it remounts the grid, which
        // resets the progressive batch counter back to the first batch.
        <ProgressiveCardGrid
          key={`${sort}|${filters.decade ?? ""}|${filters.unseenOnly}|${filters.fourK}|${filters.hdr}|${filters.genres.join(",")}`}
          items={items}
          gridClassName="stagger-children grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7"
        />
      )}
    </div>
  );
}
