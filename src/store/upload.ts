"use client";

// Client queue for admin drag-and-drop uploads. Bridges three things: the
// chunk engine (src/lib/flix/uploadClient), the existing library scan SSE
// (useLibraryStore.watchScan, fired once a file finalizes), and the dock UI.
// AbortControllers and post-finalize timers live in module scope — they aren't
// serialisable and must not sit in zustand state.

import { create } from "zustand";
import { fetchCapability, initUpload, sendChunks, finalizeUpload, abortUpload, fetchResume, type ResumableSession } from "@/lib/flix/uploadClient";
import { guessDestination, buildEpisodeFilename, fileExt, type UploadDestination } from "@/lib/flix/naming";
import { useLibraryStore } from "@/store/library";
import { VIDEO_EXTENSIONS } from "@/lib/flix/videoFormats";

const MAX_ACTIVE = 2;
const INDEX_TIMEOUT_MS = 120_000;

export type UploadStatus = "pending-destination" | "queued" | "uploading" | "paused" | "finalizing" | "indexing" | "done" | "error" | "orphan";

export interface UploadItem {
  id: string;
  file: File | null;
  /** Filename Flix will store (episodes may be rewritten to embed SxxEyy). */
  filename: string;
  originalName: string;
  size: number;
  destination: UploadDestination | null;
  episode: number | null;
  uploadId: string | null;
  received: number;
  bytesPerSec: number | null;
  status: UploadStatus;
  error: string | null;
  note: string | null;
  targetRel: string | null;
  libraryLink: { type: "movie" | "show"; id: number } | null;
}

interface UploadState {
  supported: boolean;
  writable: boolean;
  freeBytes: number | null;
  chunkSize: number;
  capabilityLoaded: boolean;
  capabilityError: string | null;
  dragActive: boolean;
  items: UploadItem[];
  dockCollapsed: boolean;

  loadCapability: () => Promise<void>;
  setDragActive: (active: boolean) => void;
  setDockCollapsed: (collapsed: boolean) => void;
  enqueue: (files: File[]) => void;
  setDestination: (id: string, destination: UploadDestination, episode: number | null) => void;
  start: (id: string) => void;
  pause: (id: string) => void;
  resume: (id: string) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
}

