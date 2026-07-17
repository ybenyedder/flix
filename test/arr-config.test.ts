// *arr configuration & gate (src/server/arr/config.ts + client.ts): the enable
// flag, per-service URL/key resolution with SQLite-over-file precedence, tolerant
// parsing, the boot-time opt-in consumption, and that the outbound client refuses
// to touch the network while disabled/unconfigured. Isolated temp data dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flix-arr-config-test-"));
process.env.FLIX_DATA_DIR = tmp;
delete process.env.FLIX_ARR_SETUP;
delete process.env.FLIX_ARR_SERVICES_FILE;
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function config() {
  return import("../src/server/arr/config");
}

function clearArrSettings(db: import("better-sqlite3").Database) {
  db.prepare("DELETE FROM settings WHERE key LIKE 'arr.%'").run();
}

test("enable/dismiss flags round-trip; enabling implies the banner is dismissed", async () => {
  const { getDb } = await import("../src/server/db");
  const { isArrEnabled, isArrDecided, isArrDismissed, setArrEnabled, setArrDismissed } = await config();
  clearArrSettings(getDb());

  assert.equal(isArrDecided(), false);
  assert.equal(isArrEnabled(), false);

  setArrDismissed(false);
  assert.equal(isArrDismissed(), false);

  setArrEnabled(true);
  assert.equal(isArrEnabled(), true);
  assert.equal(isArrDecided(), true);
  assert.equal(isArrDismissed(), true); // enabling resolves the nudge

  setArrEnabled(false);
  assert.equal(isArrEnabled(), false);
  assert.equal(isArrDecided(), true); // still decided
});

test("normalizeServiceUrl: http/https only, trailing slash stripped", async () => {
  const { normalizeServiceUrl } = await config();
  assert.equal(normalizeServiceUrl("http://radarr:7878/"), "http://radarr:7878");
  assert.equal(normalizeServiceUrl("https://radarr.example/base/"), "https://radarr.example/base");
  assert.equal(normalizeServiceUrl("  http://x:1 "), "http://x:1");
  assert.equal(normalizeServiceUrl("ftp://x"), null);
  assert.equal(normalizeServiceUrl("not a url"), null);
  assert.equal(normalizeServiceUrl(""), null);
  assert.equal(normalizeServiceUrl(null), null);
});

test("getServiceConfig: manual (SQLite) overrides auto (arr-services.json); clearing falls back", async () => {
  const { getDb } = await import("../src/server/db");
  const { getServiceConfig, setServiceConfig, __resetArrInit } = await config();
  clearArrSettings(getDb());

  // Auto layer written by the init container.
  fs.writeFileSync(
    path.join(tmp, "arr-services.json"),
    JSON.stringify({ version: 1, services: { sonarr: { url: "http://sonarr:8989/", apiKey: "AUTOKEY" } } }),
  );
  __resetArrInit(); // drop the mtime memo

  let sonarr = getServiceConfig("sonarr");
  assert.deepEqual(sonarr, { url: "http://sonarr:8989", apiKey: "AUTOKEY", source: "auto" });

  // Manual override wins.
  assert.equal(setServiceConfig("sonarr", { url: "http://manual:8989", apiKey: "MANUALKEY" }).ok, true);
  sonarr = getServiceConfig("sonarr");
  assert.deepEqual(sonarr, { url: "http://manual:8989", apiKey: "MANUALKEY", source: "manual" });

  // Clearing the manual values falls back to auto.
  assert.equal(setServiceConfig("sonarr", { url: "", apiKey: "" }).ok, true);
  assert.equal(getServiceConfig("sonarr")?.source, "auto");

  // A bad manual URL is rejected.
  assert.equal(setServiceConfig("radarr", { url: "ftp://nope" }).ok, false);

  // An unconfigured service resolves to null.
  assert.equal(getServiceConfig("prowlarr"), null);
});

