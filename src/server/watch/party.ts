// Watch-party ("Séance") room registry — in-memory, single-process, ephemeral.
// A room is a live screening, not durable data, so (like the scanner's progress
// subscribers and the playback ffmpeg sessions) it lives in a module-level Map
// rather than SQLite. The HTTP layer (src/app/api/watch/room/route.ts) owns the
// SSE plumbing and calls in here; this module owns the room state machine:
// membership + presence, host handover, the authoritative transport state, and
// broadcasting to every subscribed connection.
//
// Trust model: every entry point is called only after the route has
// authenticated the user (getRequestUser) and CSRF-checked mutations, exactly
// like every other route. Rooms are keyed by an unguessable code; membership is
// required to subscribe or send anything. Hard caps (rooms / members /
// connections) and an idle sweeper bound memory against abuse or leaks — the
// same discipline as /api/library/events' per-user stream cap.

import crypto from "crypto";
import { createLogger } from "../logger";
import type {
  PartyControlAction,
  PartyIdentity,
  PartyMember,
  PartyPlayback,
  PartyServerEvent,
  PartySnapshot,
  PartyTarget,
} from "@/lib/flix/party";
import { CODE_ALPHABET, CODE_LEN, normalizeRoomCode } from "@/lib/flix/party";

const log = createLogger("party");

// A household hosting a "cinema night" is a handful of people on a handful of
// devices — these ceilings are generous for that and hostile to anything else.
const MAX_ROOMS = 20;
const MAX_ROOMS_PER_HOST = 2; // MAX_ROOMS is global — without this, one user looping "create" starves everyone
const MAX_MEMBERS = 12;
const MAX_CONNECTIONS_PER_ROOM = 24; // several tabs/devices per member, bounded
const ROOM_TTL_MS = 8 * 60 * 60 * 1000; // absolute lifetime — a screening isn't a server
const IDLE_MS = 90 * 60 * 1000; // no activity → reclaimed
const PRESENCE_GRACE_MS = 45 * 1000; // an offline member survives a reload/blip this long
const EMPTY_GRACE_MS = 2 * 60 * 1000; // an emptied room lingers this long for a rejoin

const CHAT_MAX_LEN = 300;
const REACTION_MAX_LEN = 16;

interface Connection {
  connId: string;
  userId: number;
  send: (event: PartyServerEvent) => void;
}

interface Member extends PartyIdentity {
  joinedAt: number;
  connectionIds: Set<string>;
  /** Wall-clock ms when the member's last connection dropped (0 while online). */
  disconnectedAt: number;
}

interface Room {
  code: string;
  hostId: number;
  createdAt: number;
  lastActivity: number;
  members: Map<number, Member>;
  connections: Map<string, Connection>;
  playback: PartyPlayback;
}

const rooms = new Map<string, Room>();
let eventSeq = 0; // monotonic id for ephemeral reaction/chat events (no Date/random needed)

// --- code generation -------------------------------------------------------

// CODE_ALPHABET / CODE_LEN / normalizeRoomCode live in @/lib/flix/party so the
// client input filter and this server validator can't drift. 6 chars over 30
// symbols ≈ 7.3e8 space — unguessable for a LAN screening, re-rolled on the
// astronomically unlikely collision.
function generateCode(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const bytes = crypto.randomBytes(CODE_LEN);
    let code = "";
    for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error("could not allocate a unique room code");
}

/** Re-exported under the historical name for the route and tests; the actual
 *  implementation is shared with the client (see normalizeRoomCode). */
export const normalizeCode = normalizeRoomCode;

// --- serialization ---------------------------------------------------------

function memberView(m: Member, hostId: number): PartyMember {
  return { userId: m.userId, username: m.username, avatar: m.avatar, isHost: m.userId === hostId, online: m.connectionIds.size > 0 };
}

