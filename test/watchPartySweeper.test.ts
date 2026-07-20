// Watch-party sweeper: idle/TTL reclamation, offline-member reaping and the
// empty-room grace window. The registry exposes __sweepNow() so each case runs
// one sweep pass deterministically; the wall clock (Date.now) is driven with
// node:test mock timers (apis: ["Date"]) — the sweeper's own 15s interval stays
// a real (unref'd) timer and never fires within a test's lifetime.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRoom,
  joinRoom,
  leaveRoom,
  subscribe,
  chat,
  __resetPartyState,
  __sweepNow,
  __peek,
  type PartyResult,
} from "../src/server/watch/party";
import type { PartyServerEvent } from "../src/lib/flix/party";

// Mirrors of the (unexported) lifecycle constants in src/server/watch/party.ts.
// If those change, these tests fail loudly — which is the point: the sweep
// windows are part of the room contract.
const ROOM_TTL_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 90 * 60 * 1000;
const PRESENCE_GRACE_MS = 45 * 1000;
const EMPTY_GRACE_MS = 2 * 60 * 1000;

const T0 = 1000000;

function ident(id: number) {
  return { userId: id, username: `u${id}`, avatar: "red" };
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

test("sweep reclaims a room idle past IDLE_MS and tells the survivors why", (t) => {
  __resetPartyState();
  t.mock.timers.enable({ apis: ["Date"], now: T0 });

  const { code } = unwrap(createRoom(ident(1)));
  const events: PartyServerEvent[] = [];
  unwrap(subscribe(code, 1, "c1", (e) => events.push(e)));

  // Well inside the idle window: nothing to reclaim (the member is online, so
  // presence reaping never applies to them either).
  t.mock.timers.setTime(T0 + IDLE_MS - 60 * 1000);
  __sweepNow();
  assert.ok(__peek(code), "an idle-but-not-expired room survives the sweep");

  // Past the idle window: reclaimed, and the still-open connection is told.
  t.mock.timers.setTime(T0 + IDLE_MS + 1000);
  __sweepNow();
  assert.equal(__peek(code), null);
  const closed = events.at(-1);
  assert.ok(closed && closed.t === "closed", "connections receive a closed event");
  if (closed && closed.t === "closed") assert.equal(closed.reason, "séance expirée");

  __resetPartyState();
});

test("member activity resets the idle clock and keeps the room alive", (t) => {
  __resetPartyState();
  t.mock.timers.enable({ apis: ["Date"], now: T0 });

  const { code } = unwrap(createRoom(ident(1)));
  unwrap(subscribe(code, 1, "c1", () => {}));

  // Three hops of (IDLE_MS - 1min) each — total elapsed far exceeds IDLE_MS,
  // but a chat right before each sweep keeps lastActivity fresh.
  let now = T0;
  for (let hop = 0; hop < 3; hop++) {
    now += IDLE_MS - 60 * 1000;
    t.mock.timers.setTime(now);
    unwrap(chat(code, 1, "toujours là"));
    __sweepNow();
    assert.ok(__peek(code), `room survives hop ${hop + 1} thanks to activity`);
  }

  // Then the activity stops: one full idle window later the room is gone.
  now += IDLE_MS + 1000;
  t.mock.timers.setTime(now);
  __sweepNow();
  assert.equal(__peek(code), null);

  __resetPartyState();
});

test("the absolute ROOM_TTL_MS caps even a continuously active room", (t) => {
  __resetPartyState();
  t.mock.timers.enable({ apis: ["Date"], now: T0 });

  const { code } = unwrap(createRoom(ident(1)));
  unwrap(subscribe(code, 1, "c1", () => {}));

  // Just under the TTL, with fresh activity → still alive.
  t.mock.timers.setTime(T0 + ROOM_TTL_MS - 60 * 1000);
  unwrap(chat(code, 1, "marathon"));
  __sweepNow();
  assert.ok(__peek(code));

  // Just past the TTL: lastActivity is seconds old, yet the room is reclaimed
  // on createdAt alone — a screening isn't a server.
  t.mock.timers.setTime(T0 + ROOM_TTL_MS + 1000);
  unwrap(chat(code, 1, "encore ?"));
  __sweepNow();
  assert.equal(__peek(code), null);

  __resetPartyState();
});

test("an offline member is reaped after PRESENCE_GRACE_MS and the host role moves on", (t) => {
  __resetPartyState();
  t.mock.timers.enable({ apis: ["Date"], now: T0 });

  const { code } = unwrap(createRoom(ident(1)));
  const hostConn = unwrap(subscribe(code, 1, "c1", () => {}));
  unwrap(joinRoom(code, ident(2)));
  unwrap(subscribe(code, 2, "c2", () => {}));

  // Host drops their only connection (closed tab, not an explicit leave).
  t.mock.timers.setTime(T0 + 10 * 1000);
  hostConn.unsubscribe();

  // Inside the grace window the member survives, just flagged offline.
  t.mock.timers.setTime(T0 + 10 * 1000 + PRESENCE_GRACE_MS - 1000);
  __sweepNow();
  let snap = peek(code);
  assert.equal(snap.members.length, 2);
  assert.equal(snap.members.find((m) => m.userId === 1)?.online, false);
  assert.equal(snap.hostId, 1);

  // Past the grace window the ghost is reaped and the earliest-joined
  // remaining member inherits the host role; the room itself lives on.
  t.mock.timers.setTime(T0 + 10 * 1000 + PRESENCE_GRACE_MS + 1000);
  __sweepNow();
  snap = peek(code);
  assert.equal(snap.members.length, 1);
  assert.equal(snap.members[0].userId, 2);
  assert.equal(snap.hostId, 2);

  __resetPartyState();
});

test("a join-only member who never opened an SSE is reaped from joinedAt", (t) => {
  __resetPartyState();
  t.mock.timers.enable({ apis: ["Date"], now: T0 });

  const { code } = unwrap(createRoom(ident(1)));
  unwrap(subscribe(code, 1, "c1", () => {}));
  // User 2 joins but never subscribes (disconnectedAt stays 0).
  unwrap(joinRoom(code, ident(2)));

  // Still inside the grace window measured from joinedAt: both members remain.
  t.mock.timers.setTime(T0 + 30 * 1000);
  __sweepNow();
  assert.equal(peek(code).members.length, 2);

  // Past it: the never-connected member frees their MAX_MEMBERS slot; the
  // online host is never reaped, so the room survives.
  t.mock.timers.setTime(T0 + PRESENCE_GRACE_MS + 1000);
  __sweepNow();
  const snap = peek(code);
  assert.equal(snap.members.length, 1);
  assert.equal(snap.members[0].userId, 1);

  __resetPartyState();
});

test("an emptied room lingers for EMPTY_GRACE_MS (rejoinable) then is reclaimed", (t) => {
  __resetPartyState();
  t.mock.timers.enable({ apis: ["Date"], now: T0 });

  const { code } = unwrap(createRoom(ident(1)));
  unwrap(subscribe(code, 1, "c1", () => {}));

  // The lone member leaves explicitly: the room empties but is kept so a
  // reload can rejoin the same code.
  t.mock.timers.setTime(T0 + 10 * 1000);
  leaveRoom(code, 1);
  assert.equal(peek(code).members.length, 0);

  // A sweep inside the grace window keeps it, and a rejoin still works.
  t.mock.timers.setTime(T0 + 10 * 1000 + EMPTY_GRACE_MS - 1000);
  __sweepNow();
  assert.ok(__peek(code), "empty room survives within the grace window");
  unwrap(joinRoom(code, ident(2)));
  assert.equal(peek(code).members.length, 1);

  // Emptied again: once the grace window fully elapses, the sweep reclaims it.
  leaveRoom(code, 2);
  t.mock.timers.setTime(T0 + 10 * 1000 + EMPTY_GRACE_MS - 1000 + EMPTY_GRACE_MS + 1000);
  __sweepNow();
  assert.equal(__peek(code), null);

  __resetPartyState();
});
