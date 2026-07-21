"use client";

// One row inside DetailModal's season list: thumbnail, number, title,
// duration, synopsis, and a thin progress bar when the episode is
// in-progress. A single check button doubles as the watched indicator (always
// visible once the episode is seen — the "coche discrète") and, on hover or
// focus, as the marquer vu / non vu toggle.

import Image from "next/image";
import { Check, Play } from "lucide-react";
import { api } from "@/lib/flix/api";
import type { EpisodeDetail } from "@/lib/flix/types";
import { formatDuration } from "@/lib/flix/format";
import { usePlayerStore } from "@/store/player";
import { useStateStore } from "@/store/state";
import { useUiStore } from "@/store/ui";

export function EpisodeRow({ episode, showId, showTitle }: { episode: EpisodeDetail; showId: number; showTitle: string }) {
  const openPlayer = usePlayerStore((s) => s.open);
  const closeDetail = useUiStore((s) => s.closeDetail);
  const progress = useStateStore((s) => s.progress.find((p) => p.itemType === "episode" && p.itemId === episode.id));
  const setWatched = useStateStore((s) => s.setWatched);
  const imageUrl = episode.thumbHash ? api.imageUrl(episode.thumbHash, 480) : null;
  const ratio = progress && progress.duration > 0 ? Math.min(1, progress.position / progress.duration) : 0;
  const label = episode.title ?? `Épisode ${episode.episodeNumber}`;
  const watched = progress?.watched === true;
  const watchedLabel = watched ? "Marquer comme non vu" : "Marquer comme vu";

  return (
    <div className="group/episode -mx-3 flex items-start gap-4 rounded-panel px-3 py-4 transition-colors hover:bg-white/5">
      <span className="w-8 shrink-0 pt-2 text-center font-display text-2xl font-semibold tabular-nums text-muted">{episode.episodeNumber}</span>
      <button
        type="button"
        onClick={() => {
          openPlayer({ kind: "episode", id: episode.id, topId: showId, title: `${showTitle} — ${label}` });
          closeDetail();
        }}
        aria-label="Lecture"
        className="group relative aspect-video w-40 shrink-0 overflow-hidden rounded-card bg-surface-hover sm:w-48"
      >
        {imageUrl && <Image src={imageUrl} alt="" fill sizes="192px" className="object-cover" />}
        <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/40">
          <Play className="size-8 text-white opacity-0 transition-opacity group-hover:opacity-100" />
        </span>
        {ratio > 0 && (
          <span className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
            <span className="block h-full bg-accent" style={{ width: `${ratio * 100}%` }} />
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium text-white">{label}</p>
          <span className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void setWatched("episode", episode.id, !watched, { topId: showId })}
              aria-label={watchedLabel}
              title={watchedLabel}
              className={
                "grid size-6 place-items-center rounded-full border transition-all " +
                (watched
                  ? "border-white/60 bg-white/10 text-green-500 hover:border-white"
                  : "border-white/40 text-white opacity-0 hover:border-white focus-visible:opacity-100 group-hover/episode:opacity-100")
              }
            >
              <Check className="size-3.5" />
            </button>
            <span className="text-xs text-muted">{formatDuration(episode.duration)}</span>
          </span>
        </div>
        {episode.synopsis && <p className="line-clamp-2 text-xs text-muted">{episode.synopsis}</p>}
      </div>
    </div>
  );
}
