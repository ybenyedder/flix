"use client";

// Client state for the opt-in *arr integration: whether the feature is on (drives
// the Header entry, discover section and Home banner), the household's request
// list, and the mutations. All endpoints no-op gracefully when disabled.

import { create } from "zustand";
import { api, ApiError } from "@/lib/flix/api";
import type { ArrRequest, RequestLanguage, RequestQuality } from "@/lib/flix/types";

export interface ArrRequestInput {
  mediaType: "movie" | "show";
  tmdbId?: number;
  tvdbId?: number;
  /** Movies only: preferred audio language ("any" default). */
  language?: RequestLanguage;
  /** Movies only: preferred quality tier ("any" default). */
  quality?: RequestQuality;
}

interface ArrStatusResponse {
  enabled: boolean;
  dismissed?: boolean;
}

interface ArrState {
  enabled: boolean;
  /** Admin one-time banner dismissed (or feature enabled). Non-admins get true. */
  dismissed: boolean;
  loaded: boolean;
  requests: ArrRequest[];
  load: () => Promise<void>;
  refreshRequests: () => Promise<void>;
  request: (input: ArrRequestInput) => Promise<{ ok: boolean; error?: string }>;
  removeRequest: (id: number) => Promise<void>;
  dismissBanner: () => Promise<void>;
}

export const useArrStore = create<ArrState>((set, get) => ({
  enabled: false,
  dismissed: true,
  loaded: false,
  requests: [],

  load: async () => {
    try {
      const status = await api.get<ArrStatusResponse>("/api/arr/status");
      set({ enabled: status.enabled, dismissed: status.dismissed ?? true, loaded: true });
    } catch {
      set({ enabled: false, dismissed: true, loaded: true });
    }
  },

  refreshRequests: async () => {
    try {
      const data = await api.get<{ enabled: boolean; requests: ArrRequest[] }>("/api/arr/requests");
      set({ enabled: data.enabled, requests: data.requests ?? [] });
    } catch {
      /* keep the last known list on a transient error */
    }
  },

  request: async (input) => {
    try {
      await api.post<{ request: ArrRequest }>("/api/arr/requests", input);
      void get().refreshRequests();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof ApiError ? error.message : "Échec de la demande" };
    }
  },

  removeRequest: async (id) => {
    try {
      await api.del(`/api/arr/requests/${id}`);
    } catch {
      /* best-effort */
    }
    set({ requests: get().requests.filter((r) => r.id !== id) });
  },

  dismissBanner: async () => {
    set({ dismissed: true });
    try {
      await api.post("/api/admin/arr", { dismissed: true });
    } catch {
      /* the local flag already hid it for this session */
    }
  },
}));
