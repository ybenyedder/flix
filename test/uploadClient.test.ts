// Chunked-upload client engine (sendChunks) exercised against an in-memory
// fake of the server's chunk endpoint. The real module runs for real (File
// slicing, AbortSignal, UploadHttpError mapping) — only globalThis.fetch is
// swapped, the same pattern as arr-config.test.ts. The retry backoff ladder
// (1s/4s/15s) is stepped through instantly on node:test mock timers, and the
// EWMA throughput maths run on a stubbed performance.now so elapsed times are
// deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sendChunks, UploadHttpError, type UploadProgress } from "../src/lib/flix/uploadClient";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Non-uniform byte pattern so an offset/slice bug corrupts content visibly.
 *  Typed Uint8Array<ArrayBuffer> (not ArrayBufferLike) so it satisfies BlobPart. */
function makeBytes(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 3) % 251;
  return b;
}

interface PutRecord {
  path: string;
  offset: number;
  size: number;
}

/**
 * In-memory stand-in for `PUT /api/admin/upload/:id?offset=…`, mirroring the
 * real manager's semantics (test/upload-manager.test.ts): `received` only
 * advances on success, and a mismatched offset is a 409 carrying the
 * authoritative `received` so the client can re-sync.
 */
class FakeUploadServer {
  received = 0;
  data: Uint8Array;
  puts: PutRecord[] = [];
  /** Fault injection: return a Response to short-circuit call #n (1-based). */
  intercept: ((call: number) => Response | null) | null = null;
  /** Called after each handled PUT — used to advance a fake performance clock. */
  afterPut: ((call: number) => void) | null = null;

  constructor(total: number) {
    this.data = new Uint8Array(total);
  }

  /** Swap globalThis.fetch for this server; returns the restore callback. */
  install(): () => void {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), "http://flix.test");
      const offset = Number(url.searchParams.get("offset"));
      const body = new Uint8Array(await (init?.body as Blob).arrayBuffer());
      this.puts.push({ path: url.pathname, offset, size: body.length });
      const call = this.puts.length;
      let res: Response;
      const forced = this.intercept ? this.intercept(call) : null;
      if (forced) {
        res = forced;
      } else if (offset !== this.received) {
        res = json(409, { error: "offset mismatch", received: this.received });
      } else {
        this.data.set(body, offset);
        this.received = offset + body.length;
        res = json(200, { received: this.received });
      }
      if (this.afterPut) this.afterPut(call);
      return res;
    }) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }
}

function sendOpts(file: File, chunkSize: number, progress: UploadProgress[], signal?: AbortSignal, startOffset = 0) {
  return {
    uploadId: "up-1",
    file,
    chunkSize,
    startOffset,
    signal: signal ?? new AbortController().signal,
    onProgress: (p: UploadProgress) => progress.push(p),
  };
}

/** Flush microtasks + immediates so an awaited fetch/json chain settles before
 *  a mocked-timer tick (setImmediate stays real — only setTimeout is mocked). */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("sendChunks: multi-chunk file goes up as sequential PUTs with monotone progress", async () => {
  const bytes = makeBytes(10);
  const file = new File([bytes], "Film (2020).mkv");
  const server = new FakeUploadServer(10);
  const progress: UploadProgress[] = [];
  const restore = server.install();
  try {
    await sendChunks(sendOpts(file, 4, progress));
  } finally {
    restore();
  }

  // 10 bytes in 4-byte chunks → offsets 0/4/8, last chunk short.
  assert.deepEqual(
    server.puts.map((p) => [p.offset, p.size]),
    [
      [0, 4],
      [4, 4],
      [8, 2],
    ],
  );
  assert.equal(server.puts[0].path, "/api/admin/upload/up-1");
  // The server reassembled the exact file bytes.
  assert.deepEqual(server.data, bytes);
  // One progress event per accepted chunk, server-authoritative and monotone.
  assert.deepEqual(
    progress.map((p) => p.received),
    [4, 8, 10],
  );
  for (const p of progress) {
    assert.equal(p.total, 10);
    assert.ok(p.bytesPerSec === null || (Number.isFinite(p.bytesPerSec) && p.bytesPerSec > 0));
  }
});

