// Tests for the CSRF / same-origin guard (checkCsrf) and the other pure HTTP
// helpers in http.ts (If-None-Match matching, JSON body size cap). No DB — so
// it imports cleanly without touching the SQLite connection other tests use.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCsrf, ifNoneMatchHits, readJsonBody } from "../src/server/http";

const URL_STATE = "http://localhost:4247/api/state";
const allow = (r: Request) => checkCsrf(r) === null;
const blocked = (r: Request) => checkCsrf(r)?.status === 403;
const req = (method: string, headers: Record<string, string>) => new Request(URL_STATE, { method, headers });

test("safe methods are never blocked", () => {
  assert.ok(allow(req("GET", {})));
  assert.ok(allow(req("HEAD", {})));
  assert.ok(allow(new Request(URL_STATE, { method: "OPTIONS", headers: { origin: "http://evil.test" } })));
});

test("a forged bearer / ?token does NOT exempt — only a token that truly authenticates is (CSRF-safe)", () => {
  assert.ok(blocked(req("PUT", { authorization: "Bearer abc.def", origin: "http://evil.test", host: "localhost:4247" })));
  assert.ok(blocked(new Request(URL_STATE + "?token=abc", { method: "PUT", headers: { origin: "http://evil.test", host: "localhost:4247" } })));
  // Same-origin still passes regardless of the (forged) token — Origin governs.
  assert.ok(allow(req("PUT", { authorization: "Bearer abc.def", origin: "http://localhost:4247", host: "localhost:4247" })));
});

test("cookie-authed mutation with no Origin/Referer is rejected", () => {
  assert.ok(blocked(req("PUT", { host: "localhost:4247" })));
});

test("same-origin Origin is allowed; a foreign Origin is blocked", () => {
  assert.ok(allow(req("PUT", { origin: "http://localhost:4247", host: "localhost:4247" })));
  assert.ok(blocked(req("PUT", { origin: "http://evil.test", host: "localhost:4247" })));
});

test("a same-origin Referer (no Origin) is allowed", () => {
  assert.ok(allow(req("PUT", { referer: "http://localhost:4247/app", host: "localhost:4247" })));
});

test("X-Forwarded-Host is honoured (reverse proxy that keeps the real public host there)", () => {
  assert.ok(allow(req("PUT", { origin: "https://flix.example.com", host: "127.0.0.1:4247", "x-forwarded-host": "flix.example.com" })));
  assert.ok(blocked(req("PUT", { origin: "https://evil.test", host: "127.0.0.1:4247", "x-forwarded-host": "flix.example.com" })));
});

test("logout rejects a forged cross-origin POST (403, before auth even runs)", async () => {
  const { POST: logoutPost } = await import("../src/app/api/auth/logout/route");
  const hostile = { origin: "http://evil.test", host: "localhost:4247" };
  const logoutRes = await logoutPost(req("POST", hostile));
  assert.equal(logoutRes.status, 403);
});

test("ifNoneMatchHits: lists, the * wildcard and W/ weak validators all match; unrelated tags don't", () => {
  assert.equal(ifNoneMatchHits('"abc-0"', '"abc-0"'), true);
  assert.equal(ifNoneMatchHits('"x", "abc-0"', '"abc-0"'), true);
  assert.equal(ifNoneMatchHits("*", '"abc-0"'), true);
  assert.equal(ifNoneMatchHits('W/"abc-0"', '"abc-0"'), true); // weak comparison per RFC 7232
  assert.equal(ifNoneMatchHits('"other"', '"abc-0"'), false);
  assert.equal(ifNoneMatchHits(null, '"abc-0"'), false);
});

test("readJsonBody: small mutation bodies pass, anything over the (tight) default cap is a 413", async () => {
  const post = (body: string) => new Request(URL_STATE, { method: "POST", headers: { "content-type": "application/json" }, body });
  const ok = await readJsonBody<{ a: number }>(post(JSON.stringify({ a: 1 })));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.body.a, 1);
  // 70 KiB of padding exceeds the 64 KiB default — no JSON mutation in this
  // project is anywhere near that big.
  const big = await readJsonBody(post(JSON.stringify({ pad: "x".repeat(70 * 1024) })));
  assert.equal(big.ok, false);
  if (!big.ok) assert.equal(big.response.status, 413);
});

test("FLIX_ALLOWED_ORIGINS whitelists an explicit origin", () => {
  const prev = process.env.FLIX_ALLOWED_ORIGINS;
  process.env.FLIX_ALLOWED_ORIGINS = "flix.example.com, https://other.test";
  try {
    assert.ok(allow(req("PUT", { origin: "https://flix.example.com", host: "127.0.0.1:4247" })));
    assert.ok(allow(req("PUT", { origin: "https://other.test", host: "127.0.0.1:4247" })));
    assert.ok(blocked(req("PUT", { origin: "https://nope.test", host: "127.0.0.1:4247" })));
  } finally {
    if (prev === undefined) delete process.env.FLIX_ALLOWED_ORIGINS;
    else process.env.FLIX_ALLOWED_ORIGINS = prev;
  }
});
