// Watch-party ("Séance") room state machine + pure sync maths. No DB, no HTTP —
// the registry is a pure in-memory module (like the scanner's subscribers), so
// every case drives it directly and captures broadcasts through a fake SSE send.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRoom,
  joinRoom,
  leaveRoom,
  subscribe,
  control,
  setTarget,
  react,
  chat,
  normalizeCode,
  __resetPartyState,
  __peek,
  type PartyResult,
} from "../src/server/watch/party";
import { computeLivePosition, shouldResync, targetMatches, type PartyPlayback, type PartyServerEvent } from "../src/lib/flix/party";

function ident(id: number) {
  return { userId: id, username: `u${id}`, avatar: "red" };
}

/** Subscribe and collect every event the connection receives. */
function sub(code: string, userId: number) {
  const events: PartyServerEvent[] = [];
  const res = subscribe(code, userId, `conn-${userId}-${events.length}-${userId * 7}`, (e) => events.push(e));
  return { res, events };
}

function unwrap<T>(r: PartyResult<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** Peek a room, asserting it exists (narrows away null without a `!`). */
function peek(code: string) {
  const s = __peek(code);
  assert.ok(s, "room should exist");
  return s;
}

/** Last event a connection received, asserting there is one. */
function last(events: PartyServerEvent[]): PartyServerEvent {
  const e = events.at(-1);
  assert.ok(e, "expected at least one event");
  return e;
}

test("create + join builds a roster; unknown code and a full room are rejected", () => {
  __resetPartyState();
  const { code, snapshot } = unwrap(createRoom(ident(1)));
  assert.match(code, /^[2-9A-HJ-NP-Z]{6}$/);
  assert.equal(snapshot.members.length, 1);
  assert.equal(snapshot.members[0].isHost, true);

  assert.equal(unwrap(joinRoom(code, ident(2))).snapshot.members.length, 2);

  const bad = joinRoom("ZZZZZZ", ident(3));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.status, 404);

  // Fill to the cap (12): users 3..12 join → 12 members, the 13th is refused.
  for (let id = 3; id <= 12; id++) assert.equal(joinRoom(code, ident(id)).ok, true);
  const full = joinRoom(code, ident(13));
  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.status, 429);

  // A member already in can always re-join (reload) even at capacity.
  assert.equal(joinRoom(code, ident(5)).ok, true);
});

test("subscribe requires membership, streams an initial snapshot, and tracks presence", () => {
  __resetPartyState();
  const { code } = unwrap(createRoom(ident(1)));

  const outsider = subscribe(code, 99, "c99", () => {});
  assert.equal(outsider.ok, false);
  if (!outsider.ok) assert.equal(outsider.status, 403);

  const host = sub(code, 1);
  const initial = unwrap(host.res);
  assert.equal(initial.initial.t, "snapshot");
  if (initial.initial.t === "snapshot") assert.equal(initial.initial.you, 1);

  // Host now shows online, and joining+subscribing user 2 broadcasts to the host.
  assert.equal(__peek(code)?.members.find((m) => m.userId === 1)?.online, true);
  unwrap(joinRoom(code, ident(2)));
  const before = host.events.length;
  sub(code, 2);
  assert.ok(host.events.length > before, "host should be notified when a member connects");
  assert.equal(__peek(code)?.members.length, 2);

  // Dropping the host's only connection flips presence offline but keeps membership.
  initial.unsubscribe();
  const hostMember = __peek(code)?.members.find((m) => m.userId === 1);
  assert.equal(hostMember?.online, false);
  assert.ok(hostMember, "member survives a disconnect within the grace window");
});

test("control is a shared remote — any member drives transport, outsiders cannot", () => {
  __resetPartyState();
  const { code } = unwrap(createRoom(ident(1)));
  unwrap(joinRoom(code, ident(2)));
  const host = sub(code, 1);
  const guest = sub(code, 2);

  unwrap(control(code, 2, "pause", 30));
  let pb = peek(code).playback;
  assert.equal(pb.paused, true);
  assert.equal(pb.position, 30);
  const lastHost = last(host.events);
  assert.equal(lastHost.t, "control");
  if (lastHost.t === "control") {
    assert.equal(lastHost.action, "pause");
    assert.equal(lastHost.by, "u2");
  }
  assert.equal(last(guest.events).t, "control");

  unwrap(control(code, 2, "play", 30));
  assert.equal(peek(code).playback.paused, false);

  // Seek keeps the paused flag as-is, only moving the position.
  unwrap(control(code, 1, "seek", 100));
  pb = peek(code).playback;
  assert.equal(pb.position, 100);
  assert.equal(pb.paused, false);

  const outsider = control(code, 999, "pause", 0);
  assert.equal(outsider.ok, false);
  if (!outsider.ok) assert.equal(outsider.status, 403);
});

