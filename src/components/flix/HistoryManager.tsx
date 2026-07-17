"use client";

// Bridges the browser/PWA Back button (Android notamment) to Flix's overlay
// stack. Opening the detail modal or the player pushes a history entry;
// popstate (Retour) closes the topmost overlay — player first, then modal —
// instead of leaving the app. Closing an overlay through its own UI consumes
// the matching entry via history.go(-1), with a pending counter so the echoed
// popstate isn't mistaken for a user Back press (no infinite loop).
//
// Renders nothing: it only watches the ui/player stores and window history.

import { useEffect, useRef } from "react";
import { useUiStore } from "@/store/ui";
import { usePlayerStore } from "@/store/player";

export function HistoryManager() {
  const detailOpen = useUiStore((s) => s.detail !== null);
  const playerOpen = usePlayerStore((s) => s.request !== null);

  /** History entries we pushed and have not yet consumed. */
  const depthRef = useRef(0);
  /** history.go() steps we triggered ourselves, whose popstate must be ignored. */
  const pendingPopsRef = useRef(0);

  // Keep the history stack in sync with the overlay stack. Opening pushes,
  // closing through the UI consumes; changes caused by a user Back press have
  // already been accounted for in the popstate handler below, so the depths
  // match and this effect no-ops.
  useEffect(() => {
    const depth = (detailOpen ? 1 : 0) + (playerOpen ? 1 : 0);
    if (depth > depthRef.current) {
      for (let i = depthRef.current; i < depth; i += 1) window.history.pushState({ flix: true }, "");
      depthRef.current = depth;
    } else if (depth < depthRef.current) {
      const toConsume = depthRef.current - depth;
      depthRef.current = depth;
      pendingPopsRef.current += toConsume;
      window.history.go(-toConsume);
    }
  }, [detailOpen, playerOpen]);

  useEffect(() => {
    const onPopState = () => {
      if (pendingPopsRef.current > 0) {
        // Echo of our own history.go() after a UI-driven close — not a Back press.
        pendingPopsRef.current -= 1;
        return;
      }
      // Real Back press: close the topmost overlay. depthRef is decremented
      // *before* the store update so the sync effect above sees matching
      // depths and doesn't try to consume a second entry.
      if (usePlayerStore.getState().request) {
        depthRef.current = Math.max(0, depthRef.current - 1);
        usePlayerStore.getState().close();
      } else if (useUiStore.getState().detail) {
        depthRef.current = Math.max(0, depthRef.current - 1);
        useUiStore.getState().closeDetail();
      }
      // Nothing open (e.g. stale entry after a refresh): let the browser
      // navigate normally.
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return null;
}