test("getServiceConfig: a corrupt arr-services.json degrades to null, never throws", async () => {
  const { getDb } = await import("../src/server/db");
  const { getServiceConfig, __resetArrInit } = await config();
  clearArrSettings(getDb());
  fs.writeFileSync(path.join(tmp, "arr-services.json"), "{ this is not json");
  __resetArrInit();
  assert.equal(getServiceConfig("sonarr"), null);
});

test("initArr: consumes the launch answer ONLY when undecided", async () => {
  const { getDb } = await import("../src/server/db");
  const { initArr, isArrEnabled, isArrDecided, __resetArrInit } = await config();

  // Undecided + FLIX_ARR_SETUP=1 → enabled.
  clearArrSettings(getDb());
  process.env.FLIX_ARR_SETUP = "1";
  __resetArrInit();
  initArr();
  assert.equal(isArrEnabled(), true);

  // Already decided (disabled) + env says yes → stays disabled (not re-consumed).
  clearArrSettings(getDb());
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('arr.enabled', '0')").run();
  assert.equal(isArrDecided(), true);
  process.env.FLIX_ARR_SETUP = "1";
  __resetArrInit();
  initArr();
  assert.equal(isArrEnabled(), false);
  delete process.env.FLIX_ARR_SETUP;

  // Undecided + host-settings arrPromptAnswer:"yes" → enabled.
  clearArrSettings(getDb());
  fs.writeFileSync(path.join(tmp, "host-settings.json"), JSON.stringify({ arrPromptAnswer: "yes" }));
  __resetArrInit();
  initArr();
  assert.equal(isArrEnabled(), true);
  fs.rmSync(path.join(tmp, "host-settings.json"), { force: true });
});

test("arrFetch: throws without any network call when disabled or unconfigured", async () => {
  const { getDb } = await import("../src/server/db");
  const { setArrEnabled, __resetArrInit } = await config();
  const { arrFetch, ArrError } = await import("../src/server/arr/client");
  clearArrSettings(getDb());
  __resetArrInit();

  // Disabled → refuse.
  setArrEnabled(false);
  await assert.rejects(() => arrFetch("radarr", "/api/v3/system/status"), (e) => e instanceof ArrError);

  // Enabled but unconfigured → still refuse before any fetch.
  setArrEnabled(true);
  fs.rmSync(path.join(tmp, "arr-services.json"), { force: true });
  __resetArrInit();
  await assert.rejects(() => arrFetch("radarr", "/api/v3/system/status"), (e) => e instanceof ArrError && /configuré/.test(e.message));
});

test("arrFetch: GETs get one automatic retry on timeout, POSTs never do", async () => {
  const { getDb } = await import("../src/server/db");
  const { setArrEnabled, setServiceConfig, __resetArrInit } = await config();
  const { arrFetch, ArrError } = await import("../src/server/arr/client");
  clearArrSettings(getDb());
  __resetArrInit();
  setArrEnabled(true);
  const set = setServiceConfig("radarr", { url: "http://radarr.test:7878", apiKey: "k" });
  assert.equal(set.ok, true);

  const realFetch = globalThis.fetch;
  let calls = 0;
  const timeoutError = () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    return err;
  };
  try {
    // First attempt times out, the automatic retry succeeds — the caller never
    // sees « n'a pas répondu à temps » for a one-off hiccup.
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw timeoutError();
      return new Response(JSON.stringify({ version: "5.0" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const out = await arrFetch<{ version: string }>("radarr", "/api/v3/system/status");
    assert.equal(out.version, "5.0");
    assert.equal(calls, 2);

    // A POST is never replayed (it could double-add an entity).
    calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw timeoutError();
    }) as typeof fetch;
    await assert.rejects(
      () => arrFetch("radarr", "/api/v3/movie", { method: "POST", body: {} }),
      (e) => e instanceof ArrError && /répondu à temps/.test((e as Error).message),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
