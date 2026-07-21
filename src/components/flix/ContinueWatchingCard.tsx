"use client";

// Continue Watching card: thumbnail + red progress bar + "S2 : É4 — Titre"
// subtitle for episodes. Clicking the card resumes playback right where the
// stored progress left off; the small info button opens the parent
// movie/show's detail instead, and the ✕ button dismisses the entry from the
// row (optimistically) without touching the stored position.

import { memo, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Image from "next/image";
import { Info, Play, X } from "lucide-react";
import { api } from "@/lib/flix/api";
import type { ProgressSummary } from "@/lib/flix/types";
import { formatDuration } from "@/lib/flix/format";
import { useUiStore } from "@/store/ui";
import { usePlayerStore } from "@/store/player";
import { useStateStore } from "@/store/state";

function ContinueWatchingCardBase({ entry }: { entry: ProgressSummary }) {
  const openDetail = useUiStore((s) => s.openDetail);
  const notify = useUiStore((s) => s.notify);
  const openPlayer = usePlayerStore((s) => s.open);
  const dismissProgress = useStateStore((s) => s.dismissProgress);
  const image = entry.thumbHash ?? entry.backdropHash ?? entry.posterHash;
  const imageUrl = image ? api.imageUrl(image, 480) : null;
  const ratio = entry.duration > 0 ? Math.min(1, entry.position / entry.duration) : 0;

  const play = () =>
    openPlayer(
      entry.itemType === "movie"
        ? { kind: "movie", id: entry.itemId, title: entry.title }
        : { kind: "episode", id: entry.itemId, topId: entry.topId, title: entry.title },
    );

  // Keyboard/touch parity with the click: Enter/Espace resumes playback.
  // Keydowns bubbling up from the inner info <button> are ignored.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      play();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Reprendre ${entry.title}`}
      className="group w-full cursor-pointer transition duration-200 ease-out-quart hover:-translate-y-1 hover:shadow-lift"
      onClick={play}
      onKeyDown={onKeyDown}
    >
      <div className="relative aspect-video overflow-hidden rounded-card bg-surface ring-1 ring-white/5 transition-shadow duration-200 group-hover:ring-2 group-hover:ring-white/25">
        {imageUrl ? (
          <Image
            src={imageUrl}
            alt={entry.title}
            fill
            sizes="(max-width: 768px) 45vw, 20vw"
            className="object-cover transition-transform duration-300 ease-out-quart group-hover:scale-[1.05]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-surface-hover text-sm font-semibold text-muted">{entry.title}</div>
        )}
        {/* Resume affordance: a glass play chip surfaces on hover/focus, so the
         * whole card visibly IS the resume action, not just an image. */}
        <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/0 transition-colors duration-200 group-hover:bg-black/30">
          <span className="grid size-12 place-items-center rounded-full glass opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <Play className="size-6 fill-white text-white" />
          </span>
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openDetail({ type: entry.topType, id: entry.topId });
          }}
          aria-label="Plus d’infos"
          className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Info className="size-4" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void dismissProgress(entry.itemType, entry.itemId);
            notify("Retiré de Continuer à regarder");
          }}
          aria-label="Retirer de Continuer à regarder"
          title="Retirer de Continuer à regarder"
          className="absolute right-10 top-2 grid size-7 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X className="size-4" />
        </button>
        {/* Floating rounded progress track (2026 style) instead of a bar glued
         * to the card edge. */}
        <div className="absolute inset-x-2.5 bottom-2 h-1 overflow-hidden rounded-full bg-white/25">
          <div className="h-full rounded-full bg-accent" style={{ width: `${ratio * 100}%` }} />
        </div>
      </div>
      <div className="mt-1.5 space-y-0.5 px-0.5">
        <p className="line-clamp-1 text-sm font-medium text-white">{entry.title}</p>
        <p className="line-clamp-1 text-xs text-muted">
          {entry.subtitle ? `${entry.subtitle} · ` : ""}
          {entry.duration > entry.position ? `il reste ${formatDuration(entry.duration - entry.position)}` : ""}
        </p>
      </div>
    </div>
  );
}

// Memoised: the Continue Watching rail lives on the Home page; a myList/ratings
// mutation re-renders HomeView but not `continueWatching` (memoised on
// [progress]), so entry refs stay stable and memo skips the re-render.
export const ContinueWatchingCard = memo(ContinueWatchingCardBase);
