"use client";

// Home: billboard + rows, personalised by the Phase 7 taste engine
// (src/server/reco/engine.ts via /api/recommend, store/reco.ts). Falls back to
// the original Phase 5 heuristics (recency, catalogue-wide genre frequency)
// whenever the engine has nothing yet to say for a row — a fresh profile with
// zero watch history should still see a populated, if impersonal, Home.

import { useMemo } from "react";
import { DownloadCloud, FolderOpen, AlertTriangle, X } from "lucide-react";
import { useCatalog } from "@/lib/flix/useCatalog";
import { useLibraryStore } from "@/store/library";
import { useStateStore } from "@/store/state";
import { useRecoStore } from "@/store/reco";
import { useProfileStore } from "@/store/profile";
import { useArrStore } from "@/store/arr";
import { useUiStore } from "@/store/ui";
import { sortByAddedDesc, buildGenreRows, type CatalogItem } from "@/lib/flix/rows";
import { isNew } from "@/lib/flix/format";
import type { RecoRow } from "@/lib/flix/types";
import { BillboardHero } from "./BillboardHero";
import { Row } from "./Row";
import { Card } from "./Card";
import { Top10Card } from "./Top10Card";
import { ContinueWatchingCard } from "./ContinueWatchingCard";
import { SkeletonHero, SkeletonRow } from "./Skeletons";
import { EmptyState } from "./EmptyState";

const GENRE_ROWS = 3;
const GENRE_ROW_SIZE = 20;
const RECENT_ROW_SIZE = 20;
// Below this, a lone (or near-lone) giant ranked numeral in a wide black void
// reads as broken layout, not "a short list" — a real concern on a young
// self-hosted library. Suppress the Top-10 section until there's a ranking
// worth the oversized treatment; the titles still surface in the other rows.
const TOP10_MIN = 4;

function keyOf(item: CatalogItem): string {
  return `${item.type}-${item.id}`;
}