test("target is host-only and drives the shared screen (including back to the lobby)", () => {
  __resetPartyState();
  const { code } = unwrap(createRoom(ident(1)));
  unwrap(joinRoom(code, ident(2)));

  const byGuest = setTarget(code, 2, { kind: "movie", id: 5 });
  assert.equal(byGuest.ok, false);
  if (!byGuest.ok) assert.equal(byGuest.status, 403);

  unwrap(setTarget(code, 1, { kind: "episode", id: 42, topId: 7, mediaFileId: 99, title: "Pilote" }, 120, true));
  let pb = peek(code).playback;
  assert.equal(pb.target?.mediaFileId, 99);
  assert.equal(pb.position, 120);
  assert.equal(pb.paused, false);

  // Loading with autoplay off starts paused.
  unwrap(setTarget(code, 1, { kind: "movie", id: 8 }, 0, false));
  assert.equal(peek(code).playback.paused, true);

  // Null target = back to the lobby.
  unwrap(setTarget(code, 1, null));
  pb = peek(code).playback;
  assert.equal(pb.target, null);
  assert.equal(pb.paused, true);
});

test("host handover: the earliest remaining member is promoted when the host leaves", () => {
  __resetPartyState();
  const { code } = unwrap(createRoom(ident(1)));
  unwrap(joinRoom(code, ident(2)));
  unwrap(joinRoom(code, ident(3)));

  leaveRoom(code, 1);
  assert.equal(peek(code).hostId, 2);
  assert.equal(peek(code).members.length, 2);

  leaveRoom(code, 2);
  assert.equal(peek(code).hostId, 3);
});

test("reactions and chat broadcast and reject empties", () => {
  __resetPartyState();
  const { code } = unwrap(createRoom(ident(1)));
  const host = sub(code, 1);

  unwrap(react(code, 1, "🔥"));
  const reaction = last(host.events);
  assert.equal(reaction.t, "reaction");
  if (reaction.t === "reaction") assert.equal(reaction.emoji, "🔥");
  assert.equal(react(code, 1, "   ").ok, false);

  unwrap(chat(code, 1, "  salut  "));
  const message = last(host.events);
  assert.equal(message.t, "chat");
  if (message.t === "chat") assert.equal(message.text, "salut");
  assert.equal(chat(code, 1, "").ok, false);

  // Non-members can't emit.
  assert.equal(react(code, 42, "🔥").ok, false);
  assert.equal(chat(code, 42, "hi").ok, false);
});

test("room codes are unique, in-alphabet, and capped in number", () => {
  __resetPartyState();
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const { code } = unwrap(createRoom(ident(i + 1)));
    assert.equal(code.length, 6);
    assert.ok(!/[01ILO]/.test(code), "code avoids ambiguous glyphs");
    assert.ok(!seen.has(code), "codes are unique");
    seen.add(code);
  }
  const overflow = createRoom(ident(999));
  assert.equal(overflow.ok, false);
  if (!overflow.ok) assert.equal(overflow.status, 429);
});

test("computeLivePosition advances while playing and freezes while paused", () => {
  const playing: PartyPlayback = { target: { kind: "movie", id: 1 }, paused: false, position: 10, updatedAt: 1000 };
  assert.equal(computeLivePosition(playing, 6000), 15); // 10 + (6000-1000)/1000
  const paused: PartyPlayback = { ...playing, paused: true };
  assert.equal(computeLivePosition(paused, 6000), 10);
  // Never negative even if a clock skew puts "now" before updatedAt.
  assert.equal(computeLivePosition({ ...playing, position: 0 }, 0), 0);
});

test("shouldResync only fires past the drift threshold; targetMatches keys on file then id", () => {
  assert.equal(shouldResync(10, 12), true); // 2s > 1.5
  assert.equal(shouldResync(10, 11), false); // 1s
  assert.equal(targetMatches({ kind: "movie", id: 1, mediaFileId: 9 }, { kind: "movie", id: 1, mediaFileId: 9 }), true);
  assert.equal(targetMatches({ kind: "movie", id: 1, mediaFileId: 9 }, { kind: "movie", id: 1, mediaFileId: 8 }), false);
  assert.equal(targetMatches({ kind: "episode", id: 5 }, { kind: "episode", id: 5 }), true);
  assert.equal(targetMatches(null, { kind: "movie", id: 1 }), false);
});

test("normalizeCode uppercases and drops noise", () => {
  assert.equal(normalizeCode(" ab-cd 23 "), "ABCD23");
  assert.equal(normalizeCode("xyzq99"), "XYZQ99");
  assert.equal(normalizeCode("!!!"), "");
});
