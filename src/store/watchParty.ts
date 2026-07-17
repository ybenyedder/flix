"use client";

// Watch-party ("Séance") client store. Owns the live SSE connection to
// /api/watch/room, sends every command through the shared api client, and holds
// the room state the UI + PlayerView render from.
//
// Two roles fall out of hostId === youId:
//  • HOST  — picks what plays. PlayerView pushes its resolved item as the room
//            target (setTarget); the store never opens the player for the host.
//  • GUEST — follows. The store opens the player on the host's target (and
//            re-opens on a NEW title), closes it when the host returns to the
//            lobby, and a "Rejoindre l'écran" action re-syncs after a manual
//            close. Guests never push a target.
// Transport (play/pause/seek) is a SHARED remote: any member's command updates
// the authoritative server state and every client's PlayerView reconciles to it
// (see the sync effect in PlayerView + computeLivePosition in lib/flix/party).

import { create } from "zustand";
import { api, ApiError } from "@/lib/flix/api";
import { usePlayerStore } from "@/store/player";
import {
  computeLivePosition,
  targetMatches,
  type PartyControlAction,
  type PartyMember,
  type PartyPlayback,
  type PartyServerEvent,
  type PartySnapshot,
  type PartyTarget,
} from "@/lib/flix/party";

const CODE_STORAGE_KEY = "flix.party.code";
const MAX_CHAT = 60;
/** How long a chat message floats over the player before fading. */
const CHAT_FLOAT_MS = 6000;

export interface PartyReaction {
  id: number;
  emoji: string;
  by: string;
}
export interface PartyChatMessage {
  id: number;
  by: string;
  avatar: string;
  text: string;
  at: number;
}

interface WatchPartyState {
  active: boolean;
  connecting: boolean;
  connected: boolean;
  code: string | null;
  youId: number | null;
  hostId: number | null;
  members: PartyMember[];
  playback: PartyPlayback;
  /** serverNow − Date.now() at the last message; add to Date.now() for a
   *  server-aligned clock when reconstructing the live position. */
  clockOffset: number;
  reactions: PartyReaction[];
  chat: PartyChatMessage[];
  /** Recently-received messages that briefly float over the player (Twitch
   *  style), in addition to living permanently in `chat`. Auto-expired. */
  floatingChat: PartyChatMessage[];
  error: string | null;

  isHost: () => boolean;
  /** Live shared media position (s) right now, or null when nothing is loaded. */
  livePosition: () => number | null;

  create: () => Promise<{ ok: boolean; error?: string }>;
  join: (code: string) => Promise<{ ok: boolean; error?: string }>;
  leave: () => Promise<void>;
  restore: () => void;
  rejoinScreen: () => void;

  sendControl: (action: PartyControlAction, position: number) => void;
  pushTarget: (target: PartyTarget | null, startAt?: number, autoplay?: boolean) => void;
  react: (emoji: string) => void;
  sendChat: (text: string) => void;
}

const EMPTY_PLAYBACK: PartyPlayback = { target: null, paused: true, position: 0, updatedAt: 0 };

let source: EventSource | null = null;
let connId = "";
// Re-join scheduling for a dead SSE (readyState CLOSED): the browser only
// auto-retries while CONNECTING, so an expired token (401) or a persistent
// 5xx would otherwise leave the séance active-but-deaf forever.
let rejoinTimer: number | null = null;
let rejoinAttempt = 0;
const REJOIN_BACKOFF_MS = [2000, 5000, 10000, 15000];
// The last target the store auto-opened for a guest, so a plain transport
// command (control event) doesn't reopen a title the guest deliberately closed —
// only a genuinely NEW pick re-triggers auto-follow.
let lastFollowedKey: string | null = null;

function targetKey(t: PartyTarget | null): string | null {
  if (!t) return null;
  return t.mediaFileId !== undefined ? `f${t.mediaFileId}` : `${t.kind}:${t.id}`;
}

