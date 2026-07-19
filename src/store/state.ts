"use client";

// Per-profile state (my list, ratings, watch progress) backed by
// GET/POST /api/state (src/app/api/state/route.ts -> src/server/state/userState.ts).
// Mutations are applied optimistically and rolled back via a full reload on
// failure, matching the pattern used by Auralis's favourites/dislikes.

import { create } from "zustand";
import { api } from "@/lib/flix/api";
import type { MyListEntry, RatingEntry, ProgressSummary, UserStateSnapshot } from "@/lib/flix/types";

type ItemType = "movie" | "show";

/** ProgressSummary as the server actually serialises it since the v3 schema:
 *  `dismissed` marks a row removed from "Continuer à regarder" (its position
 *  survives — the server also reports duration 0 for those rows, which is
 *  what every "in progress" predicate keys off). Local extension of the
 *  shared DTO so the base type stays in lockstep with types.ts. */
export type ProgressEntry = ProgressSummary & { dismissed: boolean };

type StateSnapshot = Omit<UserStateSnapshot, "progress"> & { progress: ProgressEntry[] };

interface StateStore {
  loaded: boolean;
  myList: MyListEntry[];
  ratings: RatingEntry[];
  progress: ProgressEntry[];
  // Derived lookup indices, rebuilt ONCE per snapshot change (see withDerived).
  // Every mounted Card runs its selectors on every store set(); with arrays
  // that was O(cards × rows) linear scans per mutation — thousands of them on
  // a large grid. These make each selector O(1). Arrays stay the source of
  // truth; the indices are never mutated in place.
  myListKeys: Set<string>;
  ratingByKey: Map<string, number>;
  watchedKeys: Set<string>;
  seenTopKeys: Set<string>;
  watchedEpisodeCountByShow: Map<number, number>;
  load: () => Promise<void>;
  reset: () => void;
  isInMyList: (itemType: ItemType, itemId: number) => boolean;
  ratingFor: (itemType: ItemType, itemId: number) => number;
  /** "Vu" for a movie = its progress row is watched; for a show = every one
   *  of its `totalEpisodes` indexed episodes has a watched row. */
  isWatched: (itemType: ItemType, itemId: number, totalEpisodes?: number) => boolean;
  toggleMyList: (itemType: ItemType, itemId: number) => Promise<void>;
  setRating: (itemType: ItemType, itemId: number, value: number) => Promise<void>;
  setProgress: (itemType: "movie" | "episode", itemId: number, position: number, duration: number, mediaFileId?: number | null) => Promise<void>;
  setWatched: (itemType: "movie" | "episode" | "show", itemId: number, watched: boolean, opts?: { topId?: number; episodeIds?: number[] }) => Promise<void>;
  dismissProgress: (itemType: "movie" | "episode", itemId: number) => Promise<void>;
}

const EMPTY: StateSnapshot = { myList: [], ratings: [], progress: [] };

const keyOf = (itemType: string, itemId: number) => `${itemType}:${itemId}`;

/** Augment a partial state update with the derived indices for whichever
 *  source array it carries — the ONE place they are computed, so no set()
 *  site can forget to keep them in sync. */
function withDerived(partial: Partial<StateSnapshot> & { loaded?: boolean }) {
  const out: Partial<StateStore> = { ...partial };
  if (partial.myList) {
    out.myListKeys = new Set(partial.myList.map((e) => keyOf(e.itemType, e.itemId)));
  }
  if (partial.ratings) {
    out.ratingByKey = new Map(partial.ratings.map((e) => [keyOf(e.itemType, e.itemId), e.value]));
  }
  if (partial.progress) {
    const watchedKeys = new Set<string>();
    const seenTopKeys = new Set<string>();
    const episodeSets = new Map<number, Set<number>>();
    for (const p of partial.progress) {
      if (!p.watched) continue;
      watchedKeys.add(keyOf(p.itemType, p.itemId));
      seenTopKeys.add(keyOf(p.topType, p.topId));
      if (p.itemType === "episode" && p.topType === "show") {
        let s = episodeSets.get(p.topId);
        if (!s) episodeSets.set(p.topId, (s = new Set()));
        s.add(p.itemId);
      }
    }
    const watchedEpisodeCountByShow = new Map<number, number>();
    for (const [showId, s] of episodeSets) watchedEpisodeCountByShow.set(showId, s.size);
    out.watchedKeys = watchedKeys;
    out.seenTopKeys = seenTopKeys;
    out.watchedEpisodeCountByShow = watchedEpisodeCountByShow;
  }
  return out;
}

/** Minimal optimistic progress row for an item that had none yet — enough for
 *  every watched/seen predicate (checkmarks, badges, buildSeenKeys); load()
 *  replaces it with the server-enriched version right after the POST lands. */
function optimisticWatchedEntry(itemType: "movie" | "episode", itemId: number, topType: ItemType, topId: number): ProgressEntry {
  return {
    itemType,
    itemId,
    mediaFileId: null,
    position: 0,
    duration: 0,
    watched: true,
    dismissed: false,
    updatedAt: Date.now(),
    topType,
    topId,
    title: "",
    subtitle: null,
    posterHash: null,
    backdropHash: null,
    thumbHash: null,
  };
}

