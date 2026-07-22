"use client";

// Bottom/top control bars overlaid on the <video>. Purely presentational —
// every action is a callback prop, every displayed value a prop — so
// PlayerView owns all the actual media-element state.

import type { CSSProperties } from "react";
import { ArrowLeft, Captions, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";
import { formatTime } from "@/lib/flix/playerLogic";
import type { PlaybackChapter, TrickplayMeta } from "@/lib/flix/types";
import { SeekBar } from "./SeekBar";

interface PlayerControlsProps {
  title: string;
  subtitle: string | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  trackMenuAvailable: boolean;
  /** Chapter list from the playback decision — seekbar markers + hover titles. */
  chapters?: PlaybackChapter[];
  /** Trickplay metadata + sprite URL (both null/absent when not generated). */
  trickplay?: TrickplayMeta | null;
  trickplaySpriteUrl?: string | null;
  onClose: () => void;
  onTogglePlay: () => void;
  onSeekRelative: (deltaSeconds: number) => void;
  onSeekTo: (seconds: number) => void;
  onVolumeChange: (value: number) => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onToggleTrackMenu: () => void;
}

export function PlayerControls({
  title,
  subtitle,
  playing,
  currentTime,
  duration,
  volume,
  muted,
  fullscreen,
  trackMenuAvailable,
  chapters,
  trickplay,
  trickplaySpriteUrl,
  onClose,
  onTogglePlay,
  onSeekRelative,
  onSeekTo,
  onVolumeChange,
  onToggleMute,
  onToggleFullscreen,
  onToggleTrackMenu,
}: PlayerControlsProps) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-b from-black/70 via-transparent to-black/85">
      <div className="pointer-events-auto flex items-center gap-4 p-4 md:p-8">
        <button type="button" onClick={onClose} aria-label="Fermer le lecteur" className="-ml-1.5 player-btn">
          <ArrowLeft className="size-7" />
        </button>
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold text-white">{title}</p>
          {subtitle && <p className="truncate text-sm text-muted">{subtitle}</p>}
        </div>
      </div>

      <div className="pointer-events-auto space-y-2 p-4 md:px-8 md:pb-6">
        <SeekBar currentTime={currentTime} duration={duration} onSeek={onSeekTo} chapters={chapters} trickplay={trickplay} trickplaySpriteUrl={trickplaySpriteUrl} />
        <div className="flex flex-wrap items-center gap-4">
          <button type="button" onClick={onTogglePlay} aria-label={playing ? "Mettre en pause" : "Lecture"} className="player-btn">
            {playing ? <Pause className="size-7 fill-white" /> : <Play className="size-7 fill-white" />}
          </button>
          <button type="button" onClick={() => onSeekRelative(-10)} aria-label="Reculer de 10 secondes" className="player-btn">
            <RotateCcw className="size-6" />
          </button>
          <button type="button" onClick={() => onSeekRelative(10)} aria-label="Avancer de 10 secondes" className="player-btn">
            <RotateCw className="size-6" />
          </button>
          <div className="group flex items-center gap-2">
            <button type="button" onClick={onToggleMute} aria-label={muted ? "Réactiver le son" : "Couper le son"} className="player-btn">
              {muted || volume === 0 ? <VolumeX className="size-6" /> : <Volume2 className="size-6" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => onVolumeChange(Number(e.target.value))}
              aria-label="Volume"
              // `--vol` drives the filled portion of the custom track (globals.css).
              style={{ "--vol": muted ? 0 : volume } as CSSProperties}
              className="volume-slider w-16 md:w-24"
            />
          </div>
          <span className="text-sm font-medium tabular-nums text-white/85">
            {formatTime(currentTime)} / <span className="text-white/55">{formatTime(duration)}</span>
          </span>
          <div className="ml-auto flex items-center gap-4">
            {trackMenuAvailable && (
              <button type="button" onClick={onToggleTrackMenu} aria-label="Pistes audio et sous-titres" className="player-btn">
                <Captions className="size-6" />
              </button>
            )}
            <button type="button" onClick={onToggleFullscreen} aria-label={fullscreen ? "Quitter le plein écran" : "Plein écran"} className="player-btn">
              {fullscreen ? <Minimize className="size-6" /> : <Maximize className="size-6" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