function newConnId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `c-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function persistCode(code: string | null): void {
  try {
    if (code) window.localStorage.setItem(CODE_STORAGE_KEY, code);
    else window.localStorage.removeItem(CODE_STORAGE_KEY);
  } catch {
    /* storage unavailable — party just won't survive a reload */
  }
}

export const useWatchPartyStore = create<WatchPartyState>((set, get) => {
  function openPlayerFor(playback: PartyPlayback): void {
    const target = playback.target;
    const cur = usePlayerStore.getState().request;
    if (!target) {
      // Host went back to the lobby → close a party-driven player.
      if (cur?.fromParty) usePlayerStore.getState().close();
      lastFollowedKey = null;
      return;
    }
    if (targetMatches(target, cur ? { kind: cur.kind, id: cur.id, mediaFileId: cur.mediaFileId } : null)) return;
    const startAt = get().livePosition() ?? playback.position;
    usePlayerStore.getState().open({
      kind: target.kind,
      id: target.id,
      topId: target.topId,
      mediaFileId: target.mediaFileId,
      title: target.title,
      startAt,
      fromParty: true,
    });
  }

  function applySnapshot(room: PartySnapshot, you?: number): void {
    const prevKey = targetKey(get().playback.target);
    set({
      code: room.code,
      hostId: room.hostId,
      members: room.members,
      playback: room.playback,
      clockOffset: room.serverNow - Date.now(),
      youId: you ?? get().youId,
      active: true,
      error: null,
    });
    // Guests auto-follow a NEW title (target key changed) — not a mere presence
    // update. The host drives their own player, so never open for them here.
    const youId = you ?? get().youId;
    const isHost = youId != null && youId === room.hostId;
    const nextKey = targetKey(room.playback.target);
    if (!isHost && nextKey !== prevKey && nextKey !== lastFollowedKey) {
      lastFollowedKey = nextKey;
      openPlayerFor(room.playback);
    } else if (!room.playback.target && !isHost) {
      openPlayerFor(room.playback); // close on return-to-lobby
    }
  }

  function handleEvent(ev: PartyServerEvent): void {
    switch (ev.t) {
      case "snapshot":
        applySnapshot(ev.room, ev.you);
        break;
      case "control":
        set({ playback: ev.playback, clockOffset: ev.serverNow - Date.now() });
        break;
      case "reaction": {
        const reaction = { id: ev.id, emoji: ev.emoji, by: ev.by };
        set((s) => ({ reactions: [...s.reactions, reaction] }));
        window.setTimeout(() => set((s) => ({ reactions: s.reactions.filter((r) => r.id !== reaction.id) })), 4500);
        break;
      }
      case "chat": {
        const message = { id: ev.id, by: ev.by, avatar: ev.avatar, text: ev.text, at: ev.at };
        // Persist in the drawer's history AND pop a floating bubble over the
        // player so nobody has to open the chat to see it.
        set((s) => ({ chat: [...s.chat, message].slice(-MAX_CHAT), floatingChat: [...s.floatingChat, message] }));
        window.setTimeout(() => set((s) => ({ floatingChat: s.floatingChat.filter((m) => m.id !== message.id) })), CHAT_FLOAT_MS);
        break;
      }
      case "closed":
        teardown(ev.reason);
        break;
    }
  }

  function clearRejoinTimer(): void {
    if (rejoinTimer !== null) {
      window.clearTimeout(rejoinTimer);
      rejoinTimer = null;
    }
  }

  // Once the SSE is CLOSED it never comes back on its own — retry the join
  // with growing backoff: a successful join returns a full snapshot AND
  // reopens the SSE with a fresh token. Cancelled by teardown() if the user
  // leaves the séance in the meantime.
  function scheduleRejoin(): void {
    if (rejoinTimer !== null) return;
    const delay = REJOIN_BACKOFF_MS[Math.min(rejoinAttempt, REJOIN_BACKOFF_MS.length - 1)];
    rejoinAttempt += 1;
    rejoinTimer = window.setTimeout(() => {
      rejoinTimer = null;
      const { active, code } = get();
      if (!active || !code) return;
      void enter("join", code).then((res) => {
        if (!res.ok && get().active) scheduleRejoin();
      });
    }, delay);
  }

  function connectSse(code: string): void {
    if (typeof window === "undefined") return;
    clearRejoinTimer();
    if (source) {
      source.close();
      source = null;
    }
    connId = newConnId();
    const token = api.token();
    const url = `/api/watch/room?code=${encodeURIComponent(code)}&conn=${encodeURIComponent(connId)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url, { withCredentials: true });
    source = es;
    set({ connecting: true });
    es.onopen = () => {
      rejoinAttempt = 0;
      set({ connecting: false, connected: true });
    };
    es.onmessage = (event) => {
      try {
        handleEvent(JSON.parse(event.data) as PartyServerEvent);
      } catch {
        /* keepalive / malformed — ignore */
      }
    };
    es.onerror = () => {
      // readyState CONNECTING → the browser is auto-retrying (leave it);
      // CLOSED → it gave up for good, schedule a backed-off re-join.
      if (es.readyState === EventSource.CLOSED) {
        set({ connected: false, connecting: false });
        if (get().active) scheduleRejoin();
      } else set({ connected: false });
    };
  }

  function teardown(reason?: string): void {
    clearRejoinTimer();
    rejoinAttempt = 0;
    if (source) {
      source.close();
      source = null;
    }
    lastFollowedKey = null;
    persistCode(null);
    // Close a party-driven player so a guest isn't left on a frozen frame.
    const cur = usePlayerStore.getState().request;
    if (cur?.fromParty) usePlayerStore.getState().close();
    set({
      active: false,
      connecting: false,
      connected: false,
      code: null,
      hostId: null,
      members: [],
      playback: EMPTY_PLAYBACK,
      reactions: [],
      chat: [],
      floatingChat: [],
      error: reason ?? null,
    });
  }

  async function enter(action: "create" | "join", code?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await api.post<{ ok: boolean; code: string; youId: number; snapshot: PartySnapshot }>("/api/watch/room", {
        action,
        code,
      });
      lastFollowedKey = null;
      // A transport-level reconnect re-enters through enter("join", sameCode)
      // (see scheduleRejoin, fired when the SSE dies): keep the accumulated
      // chat/reaction history in that case so a network blip doesn't wipe the
      // conversation. Only a fresh create/join into a different room starts the
      // history clean; an explicit leave/close already wipes it via teardown().
      const reconnecting = action === "join" && get().active && get().code === code;
      set({
        youId: res.youId,
        error: null,
        ...(reconnecting ? {} : { chat: [], reactions: [], floatingChat: [] }),
      });
      applySnapshot(res.snapshot, res.youId);
      persistCode(res.code);
      connectSse(res.code);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Séance indisponible";
      // Forget the persisted code only on a definitive application error
      // (room gone/forbidden). A network hiccup or 5xx must keep it so
      // restore() / the rejoin backoff can retry; 401 is a session matter,
      // not the room's.
      const definitive = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401;
      if (action === "join" && definitive) persistCode(null);
      return { ok: false, error: message };
    }
  }

  return {
    active: false,
    connecting: false,
    connected: false,
    code: null,
    youId: null,
    hostId: null,
    members: [],
    playback: EMPTY_PLAYBACK,
    clockOffset: 0,
    reactions: [],
    chat: [],
    floatingChat: [],
    error: null,

    isHost: () => {
      const { youId, hostId } = get();
      return youId != null && youId === hostId;
    },
    livePosition: () => {
      const { playback, clockOffset } = get();
      if (!playback.target) return null;
      return computeLivePosition(playback, Date.now() + clockOffset);
    },

    create: () => enter("create"),
    join: (code) => enter("join", code),

    leave: async () => {
      const code = get().code;
      teardown();
      if (code) {
        try {
          await api.post("/api/watch/room", { action: "leave", code });
        } catch {
          /* best-effort */
        }
      }
    },

    restore: () => {
      if (typeof window === "undefined" || get().active) return;
      let code: string | null = null;
      try {
        code = window.localStorage.getItem(CODE_STORAGE_KEY);
      } catch {
        code = null;
      }
      if (code) void enter("join", code);
    },

    rejoinScreen: () => {
      openPlayerFor(get().playback);
    },

    sendControl: (action, position) => {
      const code = get().code;
      if (!code) return;
      void api.post("/api/watch/room", { action: "control", code, controlAction: action, position }).catch(() => {});
    },

    pushTarget: (target, startAt = 0, autoplay = true) => {
      const code = get().code;
      if (!code || !get().isHost()) return;
      void api.post("/api/watch/room", { action: "target", code, target, startAt, autoplay }).catch(() => {});
    },

    react: (emoji) => {
      const code = get().code;
      if (!code) return;
      void api.post("/api/watch/room", { action: "reaction", code, emoji }).catch(() => {});
    },

    sendChat: (text) => {
      const code = get().code;
      const clean = text.trim();
      if (!code || !clean) return;
      void api.post("/api/watch/room", { action: "chat", code, text: clean }).catch(() => {});
    },
  };
});