// One-time admin nudge to discover the opt-in *arr integration. Shown only to an
// admin who hasn't enabled or dismissed it — hidden entirely otherwise. The
// caller owns the outer spacing: on a populated Home it slides in UNDER the
// billboard (a banner above the hero broke the whole cinematic opening), on an
// empty library it sits below the fixed header instead (`topOffset`).
function ArrPromoBanner({ topOffset = false }: { topOffset?: boolean }) {
  const isAdmin = useProfileStore((s) => s.isAdmin);
  const enabled = useArrStore((s) => s.enabled);
  const dismissed = useArrStore((s) => s.dismissed);
  const loaded = useArrStore((s) => s.loaded);
  const dismissBanner = useArrStore((s) => s.dismissBanner);
  const navigate = useUiStore((s) => s.navigate);

  if (!loaded || !isAdmin || enabled || dismissed) return null;

  // A slim, dismissible strip — NOT a full-bleed card. On a populated Home it
  // slides in under the billboard, and a boxed panel there snapped the eye out
  // of the cinematic hero→rows flow; kept no taller than a row header.
  return (
    <div className={"px-4 md:px-12 " + (topOffset ? "pt-20" : "")}>
      <div className="glass flex items-center gap-3 rounded-full py-2 pl-4 pr-2">
        <DownloadCloud className="size-4 shrink-0 text-accent" />
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-white/85">
          Téléchargez et sous-titrez automatiquement les titres manquants — Sonarr, Radarr, Prowlarr, Bazarr.
        </p>
        <button
          type="button"
          onClick={() => navigate("settings")}
          className="shrink-0 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white transition duration-200 ease-out-quart hover:bg-white/20 active:scale-[0.97]"
        >
          Configurer
        </button>
        <button
          type="button"
          onClick={() => void dismissBanner()}
          aria-label="Ignorer"
          className="grid size-6 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function HomeView() {
  const { movies, shows } = useCatalog();
  const status = useLibraryStore((s) => s.status);
  const libraryError = useLibraryStore((s) => s.error);
  const progress = useStateStore((s) => s.progress);
  const myList = useStateStore((s) => s.myList);
  const recoRows = useRecoStore((s) => s.rows);
  const billboardRef = useRecoStore((s) => s.billboard);

  const all = useMemo<CatalogItem[]>(() => [...movies, ...shows], [movies, shows]);
  const catalogByKey = useMemo(() => {
    const map = new Map<string, CatalogItem>();
    for (const item of all) map.set(`${item.type}:${item.id}`, item);
    return map;
  }, [all]);

  // Every engine row resolved to catalogue items exactly once per data change
  // (rowId -> items). Reading from the Map at render time hands back stable
  // array references instead of rebuilding them twice per row per render.
  const rowItems = useMemo(() => {
    const map = new Map<string, CatalogItem[]>();
    for (const row of recoRows) {
      map.set(
        row.id,
        row.items.map((ref) => catalogByKey.get(`${ref.type}:${ref.id}`)).filter((item): item is CatalogItem => item !== undefined),
      );
    }
    return map;
  }, [recoRows, catalogByKey]);
  const itemsFor = (row: RecoRow): CatalogItem[] => rowItems.get(row.id) ?? [];

  // Most recently added stands in for "featured" only when the engine has no
  // personalised pick yet (brand-new profile, empty library) — see
  // pickBillboard()'s own cold-start fallback, mirrored here in case the
  // referenced item somehow isn't in this profile's (kids-filtered) catalogue.
  const recentFallbackBillboard = useMemo(() => sortByAddedDesc(all)[0] ?? null, [all]);
  const billboard = (billboardRef && catalogByKey.get(`${billboardRef.type}:${billboardRef.id}`)) || recentFallbackBillboard;

  const recentlyAdded = useMemo(() => sortByAddedDesc(all).slice(0, RECENT_ROW_SIZE), [all]);

  // "Nouveau" carries no signal when most of the library is new at once (the
  // first-import state), where a pill on every tile is pure noise that undoes
  // the caption-less wall of artwork. Suppress it on the home rows until new
  // titles are a minority (≤ 1/3 of the catalogue); a lone new title still flags.
  const homeAllowNew = useMemo(() => {
    if (all.length === 0) return true;
    return all.filter((i) => isNew(i.addedAt)).length <= all.length / 3;
  }, [all]);

  const top10MoviesRow = recoRows.find((r) => r.id === "top10-movies");
  const top10ShowsRow = recoRows.find((r) => r.id === "top10-shows");
  const forYouRow = recoRows.find((r) => r.id === "for-you");
  const becauseRows = recoRows.filter((r) => r.id.startsWith("because-"));
  const engineGenreRows = recoRows.filter((r) => r.id.startsWith("genre-"));
  const discoverRow = recoRows.find((r) => r.id === "discover");

  // Newest-added stand-in for the Top-10 ranking, ALWAYS available: used when the
  // engine has no ranking yet OR its ranking is too thin (< TOP10_MIN) for the
  // oversized-numeral treatment — so the section never vanishes on a library that
  // has plenty of titles but a low-signal profile. (Genre fallback stays below.)
  const recentTop10Movies = useMemo(() => sortByAddedDesc(movies).slice(0, 10), [movies]);
  const recentTop10Shows = useMemo(() => sortByAddedDesc(shows).slice(0, 10), [shows]);
  const top10Movies = useMemo(() => {
    const engine = top10MoviesRow ? (rowItems.get(top10MoviesRow.id) ?? []) : [];
    return engine.length >= TOP10_MIN ? engine : recentTop10Movies;
  }, [top10MoviesRow, rowItems, recentTop10Movies]);
  const top10Shows = useMemo(() => {
    const engine = top10ShowsRow ? (rowItems.get(top10ShowsRow.id) ?? []) : [];
    return engine.length >= TOP10_MIN ? engine : recentTop10Shows;
  }, [top10ShowsRow, rowItems, recentTop10Shows]);
  const fallbackGenreRows = useMemo(
    () => (engineGenreRows.length ? [] : buildGenreRows(all, GENRE_ROWS, GENRE_ROW_SIZE)),
    [engineGenreRows.length, all],
  );

  // Rank of the featured title inside today's Top 10 row of ITS kind — drives
  // the billboard's "N°X des films aujourd'hui" flag; 0/absent → no flag.
  const billboardRank = useMemo(() => {
    if (!billboard) return null;
    const top10 = billboard.type === "movie" ? top10Movies : top10Shows;
    const index = top10.findIndex((entry) => entry.type === billboard.type && entry.id === billboard.id);
    return index === -1 ? null : index + 1;
  }, [billboard, top10Movies, top10Shows]);

  const myListItems = useMemo<CatalogItem[]>(() => {
    const wanted = new Set(myList.map((e) => `${e.itemType}-${e.itemId}`));
    return all.filter((item) => wanted.has(keyOf(item)));
  }, [all, myList]);

  const continueWatching = useMemo(
    () => progress.filter((p) => p.duration > 0 && p.position > 5 && p.position / p.duration < 0.92),
    [progress],
  );

  if (status === "loading" || status === "idle") {
    return (
      <div>
        <SkeletonHero />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }

  // The store has carried a French error message since day one — this branch
  // finally renders it. Only the FIRST load can land here (silent refreshes
  // keep the previous catalogue on failure), so a retry button is enough.
  if (status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <EmptyState
          icon={<AlertTriangle className="size-6" />}
          title="Bibliothèque indisponible"
          description={libraryError ?? "Le serveur n'a pas répondu."}
          actionLabel="Réessayer"
          onAction={() => void useLibraryStore.getState().load()}
        />
      </div>
    );
  }

  if (status === "ready" && all.length === 0) {
    return (
      <div>
        <ArrPromoBanner topOffset />
        <div className="flex min-h-screen items-center justify-center px-6">
          <EmptyState
            icon={<FolderOpen className="size-6" />}
            title="Bibliothèque vide"
            description="Ajoutez des films ou des séries dans le dossier vidéo configuré, puis relancez une analyse."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="pb-20">
      {billboard ? <BillboardHero item={billboard} topRank={billboardRank} /> : <div className="h-24" />}
      <div className="relative z-10 -mt-6 space-y-8 stagger-children md:-mt-24">
        <ArrPromoBanner />
        {continueWatching.length > 0 && (
          <Row
            title="Continuer à regarder"
            items={continueWatching}
            keyFor={(e) => `${e.itemType}-${e.itemId}`}
            itemClassName="w-[60vw] sm:w-[38vw] md:w-[26vw] lg:w-[20vw]"
            renderItem={(entry) => <ContinueWatchingCard entry={entry} />}
          />
        )}
        {myListItems.length > 0 && <Row title="Ma liste" items={myListItems} keyFor={keyOf} renderItem={(item) => <Card item={item} caption="mobile" allowNew={homeAllowNew} />} />}

        {top10Movies.length >= TOP10_MIN && (
          <Row
            title="Top 10 des films"
            items={top10Movies}
            keyFor={keyOf}
            itemClassName="w-[50vw] sm:w-[32vw] md:w-[22vw] lg:w-[17vw]"
            renderItem={(item, index) => <Top10Card item={item} rank={index + 1} />}
          />
        )}
        {top10Shows.length >= TOP10_MIN && (
          <Row
            title="Top 10 des séries"
            items={top10Shows}
            keyFor={keyOf}
            itemClassName="w-[50vw] sm:w-[32vw] md:w-[22vw] lg:w-[17vw]"
            renderItem={(item, index) => <Top10Card item={item} rank={index + 1} />}
          />
        )}

        {forYouRow && itemsFor(forYouRow).length > 0 && (
          <Row title={forYouRow.title} items={itemsFor(forYouRow)} keyFor={keyOf} renderItem={(item) => <Card item={item} caption="mobile" allowNew={homeAllowNew} />} />
        )}

        {becauseRows.map((row) => {
          const items = itemsFor(row);
          return items.length > 0 && <Row key={row.id} title={row.title} items={items} keyFor={keyOf} renderItem={(item) => <Card item={item} caption="mobile" allowNew={homeAllowNew} />} />;
        })}

        {engineGenreRows.map((row) => {
          const items = itemsFor(row);
          return items.length > 0 && <Row key={row.id} title={row.title} items={items} keyFor={keyOf} renderItem={(item) => <Card item={item} caption="mobile" allowNew={homeAllowNew} />} />;
        })}
        {fallbackGenreRows.map(
          (row) =>
            row.items.length > 0 && <Row key={row.genre} title={row.genre} items={row.items} keyFor={keyOf} renderItem={(item) => <Card item={item} caption="mobile" allowNew={homeAllowNew} />} />,
        )}

        {recentlyAdded.length > 0 && <Row title="Ajoutés récemment" items={recentlyAdded} keyFor={keyOf} renderItem={(item) => <Card item={item} caption="mobile" allowNew={homeAllowNew} />} />}

        {discoverRow && itemsFor(discoverRow).length > 0 && (
          <Row title={discoverRow.title} items={itemsFor(discoverRow)} keyFor={keyOf} renderItem={(item) => <Card item={item} caption="mobile" allowNew={homeAllowNew} />} />
        )}
      </div>
    </div>
  );
}
