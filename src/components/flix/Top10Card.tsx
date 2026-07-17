"use client";

// Netflix's "Top 10" rail: a huge outline numeral behind a 2:3 poster.

import { memo } from "react";
import Image from "next/image";
import { api } from "@/lib/flix/api";
import type { CatalogEntry } from "@/lib/flix/types";
import { useUiStore } from "@/store/ui";

function Top10CardBase({ item, rank }: { item: CatalogEntry; rank: number }) {
  const openDetail = useUiStore((s) => s.openDetail);
  // Phase 3 now synthesizes a 2:3 poster from a video frame when no sidecar/
  // embedded poster ships (imagesPass.ts), so poster_hash is usually present;
  // the backdrop/thumb fallbacks stay as a safety net (duration-less files that
  // yield no frame, ffmpeg missing) rather than showing a bare text tile.
  const posterSource = item.posterHash ?? item.backdropHash ?? (item.type === "movie" ? item.thumbHash : null);
  const imageUrl = posterSource ? api.imageUrl(posterSource, 240) : null;

  return (
    <button type="button" onClick={() => openDetail({ type: item.type, id: item.id })} className="group flex w-full shrink-0 items-end gap-1">
      <span aria-hidden className="rank-outline select-none text-[5.5rem] font-black leading-[0.8] sm:text-[7rem]" style={{ WebkitTextStroke: "3px #6b6b6b" }}>
        {rank}
      </span>
      <div className="relative aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-card bg-surface shadow-card transition duration-200 ease-out-quart group-hover:scale-105 hover:-translate-y-1 hover:shadow-lift sm:w-28">
        {imageUrl ? (
          <Image src={imageUrl} alt={item.title} fill sizes="140px" className="object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-1 text-center text-[11px] font-semibold text-muted">{item.title}</div>
        )}
      </div>
    </button>
  );
}

// Memoised like Card: a Top 10 rail sits on the Home page that re-renders on
// every progress/myList change; `item`/`rank` are stable so memo skips those.
export const Top10Card = memo(Top10CardBase);
