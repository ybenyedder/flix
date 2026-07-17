"use client";

// Extracted verbatim from PlayerView — restores the persisted volume/mute onto
// the <video> element once it exists.
//
// No setState here: if the stored values differ from the element defaults,
// assigning them fires `volumechange`, whose listener (wired in PlayerView's
// still-in-place <video> DOM-event effect) syncs the React state; if they don't
// differ, the state defaults already match. The write half of persistence
// (writeStoredVolume, called from that same coupled DOM-event effect) is left
// in PlayerView on purpose — this hook only owns the read-on-mount side, so no
// coupled effect is touched.
//
// The effect keeps its original empty-reactive dependency list; the only
// dependency-array entry is the referentially-stable `videoRef` (required by
// exhaustive-deps once it is a hook parameter).

import { useEffect, type RefObject } from "react";
import { parseStoredVolume, VOLUME_STORAGE_KEY, type StoredVolume } from "@/lib/flix/playerLogic";

/** Persisted volume/mute, or null when absent/corrupted/blocked (private
 *  browsing can make localStorage throw — never let that break playback). */
function readStoredVolume(): StoredVolume | null {
  try {
    return parseStoredVolume(window.localStorage.getItem(VOLUME_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function useVolumePersistence(videoRef: RefObject<HTMLVideoElement | null>): void {
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const stored = readStoredVolume();
    if (!stored) return;
    video.volume = stored.volume;
    video.muted = stored.muted;
  }, [videoRef]);
}
