// Per-profile settings (user_settings): strict validation of the playback
// language preferences (2-3 lowercase letters, "off" allowed for subtitles
// only as a semantic value), read-side tolerance of corrupted rows, per-user
// isolation, and the /api/settings route (auth, CSRF-exempt bearer,
// validation, `private, no-cache`). Isolated temp data dir, same pattern as
// state.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flix-settings-test-"));
process.env.FLIX_DATA_DIR = tmp;
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test("setPlaybackPrefs/getPlaybackPrefs: round-trip, strict validation, partial updates, null clears", async () => {
  const { setPlaybackPrefs, getPlaybackPrefs } = await import("../src/server/state/settings");
  const userId = 1;

  assert.deepEqual(getPlaybackPrefs(userId), { audioLang: null, subtitleLang: null });

  assert.equal(setPlaybackPrefs(userId, { audioLang: "fra", subtitleLang: "eng" }).ok, true);
  assert.deepEqual(getPlaybackPrefs(userId), { audioLang: "fra", subtitleLang: "eng" });

  // Subtitles may be explicitly « Désactivés ».
  assert.equal(setPlaybackPrefs(userId, { subtitleLang: "off" }).ok, true);
  assert.deepEqual(getPlaybackPrefs(userId), { audioLang: "fra", subtitleLang: "off" });

  // 2-letter codes are valid too (external subtitle sidecars are tagged "fr").
  assert.equal(setPlaybackPrefs(userId, { audioLang: "fr" }).ok, true);

  // Strict rejects: uppercase, wrong length, non-letters, wrong types.
  for (const bad of ["FR", "fren", "f", "fr1", "fr-FR", "", 42, true, {}, []]) {
    const r = setPlaybackPrefs(userId, { audioLang: bad });
    assert.equal(r.ok, false, `audioLang ${JSON.stringify(bad)} doit être rejeté`);
    assert.equal(r.error, "audioLang invalide");
  }
  for (const bad of ["OFF", "offf", "désactivés", 0, false]) {
    const r = setPlaybackPrefs(userId, { subtitleLang: bad });
    assert.equal(r.ok, false, `subtitleLang ${JSON.stringify(bad)} doit être rejeté`);
    assert.equal(r.error, "subtitleLang invalide");
  }
  // One invalid field rejects the whole write — the valid one isn't applied.
  assert.equal(setPlaybackPrefs(userId, { audioLang: "ita", subtitleLang: "NOPE" }).ok, false);
  // Nothing was clobbered by any of the rejected writes.
  assert.deepEqual(getPlaybackPrefs(userId), { audioLang: "fr", subtitleLang: "off" });

  // undefined leaves a key untouched; null clears it (row deleted).
  assert.equal(setPlaybackPrefs(userId, { audioLang: null }).ok, true);
  assert.deepEqual(getPlaybackPrefs(userId), { audioLang: null, subtitleLang: "off" });
  assert.equal(setPlaybackPrefs(userId, {}).ok, true);
  assert.deepEqual(getPlaybackPrefs(userId), { audioLang: null, subtitleLang: "off" });
});

test("user settings are scoped per profile", async () => {
  const { setPlaybackPrefs, getPlaybackPrefs } = await import("../src/server/state/settings");
  assert.equal(setPlaybackPrefs(11, { audioLang: "jpn" }).ok, true);
  assert.deepEqual(getPlaybackPrefs(11).audioLang, "jpn");
  assert.deepEqual(getPlaybackPrefs(12), { audioLang: null, subtitleLang: null });
});

test("getPlaybackPrefs: a corrupted/hand-edited row degrades to no preference, never a crash", async () => {
  const { getDb } = await import("../src/server/db");
  const { getPlaybackPrefs, PREF_AUDIO_LANG, PREF_SUBTITLE_LANG } = await import("../src/server/state/settings");
  const db = getDb();
  db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)").run(9, PREF_AUDIO_LANG, "FRENCH!");
  db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)").run(9, PREF_SUBTITLE_LANG, null);
  assert.deepEqual(getPlaybackPrefs(9), { audioLang: null, subtitleLang: null });
});

test("GET/POST /api/settings: auth required, validation enforced, private no-cache, partial updates", async () => {
  const { ensureAuth, createUser, getUserByName, createSessionToken } = await import("../src/server/auth");
  const { GET, POST } = await import("../src/app/api/settings/route");

  ensureAuth();
  assert.equal(createUser("prefuser", "prefpass123").ok, true);
  const user = getUserByName("prefuser");
  assert.ok(user);
  const token = createSessionToken(user.id);

  // No credentials → 401 on both verbs.
  assert.equal((await GET(new Request("http://localhost:4247/api/settings"))).status, 401);
  assert.equal(
    (
      await POST(
        new Request("http://localhost:4247/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:4247", host: "localhost:4247" },
          body: JSON.stringify({ audioLang: "fra" }),
        }),
      )
    ).status,
    401,
  );

  const get = () => GET(new Request("http://localhost:4247/api/settings", { headers: { authorization: `Bearer ${token}` } }));
  const post = (body: unknown) =>
    POST(
      new Request("http://localhost:4247/api/settings", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const initial = await get();
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "private, no-cache");
  assert.deepEqual(await initial.json(), { audioLang: null, subtitleLang: null });

  const bad = await post({ audioLang: "FRENCH" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "audioLang invalide");

  const set = await post({ audioLang: "fra", subtitleLang: "off" });
  assert.equal(set.status, 200);
  assert.equal(set.headers.get("cache-control"), "private, no-cache");
  assert.deepEqual(await set.json(), { audioLang: "fra", subtitleLang: "off" });

  // Partial update: the untouched key survives.
  const partial = await post({ subtitleLang: "eng" });
  assert.equal(partial.status, 200);
  assert.deepEqual(await partial.json(), { audioLang: "fra", subtitleLang: "eng" });
  assert.deepEqual(await (await get()).json(), { audioLang: "fra", subtitleLang: "eng" });
});
