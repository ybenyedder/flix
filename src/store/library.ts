"use client";

// The shared, user-independent catalogue snapshot (GET /api/library), plus
// live scan progress via SSE while a scan is running. See
// src/server/library/repository.ts for why this snapshot is identical for
// every profile — kids filtering happens client-side (useCatalog.ts).

import { create } from "zustand";
import { api } from "@/lib/flix/api";
import type { CatalogSnapshot, Movie, Show, ScanProgress } from "@/lib/flix/types";

interface LibraryState {
  status: "idle" | "loading" | "ready" | "error";
  movies: Movie[];
  shows: Show[];
  mediaDir: string;
  scannedAt: string | null;
  scan: ScanProgress | null;
  error: string | null;
  /** `silent` refreshes the catalogue in place — no "loading" flip (so HomeView
   *  keeps the current content instead of flashing skeletons) and no error
   *  screen on a transient failure. Used by the SSE-driven reloads (scan end,
   *  progressive poster reveal); the foreground page-mount load stays noisy. */
  load: (opts?: { silent?: boolean }) => Promise<void>;
  watchScan: () => void;
  rescan: () => Promise<void>;
}

let sse: EventSource | null = null;

// Monotonic load token: silent reveals don't flip `status` to "loading", so the
// loading guard can't serialise them — several can be in flight at once. Each
// load captures the current token and only commits its result if still the
// latest, so an older (partial) snapshot response can't overwrite a newer one
// after an out-of-order network delivery.
let loadSeq = 0;

// How many freshly-imaged files to wait between mid-pass catalogue refreshes,
// so a big import reveals posters in waves. Matches imagesPass.ts's REVEAL_BATCH
// (the server bumps the catalogue version on the same cadence, so the reload
// actually pulls newer posters instead of a still-cached snapshot).
const REVEAL_EVERY = 24;

export const useLibraryStore = create<LibraryState>((set, get) => ({
  status: "idle",
  movies: [],
  shows: [],
  mediaDir: "",
  scannedAt: null,
  scan: null,
  error: null,

  load: async (opts) => {
    const silent = opts?.silent ?? false;
    if (get().status === "loading") return;
    if (!silent) set({ status: "loading", error: null });
    const seq = ++loadSeq;
    try {
      const snapshot = await api.getCached<CatalogSnapshot>("/api/library");
      if (seq !== loadSeq) return; // superseded by a newer load — drop this stale response
      set({
        status: "ready",
        movies: snapshot.movies,
        shows: snapshot.shows,
        mediaDir: snapshot.mediaDir,
        scannedAt: snapshot.scannedAt,
        scan: snapshot.scan,
      });
      // Re-watch while the background image pass is still running too (not just
      // during the scan itself): a page load landing mid-`imaging` must follow
      // the channel to its end, otherwise the posters that land moments later
      // only surface on a manual reload.
      if (snapshot.scan?.status === "scanning" || snapshot.scan?.imaging) get().watchScan();
    } catch (error) {
      // A silent refresh keeps the current content on a transient failure rather
      // than blanking to an error screen; only a foreground load surfaces it.
      if (seq === loadSeq && !silent) set({ status: "error", error: error instanceof Error ? error.message : "Bibliothèque indisponible" });
    }
  },

  watchScan: () => {
    if (typeof window === "undefined" || sse) return;
    const source = new EventSource("/api/library/events");
    sse = source;
    let revealedAt = 0; // last `imaged` count we refreshed the catalogue at
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ScanProgress;
        set({ scan: data });
        if (data.status !== "scanning" && !data.imaging) {
          source.close();
          sse = null;
          void get().load({ silent: true });
        } else if (data.imaging && data.imaged - revealedAt >= REVEAL_EVERY) {
          // Progressive reveal during a long image pass: refresh the catalogue
          // so posters extracted so far appear without waiting for the whole
          // pass. Cards reconcile by key, so this updates image srcs in place
          // (no remount). load() keeps the SSE open (its watchScan() is a no-op
          // while `sse` is set); overlapping silent reloads can't clobber each
          // other out of order thanks to load()'s `loadSeq` token.
          revealedAt = data.imaged;
          void get().load({ silent: true });
        }
      } catch {
        /* ignore malformed/keepalive payloads */
      }
    };
    source.onerror = () => {
      // CONNECTING → the browser is auto-retrying on its own; only a CLOSED
      // source is gone for good. Then resync via load() after a delay — it
      // re-watches if a scan is still running — otherwise the UI would stay
      // stuck on « Analyse en cours… ».
      if (source.readyState !== EventSource.CLOSED) return;
      source.close();
      sse = null;
      window.setTimeout(() => {
        if (!sse) void get().load({ silent: true });
      }, 5000);
    };
  },

  rescan: async () => {
    await api.post("/api/library/scan", {});
    get().watchScan();
  },
}));