test("sendChunks: an empty file resolves without any PUT", async () => {
  const server = new FakeUploadServer(0);
  const progress: UploadProgress[] = [];
  const restore = server.install();
  try {
    await sendChunks(sendOpts(new File([], "vide.mkv"), 4, progress));
  } finally {
    restore();
  }
  assert.equal(server.puts.length, 0);
  assert.equal(progress.length, 0);
});

test("sendChunks: resuming at startOffset never re-sends already-received bytes", async () => {
  const bytes = makeBytes(20);
  const file = new File([bytes], "f.mkv");
  const server = new FakeUploadServer(20);
  // The server already holds the first 8 bytes from a previous session.
  server.received = 8;
  server.data.set(bytes.subarray(0, 8), 0);
  const progress: UploadProgress[] = [];
  const restore = server.install();
  try {
    await sendChunks(sendOpts(file, 8, progress, undefined, 8));
  } finally {
    restore();
  }

  // No PUT below offset 8 — the upload picks up exactly where the server is.
  assert.deepEqual(
    server.puts.map((p) => [p.offset, p.size]),
    [
      [8, 8],
      [16, 4],
    ],
  );
  assert.deepEqual(server.data, bytes);
  assert.deepEqual(
    progress.map((p) => p.received),
    [16, 20],
  );
});

test("sendChunks: a 409 re-syncs the offset onto the server's received and re-slices from there", async () => {
  const bytes = makeBytes(10);
  const file = new File([bytes], "f.mkv");
  const server = new FakeUploadServer(10);
  // Desync: the client believes 0, the server already has 6 bytes.
  server.received = 6;
  server.data.set(bytes.subarray(0, 6), 0);
  const progress: UploadProgress[] = [];
  const restore = server.install();
  try {
    await sendChunks(sendOpts(file, 8, progress));
  } finally {
    restore();
  }

  // First PUT at the stale offset is refused; the retry starts at the server's
  // count (6), not at 0 and not at the next local chunk boundary.
  assert.deepEqual(
    server.puts.map((p) => [p.offset, p.size]),
    [
      [0, 8],
      [6, 4],
    ],
  );
  assert.deepEqual(server.data, bytes);
  // The resync itself surfaces as progress (received drops to the truth, then grows).
  assert.deepEqual(
    progress.map((p) => p.received),
    [6, 10],
  );
});

test("sendChunks: 409 resyncs are bounded (MAX_RESYNCS) before the error surfaces", async () => {
  const file = new File([makeBytes(10)], "f.mkv");
  const server = new FakeUploadServer(10);
  // A server that never converges: every PUT is a 409 pointing back at 0.
  server.intercept = () => json(409, { error: "offset mismatch", received: 0 });
  const progress: UploadProgress[] = [];
  const restore = server.install();
  try {
    await assert.rejects(
      sendChunks(sendOpts(file, 4, progress)),
      (e: unknown) => e instanceof UploadHttpError && e.status === 409,
    );
  } finally {
    restore();
  }
  // 5 tolerated resyncs + the attempt that gives up = 6 PUTs, no backoff sleeps.
  assert.equal(server.puts.length, 6);
});

test("sendChunks: 401/404/507 are terminal — the server's message surfaces without retry", async () => {
  for (const status of [401, 404, 507]) {
    const bytes = makeBytes(10);
    const file = new File([bytes], "f.mkv");
    const server = new FakeUploadServer(10);
    server.intercept = (call) => (call === 2 ? json(status, { error: `boom ${status}` }) : null);
    const progress: UploadProgress[] = [];
    const restore = server.install();
    try {
      await assert.rejects(
        sendChunks(sendOpts(file, 4, progress)),
        (e: unknown) => e instanceof UploadHttpError && e.status === status && e.message === `boom ${status}`,
      );
    } finally {
      restore();
    }
    // Exactly one PUT after the accepted first chunk — no backoff attempts.
    assert.equal(server.puts.length, 2, `status ${status} must not be retried`);
    assert.deepEqual(
      progress.map((p) => p.received),
      [4],
    );
  }
});

