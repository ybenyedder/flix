// Migration runner upgrade path. A fresh database lands on the latest
// user_version with the v2 subtitles index and the v3 progress.dismissed
// column in place, and an existing older database (simulated by dropping the
// index/column and rewinding user_version) gets exactly the appended
// migrations replayed on the next open.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flix-migrations-test-"));
process.env.FLIX_DATA_DIR = tmp;
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const LATEST_VERSION = 5;

function hasDismissedColumn(db: InstanceType<typeof Database>): boolean {
  const columns = db.prepare("PRAGMA table_info(progress)").all() as { name: string }[];
  return columns.some((c) => c.name === "dismissed");
}

function hasArrRequestsTable(db: InstanceType<typeof Database>): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'arr_requests'").get();
}

function hasArrStallColumns(db: InstanceType<typeof Database>): boolean {
  const columns = db.prepare("PRAGMA table_info(arr_requests)").all() as { name: string }[];
  return columns.some((c) => c.name === "stalled_since") && columns.some((c) => c.name === "quality_fallback");
}

test("fresh database reaches the latest version with the v2 index, v3 dismissed column, v4 arr_requests table and v5 stall columns", async () => {
  const { getDb } = await import("../src/server/db");
  const db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), LATEST_VERSION);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_subtitles_file'").get();
  assert.ok(idx, "idx_subtitles_file should exist on a fresh database");
  assert.ok(hasDismissedColumn(db), "progress.dismissed should exist on a fresh database");
  assert.ok(hasArrRequestsTable(db), "arr_requests should exist on a fresh database");
  assert.ok(hasArrStallColumns(db), "arr_requests stall columns should exist on a fresh database");
});

test("re-opening an up-to-date database is a no-op (BEGIN IMMEDIATE + in-transaction version re-check path)", async () => {
  const { getDb, closeDb } = await import("../src/server/db");
  getDb();
  closeDb();

  // A second open must re-run migrate() harmlessly: no duplicate-column error
  // from replaying the v3 ALTER TABLE, version unchanged. This exercises the
  // guarded path sequentially; the true two-process race it protects against
  // (both reading a stale user_version before either commits) additionally
  // relies on the in-transaction re-read after BEGIN IMMEDIATE.
  const db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), LATEST_VERSION);
  assert.ok(hasDismissedColumn(db));
  closeDb();
});

test("an existing v1 database is upgraded in place on the next open", async () => {
  const { getDb, closeDb } = await import("../src/server/db");
  getDb();
  closeDb();

  // Rewind to the v1 state: no subtitles index, no dismissed column, and no
  // arr_requests table (it arrives in v4) so the appended v4/v5 migrations
  // replay cleanly. user_version = 1.
  const raw = new Database(path.join(tmp, "flix.db"));
  raw.exec("DROP INDEX IF EXISTS idx_subtitles_file");
  raw.exec("ALTER TABLE progress DROP COLUMN dismissed");
  raw.exec("DROP TABLE IF EXISTS arr_requests");
  raw.pragma("user_version = 1");
  raw.close();

  const db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), LATEST_VERSION);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_subtitles_file'").get();
  assert.ok(idx, "idx_subtitles_file should be recreated by the replayed v2 migration");
  assert.ok(hasDismissedColumn(db), "progress.dismissed should be recreated by the replayed v3 migration");
  assert.ok(hasArrStallColumns(db), "arr_requests stall columns should be created by the replayed v4/v5 migrations");
});

test("an existing v2 database gets only the appended v3 migration, keeping data", async () => {
  const { getDb, closeDb } = await import("../src/server/db");
  getDb();
  closeDb();

  // Rewind to the v2 state: index present, dismissed column absent, no
  // arr_requests table yet (it's a v4 addition), plus one progress row that must
  // survive the ALTER TABLE and default to dismissed=0.
  const raw = new Database(path.join(tmp, "flix.db"));
  raw.exec("ALTER TABLE progress DROP COLUMN dismissed");
  raw.exec("DROP TABLE IF EXISTS arr_requests");
  raw.prepare("INSERT INTO progress (user_id, item_type, item_id, position, duration, watched, updated_at) VALUES (1, 'movie', 42, 300, 600, 0, 1)").run();
  raw.pragma("user_version = 2");
  raw.close();

  const db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), LATEST_VERSION);
  assert.ok(hasDismissedColumn(db));
  const row = db.prepare("SELECT position, dismissed FROM progress WHERE user_id = 1 AND item_type = 'movie' AND item_id = 42").get() as {
    position: number;
    dismissed: number;
  };
  assert.equal(row.position, 300);
  assert.equal(row.dismissed, 0);
  db.prepare("DELETE FROM progress WHERE user_id = 1 AND item_type = 'movie' AND item_id = 42").run();
});
