// Tests for the multi-profile auth module: admin seeding, credential checks,
// malformed-cookie robustness, the pre-scrypt password length cap, the login
// route's rate-limit behaviour (a correct login passes the username-bucket
// cooldown), session token revocation on password change, and the HTTPS-only
// Secure cookie flag. Uses an isolated temp data dir so it never touches a
// real library DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flix-auth-test-"));
process.env.FLIX_DATA_DIR = tmp;
process.on("exit", () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

test("session cookie is Secure over HTTPS, but NOT over plain HTTP (LAN install stays usable)", async () => {
  const { sessionCookieOptions } = await import("../src/server/auth");
  assert.equal(sessionCookieOptions(new Request("http://192.168.1.10:4247/api/auth/login", { method: "POST" })).secure, false);
  assert.equal(sessionCookieOptions(new Request("https://flix.example.com/api/auth/login", { method: "POST" })).secure, true);
  const proxied = new Request("http://127.0.0.1:4247/api/auth/login", { method: "POST", headers: { "x-forwarded-proto": "https" } });
  assert.equal(sessionCookieOptions(proxied).secure, true);
  const opts = sessionCookieOptions(new Request("https://x/", { method: "POST" }));
  assert.equal(opts.httpOnly, true);
  assert.equal(opts.sameSite, "lax");
  assert.equal(opts.path, "/");
});

test("ensureAuth seeds a single admin profile with a random password written to a 0600 file", async () => {
  const { ensureAuth, listUsers } = await import("../src/server/auth");
  ensureAuth();
  const users = listUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].username, "admin");
  assert.equal(users[0].is_admin, 1);
  const file = path.join(tmp, "INITIAL_ADMIN_PASSWORD.txt");
  assert.ok(fs.existsSync(file));
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("createUser validates identifier and password, rejects duplicates", async () => {
  const { createUser } = await import("../src/server/auth");
  assert.equal(createUser("Bad Name!", "longenough123").ok, false);
  assert.equal(createUser("kid1", "short").ok, false);
  const ok = createUser("kid1", "longenough123", { isKids: true, avatar: "blue" });
  assert.equal(ok.ok, true);
  assert.equal(createUser("kid1", "longenough123").ok, false);
});

test("verifyCredentials rejects a wrong password and accepts the right one", async () => {
  const { verifyCredentials } = await import("../src/server/auth");
  assert.equal(verifyCredentials("kid1", "wrongpassword"), null);
  const user = verifyCredentials("kid1", "longenough123");
  assert.ok(user);
  assert.equal(user?.is_kids, 1);
  assert.equal(user?.avatar, "blue");
});

test("a malformed session cookie (bad %-escape) is rejected cleanly, never thrown as a 500", async () => {
  const { getRequestUser, createSessionToken, verifyCredentials } = await import("../src/server/auth");
  // decodeURIComponent would throw URIError on these — parseCookie must not.
  const malformed = new Request("http://localhost:4247/api/state", { headers: { cookie: "flix_session=%E0%A4%A" } });
  assert.equal(getRequestUser(malformed), null);
  const truncated = new Request("http://localhost:4247/api/state", { headers: { cookie: "flix_session=%" } });
  assert.equal(getRequestUser(truncated), null);
  // A malformed UNRELATED pair must not break resolution of a valid session either.
  const user = verifyCredentials("kid1", "longenough123");
  assert.ok(user);
  const token = createSessionToken(user.id);
  const mixed = new Request("http://localhost:4247/api/state", { headers: { cookie: `bad=%zz; flix_session=${token}` } });
  assert.equal(getRequestUser(mixed)?.id, user.id);
});

test("passwords over 256 chars are rejected before scrypt (login, creation and reset paths)", async () => {
  const { verifyCredentials, createUser, setUserPassword } = await import("../src/server/auth");
  const huge = "a".repeat(300);
  assert.equal(verifyCredentials("kid1", huge), null);
  assert.equal(createUser("hugepw", huge).ok, false);
  assert.equal(setUserPassword(1, huge).ok, false);
});

test("login: correct credentials pass DURING the username-bucket cooldown (and reset it); failures still 429", async () => {
  const { createUser } = await import("../src/server/auth");
  const { usernameKey, rateLimitFail, rateLimitCheck } = await import("../src/server/rateLimit");
  const { POST: loginPost } = await import("../src/app/api/auth/login/route");
  assert.equal(createUser("cooldownuser", "cooldownpass123").ok, true);

  // Arm the username-only bucket the way a hostile LAN client would: repeated
  // failures against a username harvested from the profile picker.
  const userKey = usernameKey("cooldownuser");
  for (let i = 0; i < 7; i++) rateLimitFail(userKey);
  assert.ok(rateLimitCheck(userKey) > 0);

  const post = (password: string) =>
    loginPost(
      new Request("http://localhost:4247/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "cooldownuser", password }),
      }),
    );

  // A wrong password during the cooldown stays rejected (and keeps feeding the bucket).
  const denied = await post("wrongpassword");
  assert.equal(denied.status, 429);

  // The account's real owner gets in despite the third-party lockout attempt.
  const ok = await post("cooldownpass123");
  assert.equal(ok.status, 200);
  // Token-bearing response must never be cacheable.
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(rateLimitCheck(userKey), 0);
});

test("login: a password over the cap or an oversized body is rejected without hashing", async () => {
  const { POST: loginPost } = await import("../src/app/api/auth/login/route");
  const overCap = await loginPost(
    new Request("http://localhost:4247/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "cooldownuser", password: "a".repeat(300) }),
    }),
  );
  assert.equal(overCap.status, 401);
  const oversized = await loginPost(
    new Request("http://localhost:4247/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "cooldownuser", password: "x".repeat(8 * 1024) }),
    }),
  );
  assert.equal(oversized.status, 413);
});

test("changing a password bumps token_version and invalidates prior session tokens", async () => {
  const { verifyCredentials, createSessionToken, setUserPassword } = await import("../src/server/auth");
  const user = verifyCredentials("kid1", "longenough123");
  assert.ok(user);
  const oldToken = createSessionToken(user.id);

  const { getRequestUser } = await import("../src/server/auth");
  const before = getRequestUser(new Request("http://localhost:4247/", { headers: { cookie: `flix_session=${oldToken}` } }));
  assert.equal(before?.id, user.id);

  setUserPassword(user.id, "brandnewpassword1");
  const after = getRequestUser(new Request("http://localhost:4247/", { headers: { cookie: `flix_session=${oldToken}` } }));
  assert.equal(after, null);
});
