// Automatic-rescan watcher: the pure event filter and debounce contract, the
// persisted `library.autoScan` toggle (default ON), hot start/stop through
// syncWatcher, and the /api/admin/settings route (admin gate, validation,
// toggle applied without restart). Isolated temp data dir + temp media dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flix-watcher-test-"));
const mediaDir = path.join(tmp, "media");
fs.mkdirSync(mediaDir, { recursive: true });
process.env.FLIX_DATA_DIR = path.join(tmp, "data");
process.env.FLIX_MEDIA_DIR = mediaDir;
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("isIgnoredEvent: hidden files, DB/WAL side-files and download temps are ignored; videos and NFOs are not", async () => {
  const { isIgnoredEvent } = await import("../src/server/library/watcher");
  assert.equal(isIgnoredEvent(".hidden"), true);
  assert.equal(isIgnoredEvent("Films/.stversions/x.mkv"), true);
  assert.equal(isIgnoredEvent("flix.db"), true);
  assert.equal(isIgnoredEvent("flix.db-wal"), true);
  assert.equal(isIgnoredEvent("flix.db-shm"), true);
  assert.equal(isIgnoredEvent("download.mkv.part"), true);
  assert.equal(isIgnoredEvent("copy.tmp"), true);
  assert.equal(isIgnoredEvent("film.crdownload"), true);
  assert.equal(isIgnoredEvent("Films/Inception (2010)/inception.mkv"), false);
  assert.equal(isIgnoredEvent("Films/Inception (2010)/movie.nfo"), false); // NFO edits must trigger a rescan
  // Unknown target (platform gave no filename): play safe, do NOT ignore.
  assert.equal(isIgnoredEvent(null), false);
});

test("createDebounce: trailing-edge — many bumps collapse into one fire after the delay; cancel prevents it", async () => {
  const { createDebounce } = await import("../src/server/library/watcher");

  let fired = 0;
  const d = createDebounce(50, () => {
    fired += 1;
  });
  assert.equal(d.pending(), false);
  d.bump();
  await sleep(20);
  d.bump(); // re-arms: the fire happens 50ms after THIS bump
  assert.equal(d.pending(), true);
  await sleep(35);
  assert.equal(fired, 0); // first bump's deadline passed but was superseded
  await sleep(40);
  assert.equal(fired, 1);
  assert.equal(d.pending(), false);

  d.bump();
  d.cancel();
  await sleep(70);
  assert.equal(fired, 1); // cancelled — never fired again
});

test("autoScan toggle persists in the settings table and defaults to ON", async () => {
  const { getDb } = await import("../src/server/db");
  const { getAutoScan, setAutoScan, AUTO_SCAN_KEY, stopWatcher } = await import("../src/server/library/watcher");
  const db = getDb();

  assert.equal(db.prepare("SELECT value FROM settings WHERE key = ?").get(AUTO_SCAN_KEY), undefined);
  assert.equal(getAutoScan(), true); // no row yet → default ON

  setAutoScan(false);
  assert.equal(getAutoScan(), false);
  assert.deepEqual(db.prepare("SELECT value FROM settings WHERE key = ?").get(AUTO_SCAN_KEY), { value: "0" });

  setAutoScan(true);
  assert.equal(getAutoScan(), true);
  assert.deepEqual(db.prepare("SELECT value FROM settings WHERE key = ?").get(AUTO_SCAN_KEY), { value: "1" });

  stopWatcher();
});

test("syncWatcher starts watching the media dir when enabled and stops hot when disabled", async () => {
  const { setAutoScan, syncWatcher, getWatcherStatus, stopWatcher } = await import("../src/server/library/watcher");

  setAutoScan(true);
  syncWatcher();
  const active = getWatcherStatus();
  assert.equal(active.autoScan, true);
  assert.equal(active.active, true); // Linux Node >= 20: recursive fs.watch supported
  assert.equal(active.dir, mediaDir);

  setAutoScan(false); // hot stop — no restart involved
  const stopped = getWatcherStatus();
  assert.equal(stopped.autoScan, false);
  assert.equal(stopped.active, false);
  assert.equal(stopped.dir, null);

  stopWatcher();
});

test("a stopped watcher (fs.watch error path) is re-armed by the NEXT scan even for the same root", async () => {
  const { setAutoScan, syncWatcher, getWatcherStatus, stopWatcher } = await import("../src/server/library/watcher");
  const { updateScanProgress } = await import("../src/server/library/scanner");

  setAutoScan(true);
  syncWatcher();
  assert.equal(getWatcherStatus().active, true);

  // A scan reports this root — the subscription memorises it as the last seen.
  updateScanProgress({ root: mediaDir });

  // Simulate the fs.watch error handler (ENOSPC, unmounted dir): it calls
  // stopWatcher(). Before the fix this left the memorised root in place, so a
  // later scan on the SAME root never re-armed the watcher.
  stopWatcher();
  assert.equal(getWatcherStatus().active, false);

  // Next scan emits the same root → must re-arm.
  updateScanProgress({ root: mediaDir });
  assert.equal(getWatcherStatus().active, true);

  setAutoScan(false);
  stopWatcher();
});

test("/api/admin/settings: admin-gated GET/POST, autoScan validated, toggle applied hot", async () => {
  const { ensureAuth, createUser, getUserByName, createSessionToken } = await import("../src/server/auth");
  const { GET, POST } = await import("../src/app/api/admin/settings/route");
  const { getWatcherStatus, stopWatcher } = await import("../src/server/library/watcher");

  ensureAuth();
  const admin = getUserByName("admin");
  assert.ok(admin);
  const adminToken = createSessionToken(admin.id);
  assert.equal(createUser("plainuser", "plainpass123").ok, true);
  const plain = getUserByName("plainuser");
  assert.ok(plain);
  const plainToken = createSessionToken(plain.id);

  const get = (token?: string) =>
    GET(new Request("http://localhost:4247/api/admin/settings", { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  const post = (token: string, body: unknown) =>
    POST(
      new Request("http://localhost:4247/api/admin/settings", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  assert.equal((await get()).status, 401);
  assert.equal((await get(plainToken)).status, 403);
  assert.equal((await post(plainToken, { autoScan: false })).status, 403);

  const ok = await get(adminToken);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const body = (await ok.json()) as { autoScan: boolean; watcherActive: boolean; config: Record<string, unknown> };
  assert.equal(typeof body.autoScan, "boolean");
  assert.equal(body.config.mediaDir, mediaDir);
  assert.equal(body.config.mediaDirExists, true);
  assert.equal(typeof body.config.port, "number");
  assert.equal(typeof body.config.dataDir, "string");
  assert.equal(typeof body.config.trickplay, "boolean");

  const invalid = await post(adminToken, { autoScan: "oui" });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "autoScan invalide");

  const enabled = await post(adminToken, { autoScan: true });
  assert.equal(enabled.status, 200);
  const enabledBody = (await enabled.json()) as { autoScan: boolean; watcherActive: boolean };
  assert.equal(enabledBody.autoScan, true);
  assert.equal(enabledBody.watcherActive, true);
  assert.equal(getWatcherStatus().active, true);

  const disabled = await post(adminToken, { autoScan: false });
  const disabledBody = (await disabled.json()) as { autoScan: boolean; watcherActive: boolean };
  assert.equal(disabledBody.autoScan, false);
  assert.equal(disabledBody.watcherActive, false);
  assert.equal(getWatcherStatus().active, false);

  stopWatcher();
});
