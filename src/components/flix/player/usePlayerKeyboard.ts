"use client";

// Extracted verbatim from PlayerView — global keyboard shortcuts for the player
// (space/k play-pause, arrows seek/volume, m mute, f fullscreen, Escape). The
// keydown handler body, the window listener and its cleanup are byte-identical
// to the original effect; the transport actions and menu state it needs are
// received as arguments so no state or ref is duplicated.
//
// Dependency array reproduces the original reactive deps exactly; the only
// addition is the referentially-stable `setShowTrackMenu` setter (required by
// exhaustive-deps once it is a hook parameter rather than a same-scope useState
// setter) — a stable identity that never triggers an extra re-subscribe.

import { useEffect } from "react";

interface PlayerKeyboardParams {
  togglePlay: () => void;
  seekRelative: (delta: number) => void;
  stepVolume: (delta: number) => void;
  toggleMute: () => void;
  toggleFullscreen: () => void;
  close: () => void;
  showTrackMenu: boolean;
  setShowTrackMenu: (value: boolean) => void;
}

export function usePlayerKeyboard({
  togglePlay,
  seekRelative,
  stepVolume,
  toggleMute,
  toggleFullscreen,
  close,
  showTrackMenu,
  setShowTrackMenu,
}: PlayerKeyboardParams): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case " ":
          // Space must still activate a focused control (« Passer l'intro »,
          // ✕, TrackMenu) — let the browser deliver the click instead.
          if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLSelectElement || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
          e.preventDefault();
          togglePlay();
          break;
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          seekRelative(-10);
          break;
        case "ArrowRight":
          seekRelative(10);
          break;
        case "ArrowUp":
          e.preventDefault();
          stepVolume(0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          stepVolume(-0.1);
          break;
        case "m":
          toggleMute();
          break;
        case "f":
          toggleFullscreen();
          break;
        case "Escape":
          // The track menu has priority: Escape closes it and nothing else.
          if (showTrackMenu) {
            setShowTrackMenu(false);
            break;
          }
          if (document.fullscreenElement) void document.exitFullscreen();
          else close();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekRelative, stepVolume, toggleMute, toggleFullscreen, close, showTrackMenu, setShowTrackMenu]);
}
