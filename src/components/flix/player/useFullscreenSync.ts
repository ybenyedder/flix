"use client";

// Extracted verbatim from PlayerView — mirrors the document's fullscreen state
// into React state via the `fullscreenchange` event. Body, listener and cleanup
// are byte-identical to the original effect; the only dependency-array change is
// the referentially-stable `setFullscreen` setter (required by exhaustive-deps
// once it is a hook parameter rather than a same-scope useState setter).

import { useEffect } from "react";

export function useFullscreenSync(setFullscreen: (value: boolean) => void): void {
  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [setFullscreen]);
}