const controllers = new Map<string, AbortController>();
const indexTimers = new Map<string, ReturnType<typeof setTimeout>>();
let librarySubscribed = false;

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `u_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.includes(fileExt(name));
}

function normalize(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Outgoing filename for the current destination (episodes get SxxEyy embedded). */
function outgoingFilename(item: UploadItem): string {
  if (item.destination?.kind === "episode" && item.episode !== null) {
    return buildEpisodeFilename(item.originalName, item.destination.season, item.episode);
  }
  const movieExt = fileExt(item.originalName);
  return item.originalName || `film${movieExt}`;
}

export const useUploadStore = create<UploadState>((set, get) => {
  // Promote queued items into free upload slots whenever the active count drops.
  // `controllers` is registered synchronously at the top of run(), so its size
  // is the authoritative in-flight count (status lags behind the init round-trip).
  function schedule(): void {
    if (controllers.size >= MAX_ACTIVE) return;
    const next = get().items.find((it) => it.status === "queued" && !controllers.has(it.id));
    if (next) void run(next.id);
  }

  function patch(id: string, changes: Partial<UploadItem>): void {
    set((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, ...changes } : it)) }));
  }

  function get1(id: string): UploadItem | undefined {
    return get().items.find((it) => it.id === id);
  }

  // A single subscription watches the catalogue: when a scan lands new titles,
  // link any item stuck in "indexing" to its fresh library id.
  function ensureLibrarySubscription(): void {
    if (librarySubscribed) return;
    librarySubscribed = true;
    useLibraryStore.subscribe(() => matchIndexingItems());
  }

  function matchIndexingItems(): void {
    const { items } = get();
    if (!items.some((it) => it.status === "indexing")) return;
    const { movies, shows } = useLibraryStore.getState();
    for (const it of items) {
      if (it.status !== "indexing" || !it.destination) continue;
      const wantTitle = normalize(it.destination.kind === "movie" ? it.destination.title : it.destination.show);
      const wantYear = it.destination.kind === "movie" ? it.destination.year : it.destination.showYear;
      const pool = it.destination.kind === "movie" ? movies : shows;
      const hit = pool.find((m) => normalize(m.title) === wantTitle && (wantYear === null || m.year === null || m.year === wantYear));
      if (hit) {
        const timer = indexTimers.get(it.id);
        if (timer) {
          clearTimeout(timer);
          indexTimers.delete(it.id);
        }
        patch(it.id, { status: "done", libraryLink: { type: it.destination.kind === "movie" ? "movie" : "show", id: hit.id }, note: null });
      }
    }
  }

  async function run(id: string): Promise<void> {
    const item = get1(id);
    // A fresh upload needs a destination to init; a resume (uploadId already
    // set server-side) keeps the original target, so destination is optional.
    if (!item || (!item.destination && !item.uploadId)) return;

    const controller = new AbortController();
    controllers.set(id, controller);

    try {
      // Init the server session if this is a fresh start (resume keeps uploadId).
      let uploadId = item.uploadId;
      let chunkSize = get().chunkSize;
      let startOffset = item.received;
      if (!uploadId) {
        // The guard above guarantees a destination on the fresh-init path.
        if (!item.destination) return;
        const filename = outgoingFilename(item);
        const init = await initUpload({ filename, size: item.size, destination: item.destination });
        uploadId = init.uploadId;
        chunkSize = init.chunkSize;
        startOffset = init.received;
        patch(id, { uploadId, filename, targetRel: init.targetRel, received: init.received });
      } else {
        // Resuming: reconcile our offset with the server's authoritative count.
        try {
          const resume = await fetchResume(uploadId);
          startOffset = resume.received;
          patch(id, { received: resume.received, targetRel: resume.targetRel });
        } catch {
          /* server forgot the session — sendChunks will 404 and surface the error */
        }
      }

      if (!uploadId) throw new Error("Session de téléversement introuvable.");
      patch(id, { status: "uploading", error: null });

      if (!item.file) throw new Error("Fichier indisponible — redéposez-le pour reprendre.");

      await sendChunks({
        uploadId,
        file: item.file,
        chunkSize,
        startOffset,
        signal: controller.signal,
        onProgress: ({ received, bytesPerSec }) => patch(id, { received, bytesPerSec }),
      });

      patch(id, { status: "finalizing" });
      await finalizeUpload(uploadId);

      // File is on disk. Kick the scan and wait for the title to surface.
      patch(id, { status: "indexing", received: item.size });
      ensureLibrarySubscription();
      useLibraryStore.getState().watchScan();
      const timer = setTimeout(() => {
        indexTimers.delete(id);
        const cur = get1(id);
        if (cur?.status === "indexing") {
          patch(id, { status: "done", note: "Fichier ajouté. S'il n'apparaît pas, vérifiez le nommage." });
        }
      }, INDEX_TIMEOUT_MS);
      indexTimers.set(id, timer);
      matchIndexingItems();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Paused/cancelled — pause() and cancel() own the resulting status.
        return;
      }
      const message = err instanceof Error ? err.message : "Échec du téléversement";
      patch(id, { status: "error", error: message });
    } finally {
      controllers.delete(id);
      schedule();
    }
  }

  return {
    supported: false,
    writable: false,
    freeBytes: null,
    chunkSize: 64 * 1024 * 1024,
    capabilityLoaded: false,
    capabilityError: null,
    dragActive: false,
    items: [],
    dockCollapsed: false,

    loadCapability: async () => {
      try {
        const cap = await fetchCapability();
        set({
          supported: true,
          writable: cap.writable,
          freeBytes: cap.freeBytes,
          chunkSize: cap.chunkSize,
          capabilityLoaded: true,
          capabilityError: null,
        });
        // Surface any server-side sessions orphaned by a page reload as
        // interrupted items the admin can resume by re-dropping the file.
        const orphans: ResumableSession[] = cap.sessions ?? [];
        if (orphans.length) {
          set((s) => {
            const known = new Set(s.items.map((it) => it.uploadId).filter(Boolean));
            const add = orphans
              .filter((o) => !known.has(o.uploadId))
              .map<UploadItem>((o) => ({
                id: uuid(),
                file: null,
                filename: o.filename,
                originalName: o.filename,
                size: o.size,
                destination: null,
                episode: null,
                uploadId: o.uploadId,
                received: o.received,
                bytesPerSec: null,
                status: "orphan",
                error: null,
                note: "Interrompu — redéposez le fichier pour reprendre.",
                targetRel: o.targetRel,
                libraryLink: null,
              }));
            return { items: [...s.items, ...add] };
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Statut du téléversement indisponible";
        set({ supported: false, capabilityLoaded: true, capabilityError: message });
      }
    },

    setDragActive: (active) => set({ dragActive: active }),
    setDockCollapsed: (collapsed) => set({ dockCollapsed: collapsed }),

    enqueue: (files) => {
      const videos = files.filter((f) => isVideoFile(f.name));
      if (!videos.length) return;
      const orphans = get().items.filter((it) => it.status === "orphan");
      const additions: UploadItem[] = [];
      for (const file of videos) {
        // A re-dropped file matching an orphan (name+size) resumes that session
        // straight away — the destination was fixed server-side at the original
        // init, so there's nothing to re-pick.
        const match = orphans.find((o) => o.originalName === file.name && o.size === file.size);
        if (match) {
          patch(match.id, { file, status: "queued", note: null });
          if (controllers.size < MAX_ACTIVE) void run(match.id);
          continue;
        }
        const guess = guessDestination(file.name);
        additions.push({
          id: uuid(),
          file,
          filename: file.name,
          originalName: file.name,
          size: file.size,
          destination: guess.destination,
          episode: guess.episode,
          uploadId: null,
          received: 0,
          bytesPerSec: null,
          status: "pending-destination",
          error: null,
          note: null,
          targetRel: null,
          libraryLink: null,
        });
      }
      if (additions.length) set((s) => ({ items: [...additions, ...s.items], dockCollapsed: false }));
    },

    setDestination: (id, destination, episode) => patch(id, { destination, episode }),

    start: (id) => {
      const item = get1(id);
      if (!item || !item.destination) return;
      patch(id, { status: "queued", error: null });
      if (controllers.size < MAX_ACTIVE) void run(id);
    },

    pause: (id) => {
      controllers.get(id)?.abort();
      controllers.delete(id);
      patch(id, { status: "paused" });
      schedule();
    },

    resume: (id) => {
      const item = get1(id);
      if (!item) return;
      patch(id, { status: "queued", error: null });
      if (controllers.size < MAX_ACTIVE) void run(id);
    },

    cancel: (id) => {
      controllers.get(id)?.abort();
      controllers.delete(id);
      const timer = indexTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        indexTimers.delete(id);
      }
      const item = get1(id);
      if (item?.uploadId) void abortUpload(item.uploadId);
      set((s) => ({ items: s.items.filter((it) => it.id !== id) }));
      schedule();
    },

    retry: (id) => {
      patch(id, { status: "queued", error: null });
      if (controllers.size < MAX_ACTIVE) void run(id);
    },

    dismiss: (id) => {
      const timer = indexTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        indexTimers.delete(id);
      }
      set((s) => ({ items: s.items.filter((it) => it.id !== id) }));
    },
  };
});
