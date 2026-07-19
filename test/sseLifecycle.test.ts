// SSE lifecycle for the two streaming routes (library/events, watch/room).
// CLAUDE.md documents the teardown trap these routes fixed: cleanup must be
// idempotent AND independent of `closed`, or an aborted/errored stream leaks
// its ping timer + subscriber + per-user slot. Nothing exercised the ROUTE
// lifecycle itself (watchParty.test.ts covers the pure room logic only), so a
// refactor could silently reintroduce the leak — these tests pin the
// observable contract: slots are released on abort, released exactly ONCE on
// the double abort+cancel path, and the per-user cap stays accurate.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "flix-sse-data-"));
const tmpMedia = fs.mkdtempSync(path.join(os.tmpdir(), "flix-sse-media-"));
process.env.FLIX_DATA_DIR = tmpData;
process.env.FLIX_MEDIA_DIR = tmpMedia;
process.on("exit", () => {
  for (const dir of [tmpData, tmpMedia]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

let eventsGET: typeof import("../src/app/api/library/events/route").GET;
let roomGET: typeof import("../src/app/api/watch/room/route").GET;
let roomPOST: typeof import("../src/app/api/watch/room/route").POST;
let token = "";

before(async () => {
  const Auth = await import("../src/server/auth");
  ({ GET: eventsGET } = await import("../src/app/api/library/events/route"));
  ({ GET: roomGET, POST: roomPOST } = await import("../src/app/api/watch/room/route"));
  const user = Auth.createUser("sseprofile", "password123");
  if (!user.ok || !user.id) throw new Error("failed to create test profile");
  token = Auth.createSessionToken(user.id);
});

function authed(url: string, init: RequestInit = {}): Request {
  return new Request(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
}

async function openEvents(signal: AbortSignal): Promise<Response> {
  return eventsGET(authed("http://localhost:4247/api/library/events", { signal }));
}

test("library/events: per-user cap enforced, slots released on abort, double teardown releases exactly once", async () => {
  // Fill the 4-slot cap…
  const first = Array.from({ length: 4 }, () => new AbortController());
  const firstRes: Response[] = [];
  for (const c of first) firstRes.push(await openEvents(c.signal));
  for (const r of firstRes) assert.equal(r.status, 200);
  // …the 5th concurrent stream is refused.
  const over = await openEvents(new AbortController().signal);
  assert.equal(over.status, 429);

  // Abort every stream; ALSO run the cancel() path on the first one — the
  // double teardown (abort + cancel) must release its slot exactly once.
  for (const c of first) c.abort();
  await firstRes[0].body?.cancel();

  // All 4 slots must be back…
  const second = Array.from({ length: 4 }, () => new AbortController());
  const secondRes: Response[] = [];
  for (const c of second) secondRes.push(await openEvents(c.signal));
  for (const r of secondRes) assert.equal(r.status, 200, "aborted streams must free their slots");
  // …and ONLY 4: a double-decrement on the abort+cancel stream would have
  // driven the counter negative and let a 5th through here.
  const overAgain = await openEvents(new AbortController().signal);
  assert.equal(overAgain.status, 429, "the cap must stay accurate after teardown churn");

  for (const c of second) c.abort();
});

async function readFirstEvent(res: Response): Promise<string> {
  assert.ok(res.body, "an SSE response must carry a body stream");
  const reader = res.body.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value);
}

test("watch/room: subscribe streams a snapshot, an aborted member can reconnect on the same conn id", async () => {
  const createRes = await roomPOST(
    authed("http://localhost:4247/api/watch/room", { method: "POST", body: JSON.stringify({ action: "create" }) }),
  );
  assert.equal(createRes.status, 200);
  const { code } = (await createRes.json()) as { code: string };
  assert.ok(code);

  const sseUrl = `http://localhost:4247/api/watch/room?code=${code}&conn=c1`;
  const c1 = new AbortController();
  const res1 = await roomGET(authed(sseUrl, { signal: c1.signal }));
  assert.equal(res1.status, 200);
  assert.match(await readFirstEvent(res1), /^data: \{"t":/, "the first frame is the initial snapshot event");

  // Abort, then reconnect with the SAME conn id — the freed slot must be
  // reusable (a leaked one would shadow the new connection's teardown).
  c1.abort();
  const c2 = new AbortController();
  const res2 = await roomGET(authed(sseUrl, { signal: c2.signal }));
  assert.equal(res2.status, 200);
  assert.match(await readFirstEvent(res2), /^data: \{"t":/);
  c2.abort();
  await res2.body?.cancel(); // double teardown must stay a no-op

  const leaveRes = await roomPOST(
    authed("http://localhost:4247/api/watch/room", { method: "POST", body: JSON.stringify({ action: "leave", code }) }),
  );
  assert.equal(leaveRes.status, 200);
});

test("watch/room: subscribing to an unknown room ends the stream with a 'closed' event, not an HTTP error", async () => {
  const res = await roomGET(authed("http://localhost:4247/api/watch/room?code=ZZZZZZ&conn=c9", { signal: new AbortController().signal }));
  // EventSource can't read non-200 bodies, so the refusal arrives as an event.
  assert.equal(res.status, 200);
  assert.match(await readFirstEvent(res), /"t":"closed"/);
});
