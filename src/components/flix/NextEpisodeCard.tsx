"use client";

// Shown over the player once the end-credits chapter starts (or, without
// chapters, during the episode's last 30 seconds — see nextUpTriggerTime in
// playerLogic.ts): a 10s countdown to the next episode, cancellable, with an
// immediate "Lecture" override.

import { useEffect, useState } from "react";
import Image from "next/image";
import { Play, X } from "lucide-react";
import { api } from "@/lib/flix/api";
import type { EpisodeDetail } from "@/lib/flix/types";

const COUNTDOWN_SECONDS = 10;

export function NextEpisodeCard({ episode, playing, onPlayNext, onDismiss }: { episode: EpisodeDetail; playing: boolean; onPlayNext: () => void; onDismiss: () => void }) {
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS);

  useEffect(() => {
    if (remaining <= 0) {
      onPlayNext();
      return;
    }
    // Freeze while paused or buffering: the countdown must follow the
    // playback, not the wall clock — otherwise pausing on the credits to grab
    // a drink still auto-starts the next episode 10s later (and, as séance
    // host, drags the whole room along).
    if (!playing) return;
    const id = window.setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => window.clearTimeout(id);
    // Countdown ticks off its own previous value only — onPlayNext is stable
    // enough per mount that re-running this on every parent render would just
    // restart the timer for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, playing]);

  const imageUrl = episode.thumbHash ? api.imageUrl(episode.thumbHash, 480) : null;

  return (
    <div className="absolute bottom-24 right-4 z-20 w-72 overflow-hidden glass rounded-panel shadow-pop animate-scale-in origin-bottom-right md:right-8 md:w-80">
      <button type="button" onClick={onDismiss} aria-label="Fermer" className="absolute right-2 top-2 z-10 grid size-7 place-items-center glass rounded-full text-white transition-colors hover:bg-white/15">
        <X className="size-4" />
      </button>
      <div className="relative aspect-video w-full bg-surface-hover">{imageUrl && <Image src={imageUrl} alt="" fill sizes="320px" className="object-cover" />}</div>
      <div className="p-3">
        <p className="mb-2 text-xs text-muted">Épisode suivant dans {remaining}s</p>
        <p className="mb-3 line-clamp-1 text-sm font-semibold text-white">
          {episode.episodeNumber}. {episode.title ?? `Épisode ${episode.episodeNumber}`}
        </p>
        <button type="button" onClick={onPlayNext} className="flex w-full items-center justify-center gap-2 rounded-full bg-white py-2 font-bold text-black transition-colors hover:bg-white/80">
          <Play className="size-4 fill-black" /> Lecture
        </button>
      </div>
    </div>
  );
}
