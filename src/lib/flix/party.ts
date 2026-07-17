// Watch-party ("Séance") wire protocol + pure sync helpers, shared by the
// client store/components, the server room registry (src/server/watch/party.ts)
// and the test suite. Deliberately dependency-free and side-effect-free so both
// sides import the same shapes and the sync maths is unit-testable in isolation.
//
// Model: one room = one shared "screen". The HOST picks what plays (the target);
// EVERY member can drive transport (play / pause / seek) — a shared remote, like
// pausing a film for the whole living room. Playback is kept authoritative on
// the server as {paused, position@updatedAt}; each client reconstructs the live
// position from its own clock, offset against the server clock carried on every
// message, and hard-corrects its <video> when it drifts past a threshold.

/** What the shared screen is currently showing. Always the RESOLVED item the
 *  host is playing (never kind:"show" — the host pushes the concrete episode +
 *  media file so every guest loads the byte-identical file, preserving the
 *  direct>remux>transcode guarantee per client). */
export interface PartyTarget {
  kind: "movie" | "episode";
  id: number;
  topId?: number;
  mediaFileId?: number;
  title?: string;
  subtitle?: string | null;
}

/** Authoritative transport state. `position` is the media offset (seconds)
 *  captured at `updatedAt` (server clock, ms). While playing it advances with
 *  wall-clock; while paused it is frozen. */
export interface PartyPlayback {
  target: PartyTarget | null;
  paused: boolean;
  position: number;
  updatedAt: number;
}

export interface PartyMember {
  userId: number;
  username: string;
  avatar: string;
  isHost: boolean;
  /** False while the member has no live SSE connection (reloading / brief drop). */
  online: boolean;
}

export interface PartySnapshot {
  code: string;
  hostId: number;
  members: PartyMember[];
  playback: PartyPlayback;
  /** Server clock (ms) at send time — clients derive their clock offset from it. */
  serverNow: number;
}

export type PartyControlAction = "play" | "pause" | "seek";

/** Server → client events, one per SSE `data:` line. `snapshot` on join /
 *  membership / target changes; `control` on transport; the rest are ephemeral. */
export type PartyServerEvent =
  | { t: "snapshot"; room: PartySnapshot; you?: number }
  | { t: "control"; playback: PartyPlayback; by: string; action: PartyControlAction; serverNow: number }
  | { t: "reaction"; id: number; emoji: string; by: string }
  | { t: "chat"; id: number; by: string; avatar: string; text: string; at: number }
  | { t: "closed"; reason: string };

/** Small pieces of a member identity the server needs to render presence. */
export interface PartyIdentity {
  userId: number;
  username: string;
  avatar: string;
}

// --- sync maths (pure) -----------------------------------------------------

/** Hard-correct the local <video> when it drifts past this many seconds from
 *  the shared position. Loose enough to tolerate LAN clock skew + decode jitter
 *  without constant re-seeking, tight enough that nobody is visibly out of
 *  sync. */
export const PARTY_SYNC_THRESHOLD_S = 1.5;

/** The shared media position implied by a playback state at a given
 *  server-aligned instant. Playing → advance from the captured position by the
 *  elapsed wall-clock; paused → frozen. Never negative. */
export function computeLivePosition(pb: PartyPlayback, serverAlignedNowMs: number): number {
  if (pb.paused) return Math.max(0, pb.position);
  const elapsed = (serverAlignedNowMs - pb.updatedAt) / 1000;
  return Math.max(0, pb.position + elapsed);
}

/** Whether the local time is far enough from the shared time to warrant a
 *  hard seek (vs. letting natural playback close a sub-threshold gap). */
export function shouldResync(localTimeS: number, sharedTimeS: number, threshold = PARTY_SYNC_THRESHOLD_S): boolean {
  return Math.abs(localTimeS - sharedTimeS) > threshold;
}

/** True when a currently-open player request already shows this target — used
 *  to avoid reopening/remounting the player on an echo of our own state. */
export function targetMatches(target: PartyTarget | null, cur: { kind: string; id: number; mediaFileId?: number } | null | undefined): boolean {
  if (!target || !cur) return false;
  if (target.mediaFileId !== undefined && cur.mediaFileId !== undefined) return target.mediaFileId === cur.mediaFileId;
  return target.kind === cur.kind && target.id === cur.id;
}

// --- room code (shared client/server) --------------------------------------

/** Crockford-ish alphabet without visually ambiguous glyphs (0/O, 1/I/L) so a
 *  code read aloud or off a second screen can't be mistyped into another room.
 *  6 chars over 30 symbols ≈ 7.3e8 space. Lives here (not in the server module)
 *  so the client input filter and the server validator can never disagree on
 *  which characters are legal — the whole reason this shared file exists. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LEN = 6;

/** Normalise a user-typed code: uppercase, then drop anything outside the
 *  alphabet (spaces/dashes people add reading it aloud). The alphabet is
 *  ambiguity-free by construction, so there are no look-alikes left to fold. */
export function normalizeRoomCode(raw: string): string {
  let out = "";
  for (const ch of raw.toUpperCase()) if (CODE_ALPHABET.includes(ch)) out += ch;
  return out;
}