test("sendChunks: a transient 500 is retried after backoff and then succeeds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bytes = makeBytes(4);
  const file = new File([bytes], "f.mkv");
  const server = new FakeUploadServer(4);
  server.intercept = (call) => (call <= 2 ? json(500, { error: "hiccup" }) : null);
  const progress: UploadProgress[] = [];
  const restore = server.install();
  try {
    const done = sendChunks(sendOpts(file, 4, progress));
    void done.catch(() => {}); // keep an early failure from tripping unhandledRejection mid-drain
    await drain();
    assert.equal(server.puts.length, 1, "first attempt fired before any backoff");
    t.mock.timers.tick(1000); // first backoff step
    await drain();
    assert.equal(server.puts.length, 2, "second attempt after the 1s backoff");
    t.mock.timers.tick(4000); // second backoff step
    await drain();
    await done;
  } finally {
    restore();
  }
  assert.equal(server.puts.length, 3);
  assert.deepEqual(server.data, bytes);
  assert.deepEqual(
    progress.map((p) => p.received),
    [4],
  );
});

test("sendChunks: a persistent 500 exhausts the 1s/4s/15s ladder then rejects", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const file = new File([makeBytes(4)], "f.mkv");
  const server = new FakeUploadServer(4);
  server.intercept = () => json(500, { error: "down" });
  const restore = server.install();
  try {
    const done = sendChunks(sendOpts(file, 4, []));
    const expectation = assert.rejects(done, (e: unknown) => e instanceof UploadHttpError && e.status === 500);
    for (const ms of [1000, 4000, 15000]) {
      await drain();
      t.mock.timers.tick(ms);
    }
    await drain();
    await expectation;
  } finally {
    restore();
  }
  // 1 initial attempt + one per backoff step.
  assert.equal(server.puts.length, 4);
});

test("sendChunks: abort before or between chunks rejects with AbortError and stops sending", async () => {
  // Pre-aborted signal → not a single PUT leaves.
  const server = new FakeUploadServer(8);
  const restore = server.install();
  try {
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      sendChunks(sendOpts(new File([makeBytes(8)], "f.mkv"), 4, [], aborted.signal)),
      (e: unknown) => e instanceof DOMException && e.name === "AbortError",
    );
    assert.equal(server.puts.length, 0);

    // Abort mid-file (from the progress callback after chunk 1) → the loop
    // stops at the next chunk boundary.
    const ctrl = new AbortController();
    const midServer = new FakeUploadServer(8);
    const restoreMid = midServer.install();
    try {
      await assert.rejects(
        sendChunks({
          uploadId: "up-1",
          file: new File([makeBytes(8)], "f.mkv"),
          chunkSize: 4,
          startOffset: 0,
          signal: ctrl.signal,
          onProgress: () => ctrl.abort(),
        }),
        (e: unknown) => e instanceof DOMException && e.name === "AbortError",
      );
      assert.equal(midServer.puts.length, 1);
    } finally {
      restoreMid();
    }
  } finally {
    restore();
  }
});

test("sendChunks: bytesPerSec is an EWMA (0.7 old / 0.3 instant) of per-chunk throughput", async () => {
  // Deterministic clock: performance.now returns `clock`, which only the fake
  // server advances (1s for chunk 1, 0.5s for chunk 2). Extra now() calls in
  // between are harmless — they observe the same instant.
  let clock = 0;
  const realNow = performance.now;
  performance.now = () => clock;
  const bytes = makeBytes(8);
  const server = new FakeUploadServer(8);
  server.afterPut = (call) => {
    clock += call === 1 ? 1000 : 500;
  };
  const progress: UploadProgress[] = [];
  const restore = server.install();
  try {
    await sendChunks(sendOpts(new File([bytes], "f.mkv"), 4, progress));
  } finally {
    restore();
    performance.now = realNow;
  }

  assert.equal(progress.length, 2);
  // First sample seeds the EWMA: 4 bytes / 1s = 4 B/s.
  assert.equal(progress[0].bytesPerSec, 4);
  // Second: instant = 4 bytes / 0.5s = 8 B/s → 0.7*4 + 0.3*8 = 5.2 B/s.
  const second = progress[1].bytesPerSec;
  assert.ok(second !== null && Math.abs(second - 5.2) < 1e-9, `expected ~5.2, got ${second}`);
});