export const useStateStore = create<StateStore>((set, get) => ({
  loaded: false,
  myList: [],
  ratings: [],
  progress: [],
  myListKeys: new Set<string>(),
  ratingByKey: new Map<string, number>(),
  watchedKeys: new Set<string>(),
  seenTopKeys: new Set<string>(),
  watchedEpisodeCountByShow: new Map<number, number>(),

  load: async () => {
    try {
      const data = await api.get<StateSnapshot>("/api/state");
      set({ loaded: true, ...withDerived({ myList: data.myList, ratings: data.ratings, progress: data.progress }) });
    } catch {
      // Keep whatever is already loaded: load() doubles as the rollback for
      // every optimistic mutation AND the resync on player close, so wiping to
      // EMPTY here made a transient network blip erase Ma liste / progress /
      // watched marks from the whole UI until a later load succeeded. Profile
      // switches don't need the wipe either — reset() handles those.
      set({ loaded: true });
    }
  },

  reset: () => set({ loaded: false, ...withDerived(EMPTY) }),

  isInMyList: (itemType, itemId) => get().myListKeys.has(keyOf(itemType, itemId)),
  ratingFor: (itemType, itemId) => get().ratingByKey.get(keyOf(itemType, itemId)) ?? 0,

  isWatched: (itemType, itemId, totalEpisodes) => {
    if (itemType === "movie") return get().watchedKeys.has(keyOf("movie", itemId));
    if (!totalEpisodes || totalEpisodes <= 0) return false;
    return (get().watchedEpisodeCountByShow.get(itemId) ?? 0) >= totalEpisodes;
  },

  toggleMyList: async (itemType, itemId) => {
    const already = get().isInMyList(itemType, itemId);
    const next = already
      ? get().myList.filter((e) => !(e.itemType === itemType && e.itemId === itemId))
      : [...get().myList, { itemType, itemId, createdAt: Date.now() }];
    set(withDerived({ myList: next }));
    try {
      await api.post("/api/state", { kind: "myList", itemType, itemId, add: !already });
    } catch {
      void get().load();
    }
  },

  setRating: async (itemType, itemId, value) => {
    const current = get().ratingFor(itemType, itemId);
    const nextValue = current === value ? 0 : value;
    const withoutEntry = get().ratings.filter((e) => !(e.itemType === itemType && e.itemId === itemId));
    set(withDerived({ ratings: nextValue === 0 ? withoutEntry : [...withoutEntry, { itemType, itemId, value: nextValue, createdAt: Date.now() }] }));
    try {
      await api.post("/api/state", { kind: "rating", itemType, itemId, value: nextValue });
    } catch {
      void get().load();
    }
  },

  setProgress: async (itemType, itemId, position, duration, mediaFileId) => {
    try {
      await api.post("/api/state", { kind: "progress", itemType, itemId, position, duration, mediaFileId: mediaFileId ?? null });
    } catch {
      /* best-effort — Phase 6 will retry on the next tick */
    }
  },

  setWatched: async (itemType, itemId, watched, opts) => {
    // A show fans out to its episode rows; a movie/episode targets its own row.
    const matches = (p: ProgressEntry) =>
      itemType === "show" ? p.itemType === "episode" && p.topType === "show" && p.topId === itemId : p.itemType === itemType && p.itemId === itemId;

    if (!watched) {
      // "Non vu" erases progression + flag — mirror the server's DELETE.
      set(withDerived({ progress: get().progress.filter((p) => !matches(p)) }));
    } else {
      const next = get().progress.map((p) => (matches(p) ? { ...p, watched: true, position: p.duration, dismissed: false } : p));
      const have = new Set(next.filter(matches).map((p) => p.itemId));
      if (itemType === "movie" && !have.has(itemId)) next.push(optimisticWatchedEntry("movie", itemId, "movie", itemId));
      if (itemType === "episode" && !have.has(itemId) && opts?.topId !== undefined) next.push(optimisticWatchedEntry("episode", itemId, "show", opts.topId));
      if (itemType === "show") {
        for (const episodeId of opts?.episodeIds ?? []) {
          if (!have.has(episodeId)) next.push(optimisticWatchedEntry("episode", episodeId, "show", itemId));
        }
      }
      set(withDerived({ progress: next }));
    }

    try {
      await api.post("/api/state", { kind: "setWatched", itemType, itemId, watched });
      // Reconcile the optimistic rows with the server-enriched ones
      // (title/poster/real durations) — cheap, and only after a mark-as-seen.
      if (watched) void get().load();
    } catch {
      void get().load();
    }
  },

  dismissProgress: async (itemType, itemId) => {
    // duration zeroed to mirror the server's summary shaping: the Continue
    // Watching predicate (`duration > 0 && …`) is what actually hides the
    // entry, everywhere at once. Position is kept — resume still works.
    set(
      withDerived({
        progress: get().progress.map((p) => (p.itemType === itemType && p.itemId === itemId ? { ...p, dismissed: true, duration: 0 } : p)),
      }),
    );
    try {
      await api.post("/api/state", { kind: "dismissProgress", itemType, itemId });
    } catch {
      void get().load();
    }
  },
}));
