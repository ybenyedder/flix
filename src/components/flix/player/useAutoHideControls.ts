"use client";

// Extracted verbatim from PlayerView — the controls-overlay auto-hide. Surfaces
// the controls on mousemove/click and hides them after 3s of stillness while
// playing (unless the track menu is open). The `reset` closure, the listeners,
// the assignment to the shared `controlsResetRef` (read by stepVolume /
// handleVideoClick in PlayerView, which keep the same ref object) and the
// cleanup are byte-identical to the original effect.
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
    return () => {
      container.removeEventListener("mousemove", reset);
      container.removeEventListener("click", reset);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [playing, showTrackMenu, setShowControls, containerRef, hideTimerRef, controlsResetRef]);
}
