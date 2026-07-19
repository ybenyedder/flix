"use client";

import { useMemo } from "react";
import { useCatalog } from "@/lib/flix/useCatalog";
import { useStateStore } from "@/store/state";
import { useUiStore } from "@/store/ui";
import { sortByAddedDesc, type CatalogItem } from "@/lib/flix/rows";
import { Card } from "./Card";

export function MyListView() {
  const { movies, shows } = useCatalog();
  const myList = useStateStore((s) => s.myList);
  const navigate = useUiStore((s) => s.navigate);

  const items = useMemo<CatalogItem[]>(() => {
    const wanted = new Set(myList.map((e) => `${e.itemType}-${e.itemId}`));
    const all: CatalogItem[] = [...movies, ...shows].filter((item) => wanted.has(`${item.type}-${item.id}`));
    return sortByAddedDesc(all);
  }, [movies, shows, myList]);

  return (
    <div className="min-h-screen px-4 pb-20 pt-24 md:px-12">
      <h1 className="mb-6 font-display text-2xl font-semibold text-white">Ma liste</h1>
      {items.length === 0 ? (
        <div className="card-surface animate-fade-up mx-auto mt-16 flex max-w-md flex-col items-center gap-4 rounded-dialog p-10 text-center">
          <p className="text-lg font-semibold text-white">Votre liste est vide</p>
          <p className="text-sm text-muted">Ajoutez des titres depuis leur fiche pour les retrouver ici.</p>
          <button
            type="button"
            onClick={() => navigate("home")}
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
          >
            Parcourir le catalogue
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
          {items.map((item) => (
            <Card key={`${item.type}-${item.id}`} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
