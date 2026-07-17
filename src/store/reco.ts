"use client";

// Personalised Home feed (billboard + ranked rows + match-% map), backed by
// GET /api/recommend (src/app/api/recommend/route.ts -> src/server/reco/engine.ts).
// Same load/reset shape as the other per-session stores (library.ts, state.ts).

import { create } from "zustand";
import { api } from "@/lib/flix/api";
import type { RecoItemRef, RecoRow, RecommendResponse } from "@/lib/flix/types";

interface RecoState {
  loaded: boolean;
  billboard: RecoItemRef | null;
  rows: RecoRow[];
  matchScores: Record<string, number>;
  load: () => Promise<void>;
  reset: () => void;
  matchFor: (type: "movie" | "show", id: number) => number | null;
}

const EMPTY: RecommendResponse = { billboard: null, rows: [], matchScores: {} };

export const useRecoStore = create<RecoState>((set, get) => ({
  loaded: false,
  billboard: null,
  rows: [],
  matchScores: {},

  load: async () => {
    try {
      const data = await api.get<RecommendResponse>("/api/recommend");
      set({ loaded: true, billboard: data.billboard, rows: data.rows, matchScores: data.matchScores });
    } catch {
      set({ loaded: true, ...EMPTY });
    }
  },

  reset: () => set({ loaded: false, ...EMPTY }),

  matchFor: (type, id) => get().matchScores[`${type}:${id}`] ?? null,
}));
