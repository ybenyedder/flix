"use client";

// Continue Watching card: thumbnail + red progress bar + "S2 : É4 — Titre"
// subtitle for episodes. Clicking the card resumes playback right where the
// stored progress left off; the small info button opens the parent
// movie/show's detail instead, and the ✕ button dismisses the entry from the
// row (optimistically) without touching the stored position.

import { memo, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Image from "next/image";
import { Info, X } from "lucide-react";
import { api } from "@/lib/flix/api";
import type { ProgressSummary } from "@/lib/flix/types";
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
      <div className="relative aspect-video overflow-hidden rounded-card bg-surface">
        {imageUrl ? (
          <Image src={imageUrl} alt={entry.title} fill sizes="(max-width: 768px) 45vw, 20vw" className="object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-surface-hover text-sm font-semibold text-muted">{entry.title}</div>
        )}
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
        <div className="absolute inset-x-0 bottom-0 h-1 rounded-full bg-white/15">
          <div className="h-full rounded-full bg-accent" style={{ width: `${ratio * 100}%` }} />
        </div>
      </div>
      <div className="mt-1 space-y-0.5">
        <p className="line-clamp-1 text-sm font-medium text-white">{entry.title}</p>
        {entry.subtitle && <p className="line-clamp-1 text-xs text-muted">{entry.subtitle}</p>}
      </div>
    </div>
  );
}

// Memoised: the Continue Watching rail lives on the Home page; a myList/ratings
// mutation re-renders HomeView but not `continueWatching` (memoised on
// [progress]), so entry refs stay stable and memo skips the re-render.
export const ContinueWatchingCard = memo(ContinueWatchingCardBase);
