"use client";

// Navigation + transient UI state (active view, open detail modal, search
// query, toast). The video player itself lives in src/store/player.ts —
// every "Lecture" button calls usePlayerStore().open(...) directly rather
// than routing playback intent through this store.

import { create } from "zustand";

export type ViewId = "home" | "movies" | "shows" | "mylist" | "search" | "stats" | "settings" | "requests";

export interface DetailTarget {
  type: "movie" | "show";
  id: number;
}

interface UiState {
  view: ViewId;
  detail: DetailTarget | null;
  searchQuery: string;
  toast: string | null;
  navigate: (view: ViewId) => void;
  openDetail: (target: DetailTarget) => void;
  closeDetail: () => void;
  setSearchQuery: (query: string) => void;
  notify: (message: string) => void;
}

function syncViewToUrl(view: ViewId): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (view === "home") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

let toastTimer: number | null = null;

export const useUiStore = create<UiState>((set) => ({
  view: "home",
  detail: null,
  searchQuery: "",
  toast: null,

  navigate: (view) => {
    set({ view });
    syncViewToUrl(view);
  },
  openDetail: (target) => set({ detail: target }),
  closeDetail: () => set({ detail: null }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  notify: (message) => {
    set({ toast: message });
    if (typeof window === "undefined") return;
    // A replacing notify() restarts the clock — a message-equality guard
    // alone lets the FIRST timer cut a repeated identical toast short.
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastTimer = null;
      set({ toast: null });
    }, 3000);
  },
}));
