"use client";

// Current-session profile state: who is logged in, their avatar/kids flag,
// and the list of selectable profiles for the "Qui regarde ?" screen. Backed
// by /api/auth/status (session probe) and /api/auth/accounts (public profile
// list) — see src/app/api/auth/{status,accounts,login,logout}/route.ts.

import { create } from "zustand";
import { api, ApiError } from "@/lib/flix/api";

export interface ProfileSummary {
  username: string;
  avatar: string;
  isKids: boolean;
}

interface AuthStatusResponse {
  authenticated: boolean;
  username: string | null;
  avatar: string | null;
  isAdmin: boolean;
  isKids: boolean;
  defaultPassword: boolean;
  token: string | null;
}

interface LoginResponse {
  ok: boolean;
  username: string;
  avatar: string;
  isAdmin: boolean;
  isKids: boolean;
  defaultPassword: boolean;
  token?: string;
}

interface ProfileState {
  ready: boolean;
  authenticated: boolean;
  username: string | null;
  avatar: string | null;
  isAdmin: boolean;
  isKids: boolean;
  defaultPassword: boolean;
  profiles: ProfileSummary[];
  profilesLoaded: boolean;
  checkStatus: () => Promise<void>;
  loadProfiles: () => Promise<void>;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
}

export const useProfileStore = create<ProfileState>((set) => ({
  ready: false,
  authenticated: false,
  username: null,
  avatar: null,
  isAdmin: false,
  isKids: false,
  defaultPassword: false,
  profiles: [],
  profilesLoaded: false,

  checkStatus: async () => {
    try {
      const status = await api.get<AuthStatusResponse>("/api/auth/status");
      if (status.authenticated && status.token) api.setToken(status.token);
      set({
        ready: true,
        authenticated: status.authenticated,
        username: status.username,
        avatar: status.avatar,
        isAdmin: status.isAdmin,
        isKids: status.isKids,
        defaultPassword: status.defaultPassword,
      });
    } catch {
      set({ ready: true, authenticated: false });
    }
  },

  loadProfiles: async () => {
    try {
      const data = await api.get<{ profiles: ProfileSummary[] }>("/api/auth/accounts");
      set({ profiles: data.profiles ?? [], profilesLoaded: true });
    } catch {
      set({ profiles: [], profilesLoaded: true });
    }
  },

  login: async (username, password) => {
    try {
      const res = await api.post<LoginResponse>("/api/auth/login", { username, password });
      if (res.token) api.setToken(res.token);
      set({
        authenticated: true,
        username: res.username,
        avatar: res.avatar,
        isAdmin: res.isAdmin,
        isKids: res.isKids,
        defaultPassword: res.defaultPassword,
      });
      return { ok: true };
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Serveur injoignable";
      return { ok: false, error: message };
    }
  },

  logout: async () => {
    try {
      await api.post("/api/auth/logout");
    } catch {
      /* best-effort — drop client-side state regardless */
    }
    api.setToken(null);
    set({ authenticated: false, username: null, avatar: null, isAdmin: false, isKids: false, defaultPassword: false });
  },
}));
