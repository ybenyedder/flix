"use client";

// Extracted from PlayerView — the controls-overlay auto-hide. Surfaces the
// controls on mousemove/click/keydown and hides them after 3s of stillness
// while playing (unless the track menu is open). The `reset` closure is shared
// through `controlsResetRef` (read by stepVolume / handleVideoClick in
// PlayerView, which keep the same ref object).
//
// Dependency array reproduces the original reactive deps `[playing,
// showTrackMenu]` exactly; the only additions are the referentially-stable
// setter/refs (`setShowControls`, `containerRef`, `hideTimerRef`,
// `controlsResetRef`) that exhaustive-deps now requires because they are hook
// parameters rather than same-scope useState/useRef values — stable identities
// that never trigger an extra re-run.

import { useEffect, type RefObject } from "react";

interface AutoHideControlsParams {
  containerRef: RefObject<HTMLDivElement | null>;
  hideTimerRef: RefObject<number | null>;
  controlsResetRef: RefObject<() => void>;
  setShowControls: (value: boolean) => void;
  playing: boolean;
  showTrackMenu: boolean;
}

export function useAutoHideControls({
  containerRef,
  hideTimerRef,
  controlsResetRef,
  setShowControls,
  playing,
  showTrackMenu,
}: AutoHideControlsParams): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const reset = () => {
      setShowControls(true);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => {
        if (playing && !showTrackMenu) setShowControls(false);
      }, 3000);
    };
    controlsResetRef.current = reset;
    reset();
    container.addEventListener("mousemove", reset);
    container.addEventListener("click", reset);
    // Keyboard users could never bring the controls back: only mouse activity
    // reset the timer, and hiding unmounts the overlay (focus falls to body,
    // so no control can be tabbed to either). Window-level to match the global
    // player shortcuts (usePlayerKeyboard) — revealing the overlay on any key
    // is harmless.
    window.addEventListener("keydown", reset);
    return () => {
      container.removeEventListener("mousemove", reset);
      container.removeEventListener("click", reset);
      window.removeEventListener("keydown", reset);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [playing, showTrackMenu, setShowControls, containerRef, hideTimerRef, controlsResetRef]);
}
