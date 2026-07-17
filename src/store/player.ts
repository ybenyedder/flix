"use client";

// Playback intent: "what should the player open next". Deliberately minimal —
// PlayerView resolves the rest itself (media file, decision, resume offset)
// from a single (kind, id[, topId]) triple, so every call site (BillboardHero,
// Card, DetailModal, EpisodeRow, ContinueWatchingCard) can open the player
// without first fetching detail data it doesn't otherwise need.
//
// `nonce` is bumped on every open() so PlayerView can key a full remount off
// it — re-clicking "Lecture" on the same title always restarts the player
// fresh (fresh resume-offset lookup, fresh session) instead of reusing
// possibly-stale internal state from a previous viewing.

import { create } from "zustand";

export type PlaybackKind = "movie" | "show" | "episode";

export interface PlaybackRequest {
  nonce: number;
  /** movie id, show id ("play next up"), or episode id, depending on kind. */
  kind: PlaybackKind;
  id: number;
  /** Show id — required when kind === "episode" (next-episode navigation and
   *  watch-event bookkeeping both need the parent show), ignored otherwise. */
  topId?: number;
  /** Specific media file to play — set by the DetailModal's version picker
   *  when a movie has several files (« 2160p », « Director's Cut »…). Absent
   *  = the default pick (files[0]); auto-advance to another episode always
   *  reverts to the default, a version choice belongs to the item it was
   *  made on. */
  mediaFileId?: number;
  /** Optimistic label shown while the real detail is still loading. */
  title?: string;
  /** Watch-party ("Séance"): initial media offset (s) to open at, overriding
   *  the personal resume, so a guest joins exactly where the room is. */
  startAt?: number;
  /** Watch-party: set when this open was DRIVEN by the room (a guest following
   *  the host's pick) rather than by the local user — PlayerView then never
   *  re-pushes the target back to the room. */
  fromParty?: boolean;
}

/** Pure pick of which of an item's files to play: the requested version when
 *  it still exists (a stale id after a rescan falls back rather than
 *  failing), else the first file — the historical default. */
export function pickPlaybackFile<T extends { id: number }>(files: T[], preferredId?: number): T | undefined {
  if (preferredId !== undefined) {
    const match = files.find((f) => f.id === preferredId);
    if (match) return match;
  }
  return files[0];
}

interface PlayerState {
  request: PlaybackRequest | null;
  open: (request: Omit<PlaybackRequest, "nonce">) => void;
  close: () => void;
}

let nonceCounter = 0;

export const usePlayerStore = create<PlayerState>((set) => ({
  request: null,
  open: (request) => set({ request: { ...request, nonce: ++nonceCounter } }),
  close: () => set({ request: null }),
}));
