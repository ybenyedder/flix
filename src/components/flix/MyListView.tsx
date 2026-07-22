"use client";

import { useMemo } from "react";
import { Bookmark } from "lucide-react";
import { useCatalog } from "@/lib/flix/useCatalog";
import { useStateStore } from "@/store/state";
import { useUiStore } from "@/store/ui";
import { sortByAddedDesc, type CatalogItem } from "@/lib/flix/rows";
import { newBadgeMeaningful } from "@/lib/flix/format";
import { ProgressiveCardGrid } from "./ProgressiveCardGrid";
import { EmptyState } from "./EmptyState";

export function MyListView() {
  const { movies, shows } = useCatalog();
  const myList = useStateStore((s) => s.myList);
  const navigate = useUiStore((s) => s.navigate);

  const items = useMemo<CatalogItem[]>(() => {
    const wanted = new Set(myList.map((e) => `${e.itemType}-${e.itemId}`));
    const all: CatalogItem[] = [...movies, ...shows].filter((item) => wanted.has(`${item.type}-${item.id}`));
    return sortByAddedDesc(all);
  }, [movies, shows, myList]);

  const allowNew = useMemo(() => newBadgeMeaningful([...movies, ...shows]), [movies, shows]);

  return (
    <div className="min-h-screen px-4 pb-20 pt-24 md:px-12">
      <h1 className="mb-6 font-display text-3xl font-bold tracking-tight text-white">Ma liste</h1>
      {items.length === 0 ? (
        <EmptyState
          className="mt-16"
          icon={<Bookmark className="size-6" />}
          title="Votre liste est vide"
          description="Ajoutez des titres depuis leur fiche pour les retrouver ici."
          actionLabel="Parcourir le catalogue"
          onAction={() => navigate("home")}
        />
      ) : (
        <ProgressiveCardGrid items={items} allowNew={allowNew} gridClassName="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7" />
      )}
    </div>
  );
}