function snapshot(room: Room): PartySnapshot {
  const members = [...room.members.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((m) => memberView(m, room.hostId));
  return { code: room.code, hostId: room.hostId, members, playback: room.playback, serverNow: Date.now() };
}

function broadcast(room: Room, event: PartyServerEvent): void {
  for (const conn of room.connections.values()) {
    try {
      conn.send(event);
    } catch {
      /* a dead writer is reaped by its own stream teardown → unsubscribe */
    }
  }
}

function broadcastSnapshot(room: Room): void {
  broadcast(room, { t: "snapshot", room: snapshot(room) });
}

// --- lifecycle -------------------------------------------------------------

function touch(room: Room): void {
  room.lastActivity = Date.now();
}

function deleteRoom(room: Room, reason: string): void {
  broadcast(room, { t: "closed", reason });
  rooms.delete(room.code);
  log.info("room closed", { code: room.code, reason });
}

/** Promote the earliest-joined remaining member to host, or delete the room if
 *  none remain. Broadcasts the resulting snapshot. */
function reassignOrClose(room: Room): void {
  if (room.members.size === 0) {
    // Keep the (empty) room briefly so a lone member reloading can rejoin the
    // same code; the sweeper reclaims it after EMPTY_GRACE_MS.
    if (Date.now() - room.lastActivity > EMPTY_GRACE_MS) deleteRoom(room, "vide");
    return;
  }
  if (!room.members.has(room.hostId)) {
    const next = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    room.hostId = next.userId;
    log.info("host reassigned", { code: room.code, hostId: next.userId });
  }
  broadcastSnapshot(room);
}

// --- public API ------------------------------------------------------------

export type PartyResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

export function createRoom(host: PartyIdentity): PartyResult<{ code: string; snapshot: PartySnapshot }> {
  if (rooms.size >= MAX_ROOMS) return { ok: false, error: "Trop de séances en cours", status: 429 };
  let hosted = 0;
  for (const existing of rooms.values()) {
    if (existing.hostId === host.userId) hosted += 1;
  }
  if (hosted >= MAX_ROOMS_PER_HOST) {
    return { ok: false, error: "Vous animez déjà une séance — quittez-la d'abord", status: 429 };
  }
  const code = generateCode();
  const now = Date.now();
  const room: Room = {
    code,
    hostId: host.userId,
    createdAt: now,
    lastActivity: now,
    members: new Map(),
    connections: new Map(),
    playback: { target: null, paused: true, position: 0, updatedAt: now },
  };
  room.members.set(host.userId, { ...host, joinedAt: now, connectionIds: new Set(), disconnectedAt: 0 });
  rooms.set(code, room);
  startSweeper();
  log.info("room created", { code, hostId: host.userId });
  return { ok: true, value: { code, snapshot: snapshot(room) } };
}

export function joinRoom(code: string, user: PartyIdentity): PartyResult<{ snapshot: PartySnapshot }> {
  const room = rooms.get(code);
  if (!room) return { ok: false, error: "Séance introuvable ou terminée", status: 404 };
  const existing = room.members.get(user.userId);
  if (!existing && room.members.size >= MAX_MEMBERS) return { ok: false, error: "Cette séance est complète", status: 429 };
  if (existing) {
    // Rejoin (reload / second device): refresh identity, keep presence/host.
    existing.username = user.username;
    existing.avatar = user.avatar;
    existing.disconnectedAt = 0;
  } else {
    room.members.set(user.userId, { ...user, joinedAt: Date.now(), connectionIds: new Set(), disconnectedAt: 0 });
  }
  touch(room);
  broadcastSnapshot(room);
  return { ok: true, value: { snapshot: snapshot(room) } };
}

export function leaveRoom(code: string, userId: number): void {
  const room = rooms.get(code);
  if (!room) return;
  const member = room.members.get(userId);
  if (!member) return;
  // Tell this user's own tabs the séance ended for them, then drop them.
  for (const connId of member.connectionIds) {
    const conn = room.connections.get(connId);
    if (conn) {
      try {
        conn.send({ t: "closed", reason: "Vous avez quitté la séance" });
      } catch {
        /* stream already gone */
      }
      room.connections.delete(connId);
    }
  }
  room.members.delete(userId);
  touch(room);
  reassignOrClose(room);
}

/** Register an SSE connection for a member. Returns an unsubscribe callback the
 *  route calls on disconnect. Requires prior membership (create/join). */
export function subscribe(code: string, userId: number, connId: string, send: (event: PartyServerEvent) => void): PartyResult<{ initial: PartyServerEvent; unsubscribe: () => void }> {
  const room = rooms.get(code);
  if (!room) return { ok: false, error: "Séance introuvable", status: 404 };
  const member = room.members.get(userId);
  if (!member) return { ok: false, error: "Rejoignez d'abord la séance", status: 403 };
  if (room.connections.size >= MAX_CONNECTIONS_PER_ROOM) return { ok: false, error: "Trop de connexions sur cette séance", status: 429 };

  room.connections.set(connId, { connId, userId, send });
  member.connectionIds.add(connId);
  member.disconnectedAt = 0;
  touch(room);

  const initial: PartyServerEvent = { t: "snapshot", room: snapshot(room), you: userId };
  // Presence flipped to online → let the others know.
  broadcastSnapshot(room);

  const unsubscribe = () => {
    const r = rooms.get(code);
    if (!r) return;
    r.connections.delete(connId);
    const m = r.members.get(userId);
    if (m) {
      m.connectionIds.delete(connId);
      if (m.connectionIds.size === 0) m.disconnectedAt = Date.now();
    }
    touch(r);
    broadcastSnapshot(r);
  };

  return { ok: true, value: { initial, unsubscribe } };
}

function requireMember(code: string, userId: number): PartyResult<{ room: Room; member: Member }> {
  const room = rooms.get(code);
  if (!room) return { ok: false, error: "Séance introuvable", status: 404 };
  const member = room.members.get(userId);
  if (!member) return { ok: false, error: "Vous ne faites pas partie de cette séance", status: 403 };
  return { ok: true, value: { room, member } };
}

/** Apply a transport command from ANY member (shared remote). */
export function control(code: string, userId: number, action: PartyControlAction, position: number): PartyResult<null> {
  const found = requireMember(code, userId);
  if (!found.ok) return found;
  const { room, member } = found.value;
  const pos = Number.isFinite(position) && position >= 0 ? position : room.playback.position;
  const now = Date.now();
  const paused = action === "play" ? false : action === "pause" ? true : room.playback.paused;
  room.playback = { ...room.playback, paused, position: pos, updatedAt: now };
  touch(room);
  broadcast(room, { t: "control", playback: room.playback, by: member.username, action, serverNow: now });
  return { ok: true, value: null };
}

/** Change what the shared screen shows — HOST ONLY. Loads paused-or-playing at
 *  `startAt`; a null target means "back to the lobby" (host closed the player).
 *  autoplay defaults to true so a picked title starts for the room. */
export function setTarget(code: string, userId: number, target: PartyTarget | null, startAt = 0, autoplay = true): PartyResult<null> {
  const found = requireMember(code, userId);
  if (!found.ok) return found;
  const { room } = found.value;
  if (room.hostId !== userId) return { ok: false, error: "Seul l'hôte choisit le programme", status: 403 };
  const now = Date.now();
  room.playback = { target, paused: target ? !autoplay : true, position: target ? Math.max(0, startAt) : 0, updatedAt: now };
  touch(room);
  broadcastSnapshot(room);
  return { ok: true, value: null };
}

export function react(code: string, userId: number, emoji: string): PartyResult<null> {
  const found = requireMember(code, userId);
  if (!found.ok) return found;
  const { room, member } = found.value;
  const clean = emoji.trim().slice(0, REACTION_MAX_LEN);
  if (!clean) return { ok: false, error: "Réaction vide", status: 400 };
  touch(room);
  broadcast(room, { t: "reaction", id: ++eventSeq, emoji: clean, by: member.username });
  return { ok: true, value: null };
}

export function chat(code: string, userId: number, text: string): PartyResult<null> {
  const found = requireMember(code, userId);
  if (!found.ok) return found;
  const { room, member } = found.value;
  const clean = text.trim().slice(0, CHAT_MAX_LEN);
  if (!clean) return { ok: false, error: "Message vide", status: 400 };
  touch(room);
  broadcast(room, { t: "chat", id: ++eventSeq, by: member.username, avatar: member.avatar, text: clean, at: Date.now() });
  return { ok: true, value: null };
}

// --- sweeper ---------------------------------------------------------------

let sweeper: ReturnType<typeof setInterval> | null = null;

function sweep(): void {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    // Drop members who have been offline past the grace window (closed tab,
    // not an explicit leave) so ghosts don't linger in the presence list.
    let changed = false;
    for (const member of [...room.members.values()]) {
      if (member.connectionIds.size > 0) continue; // online — never reap
      // Two flavours of ghost, both bounded by PRESENCE_GRACE_MS:
      //  • was online, last connection dropped → measure from disconnectedAt.
      //  • joined (create/join) but never opened an SSE (disconnectedAt===0) →
      //    measure from joinedAt, otherwise the disconnectedAt>0 test could never
      //    fire and a join-only member would occupy a MAX_MEMBERS slot until the
      //    room TTL. Using joinedAt still gives a brand-new member the full grace
      //    window to complete the join→subscribe handshake before being reaped.
      const since = member.disconnectedAt > 0 ? member.disconnectedAt : member.joinedAt;
      if (now - since > PRESENCE_GRACE_MS) {
        room.members.delete(member.userId);
        changed = true;
      }
    }
    if (changed || room.members.size === 0) reassignOrClose(room);
    if (!rooms.has(room.code)) continue;
    if (now - room.createdAt > ROOM_TTL_MS || now - room.lastActivity > IDLE_MS) deleteRoom(room, "séance expirée");
  }
  if (rooms.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(sweep, 15 * 1000);
  // Never let the sweeper alone keep the process alive (matches the project's
  // "a timer is not a reason to stay up" posture).
  if (typeof sweeper.unref === "function") sweeper.unref();
}

// --- test hooks ------------------------------------------------------------

/** Test-only: wipe all rooms and stop the sweeper between cases. */
export function __resetPartyState(): void {
  rooms.clear();
  eventSeq = 0;
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/** Test-only: run one sweeper pass synchronously. */
export function __sweepNow(): void {
  sweep();
}

/** Test-only: read a room's live snapshot (or null). */
export function __peek(code: string): PartySnapshot | null {
  const room = rooms.get(code);
  return room ? snapshot(room) : null;
}
