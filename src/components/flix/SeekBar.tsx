"use client";

// Draggable progress bar. Reports absolute seconds on release; a live drag
// preview follows the pointer instead of the actual playhead so scrubbing
// past the network-buffered region doesn't visually stutter.
//
// Optional extras, both absent-safe:
//  - `chapters`: discreet tick markers at every chapter boundary; hovering
//    near one shows its title in the bubble.
//  - `trickplay` + `trickplaySpriteUrl`: a thumbnail preview above the cursor
//    while hovering (mouse) or scrubbing (mouse drag AND touch drag — the
//    pointer-capture drag path drives the same preview, so a finger scrub on
//    mobile gets thumbnails too), rendered as a background-position window
//    onto the one big sprite. No trickplay → a plain timecode/title tooltip.

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { chapterAt, formatTime, trickplayTileFor } from "@/lib/flix/playerLogic";
import type { PlaybackChapter, TrickplayMeta } from "@/lib/flix/types";

interface SeekBarProps {
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
  chapters?: PlaybackChapter[];
  trickplay?: TrickplayMeta | null;
  trickplaySpriteUrl?: string | null;
}

export function SeekBar({ currentTime, duration, onSeek, chapters, trickplay, trickplaySpriteUrl }: SeekBarProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragRatio, setDragRatio] = useState(0);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);

  const ratio = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  const shown = dragging ? dragRatio : ratio;

  const ratioFromEvent = (e: ReactPointerEvent<HTMLDivElement>): number => {
    const el = ref.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  // Preview follows the finger/pointer while dragging, the mouse while merely
  // hovering. Nothing to preview without a known duration.
  const previewRatio = duration > 0 ? (dragging ? dragRatio : hoverRatio) : null;
  const previewTime = previewRatio !== null ? previewRatio * duration : null;
  const previewChapter = previewTime !== null && chapters?.length ? chapterAt(chapters, previewTime) : null;
  const thumb =
    previewTime !== null && trickplay && trickplaySpriteUrl
      ? { meta: trickplay, url: trickplaySpriteUrl, tile: trickplayTileFor(trickplay, previewTime) }
      : null;

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Progression de la lecture"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Math.round(duration))}
      aria-valuenow={Math.round(currentTime)}
      // Screen readers announce a bare seconds count from aria-valuenow; give
      // them the readable "1:23 sur 5:00" instead.
      aria-valuetext={duration > 0 ? `${formatTime(currentTime)} sur ${formatTime(duration)}` : undefined}
      tabIndex={0}
      // Left/Right (±10 s) and Up/Down (volume) come from the player's global key
      // handler even while this slider is focused; add the slider conventions it
      // lacks so the scrubber is fully operable by keyboard (WCAG 2.1.1).
      onKeyDown={(e) => {
        if (duration <= 0) return;
        let next: number;
        if (e.key === "Home") next = 0;
        else if (e.key === "End") next = duration;
        else if (e.key === "PageDown") next = currentTime - 60;
        else if (e.key === "PageUp") next = currentTime + 60;
        else return;
        e.preventDefault();
        onSeek(Math.min(duration, Math.max(0, next)));
      }}
      className="group/seek relative h-1.5 w-full cursor-pointer touch-none rounded-full bg-white/25 transition-[height] hover:h-2"
      onPointerDown={(e) => {
        setDragging(true);
        setDragRatio(ratioFromEvent(e));
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const r = ratioFromEvent(e);
        if (dragging) setDragRatio(r);
        // Hover preview is mouse-only: a captured touch drag already drives
        // the preview through dragRatio, and a stray touchmove must not leave
        // a phantom hover bubble behind after the finger lifts.
        if (e.pointerType === "mouse") setHoverRatio(r);
      }}
      onPointerLeave={() => setHoverRatio(null)}
      onPointerUp={(e) => {
        if (!dragging) return;
        const r = ratioFromEvent(e);
        setDragging(false);
        if (e.pointerType !== "mouse") setHoverRatio(null);
        if (duration > 0) onSeek(r * duration);
      }}
      onPointerCancel={() => {
        // A cancelled drag (orientation change, system dialog) never gets its
        // pointerup — release the bar instead of freezing it mid-drag.
        setDragging(false);
        setHoverRatio(null);
      }}
    >
      <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${shown * 100}%` }} />

      {/* Chapter markers — discreet ticks; position 0 is skipped (a tick under the playhead origin is just noise). */}
      {duration > 0 &&
        chapters
          ?.filter((c) => c.start > 0 && c.start < duration)
          .map((c, i) => (
            <div
              key={`${c.start}-${i}`}
              aria-hidden
              className="pointer-events-none absolute top-1/2 h-[150%] w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/60"
              style={{ left: `${(c.start / duration) * 100}%` }}
            />
          ))}

      {/* Playhead knob: revealed on hover like Netflix, but ALSO while
       * dragging — a touch scrub has no hover, and an invisible knob under
       * the finger reads as a dead bar. */}
      <div
        className={
          "absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full bg-accent shadow-[0_1px_6px_rgb(0_0_0/0.6)] transition-opacity " +
          (dragging ? "opacity-100" : "opacity-0 group-hover/seek:opacity-100")
        }
        style={{ left: `calc(${shown * 100}% - 7px)` }}
      />

      {/* Hover/scrub preview: trickplay thumbnail when available, plain timecode (+ chapter title) tooltip otherwise. */}
      {previewRatio !== null && previewTime !== null && (
        <div
          className="pointer-events-none absolute bottom-4 z-10 flex -translate-x-1/2 flex-col items-center gap-1"
          style={{
            left: thumb
              ? `clamp(${thumb.meta.tileWidth / 2}px, ${previewRatio * 100}%, calc(100% - ${thumb.meta.tileWidth / 2}px))`
              : `clamp(3rem, ${previewRatio * 100}%, calc(100% - 3rem))`,
          }}
        >
          {thumb && (
            <div
              className="overflow-hidden rounded-panel border border-white/60 bg-black shadow-pop"
              style={{
                width: thumb.meta.tileWidth,
                height: thumb.meta.tileHeight,
                backgroundImage: `url(${thumb.url})`,
                backgroundPosition: `${thumb.tile.offsetX}px ${thumb.tile.offsetY}px`,
                backgroundSize: `${thumb.meta.cols * thumb.meta.tileWidth}px auto`,
              }}
            />
          )}
          <div className="max-w-64 rounded-field bg-black/80 px-2 py-0.5 text-center text-xs font-semibold tabular-nums text-white shadow">
            {formatTime(previewTime)}
            {previewChapter?.title && <span className="block truncate font-normal text-white/75">{previewChapter.title}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
