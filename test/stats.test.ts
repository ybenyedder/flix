// « Mon activité » statistics: the pure window/genre aggregation helpers, the
// full getUserStats round-trip against a real temp DB (synthetic watch_events
// + progress rows, per-user scoping, stale-item handling in the history), and
// the GET /api/stats route contract (auth + cache headers). Isolated temp data
// dir, same pattern as state.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flix-stats-test-"));
process.env.FLIX_DATA_DIR = tmp;
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const DAY_MS = 86_400_000;

test("aggregateWatchTime: 7d/30d/total windows, negative seconds never subtract", async () => {
  const { aggregateWatchTime } = await import("../src/server/state/stats");
  const now = Date.now();
  const totals = aggregateWatchTime(
    [
      { seconds: 3600, createdAt: now - 1 * DAY_MS }, // in 7d, 30d, total
      { seconds: 1800, createdAt: now - 10 * DAY_MS }, // in 30d, total
      { seconds: 3000, createdAt: now - 40 * DAY_MS }, // total only
      { seconds: -500, createdAt: now - 1 * DAY_MS }, // hostile row — clamped to 0
    ],
    now,
  );
  assert.equal(totals.seconds7d, 3600);
  assert.equal(totals.seconds30d, 5400);
  assert.equal(totals.secondsTotal, 8400);

  const empty = aggregateWatchTime([], now);
  assert.deepEqual(empty, { seconds7d: 0, seconds30d: 0, secondsTotal: 0 });
});

test("parseGenres tolerates NULL, malformed JSON and non-string junk", async () => {
  const { parseGenres } = await import("../src/server/state/stats");
  assert.deepEqual(parseGenres(null), []);
  assert.deepEqual(parseGenres("not json"), []);
  assert.deepEqual(parseGenres('{"a":1}'), []);
  assert.deepEqual(parseGenres('["Action", 42, "", "Drame"]'), ["Action", "Drame"]);
});

test("aggregateTopGenres: seconds-weighted, deterministic tie-break, top-5 truncation, zero-time spans skipped", async () => {
  const { aggregateTopGenres } = await import("../src/server/state/stats");

  const stats = aggregateTopGenres([
    { genres: '["Action","Drame"]', seconds: 3600 },
    { genres: '["Drame"]', seconds: 1800 },
    { genres: '["Comédie"]', seconds: 3600 }, // ties with Action → alphabetical
    { genres: '["Horreur"]', seconds: 0 }, // no time — never appears
  ]);
  assert.deepEqual(stats, [
    { genre: "Drame", seconds: 5400 },
    { genre: "Action", seconds: 3600 },
    { genre: "Comédie", seconds: 3600 },
  ]);

  const six = aggregateTopGenres(
    ["A", "B", "C", "D", "E", "F"].map((g, i) => ({ genres: JSON.stringify([g]), seconds: (i + 1) * 60 })),
  );
  assert.equal(six.length, 5);
  assert.equal(six[0].genre, "F"); // most watched first
  assert.ok(!six.some((s) => s.genre === "A")); // sixth genre truncated
});

test("getUserStats: end-to-end aggregation over a real DB, scoped per user, stale items dropped from history only", async () => {
  const { getDb } = await import("../src/server/db");
  const { getUserStats, HISTORY_LIMIT } = await import("../src/server/state/stats");
  const db = getDb();
  const now = Date.now();

  const movieId = Number(
    db
      .prepare("INSERT INTO movies (title, sort_title, genres, folder, added_at) VALUES (?, ?, ?, ?, ?)")
      .run("Heat", "heat", '["Action","Drame"]', "/tmp/heat", now).lastInsertRowid,
  );
  const showId = Number(
    db
      .prepare("INSERT INTO shows (title, sort_title, genres, folder, added_at) VALUES (?, ?, ?, ?, ?)")
      .run("Dark", "dark", '["Drame"]', "/tmp/dark", now).lastInsertRowid,
  );
  const seasonId = Number(db.prepare("INSERT INTO seasons (show_id, season_number) VALUES (?, 1)").run(showId).lastInsertRowid);
  const episodeId = Number(
    db
      .prepare("INSERT INTO episodes (show_id, season_id, episode_number, title, duration) VALUES (?, ?, 2, 'Mensonges', 2700)")
      .run(showId, seasonId).lastInsertRowid,
  );

  const userId = 42;
  const insertEvent = db.prepare(
    "INSERT INTO watch_events (user_id, item_type, item_id, top_type, top_id, kind, ratio, seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertEvent.run(userId, "movie", movieId, "movie", movieId, "complete", 1, 3600, now - 1 * DAY_MS);
  insertEvent.run(userId, "episode", episodeId, "show", showId, "abandon", 0.3, 1800, now - 10 * DAY_MS);
  insertEvent.run(userId, "movie", movieId, "movie", movieId, "complete", 1, 3000, now - 40 * DAY_MS);
  // Event pointing at a since-deleted title: time still counts, history drops it.
  insertEvent.run(userId, "movie", 999999, "movie", 999999, "complete", 1, 100, now - 2 * DAY_MS);
  // Another profile's event must never leak in.
  insertEvent.run(7, "movie", movieId, "movie", movieId, "complete", 1, 9999, now);

  // Currently-watched titles (completedTitles reads the live progress table).
  const insertProgress = db.prepare(
    "INSERT INTO progress (user_id, item_type, item_id, position, duration, watched, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insertProgress.run(userId, "movie", movieId, 6000, 6000, 1, now);
  insertProgress.run(userId, "episode", episodeId, 2700, 2700, 1, now);
  insertProgress.run(userId, "episode", 12345, 60, 2700, 0, now); // in progress — not counted
  insertProgress.run(7, "movie", movieId, 6000, 6000, 1, now); // other profile

  const stats = getUserStats(userId, now);

  assert.equal(stats.seconds7d, 3600 + 100);
  assert.equal(stats.seconds30d, 3600 + 100 + 1800);
  assert.equal(stats.secondsTotal, 3600 + 100 + 1800 + 3000);
  assert.equal(stats.completedTitles, 2);

  // Action gets the two movie completions; Drame those plus the episode abandon.
  assert.deepEqual(stats.topGenres, [
    { genre: "Drame", seconds: 3600 + 3000 + 1800 },
    { genre: "Action", seconds: 3600 + 3000 },
  ]);

  // History: newest first, stale item skipped, episode subtitle resolved.
  assert.ok(stats.history.length <= HISTORY_LIMIT);
  assert.deepEqual(
    stats.history.map((h) => h.title),
    ["Heat", "Dark", "Heat"],
  );
  assert.equal(stats.history[0].kind, "complete");
  assert.equal(stats.history[0].subtitle, null);
  assert.equal(stats.history[1].kind, "abandon");
  assert.equal(stats.history[1].itemType, "episode");
  assert.equal(stats.history[1].subtitle, "S1 : É2 — Mensonges");
  assert.equal(stats.history[1].topType, "show");
  assert.equal(stats.history[1].topId, showId);

  // Per-user scoping: the other profile only sees its own event.
  const other = getUserStats(7, now);
  assert.equal(other.secondsTotal, 9999);
  assert.equal(other.completedTitles, 1);
  assert.equal(other.history.length, 1);
});

test("GET /api/stats: 401 unauthenticated, 200 with private no-cache for a profile's own stats", async () => {
  const { getDb } = await import("../src/server/db");
  const { ensureAuth, createUser, getUserByName, createSessionToken } = await import("../src/server/auth");
  const { GET } = await import("../src/app/api/stats/route");
  const db = getDb();

  const anonymous = await GET(new Request("http://localhost:4247/api/stats"));
  assert.equal(anonymous.status, 401);

  ensureAuth();
  assert.equal(createUser("statsuser", "statspass123").ok, true);
  const user = getUserByName("statsuser");
  assert.ok(user);
  const token = createSessionToken(user.id);

  const movieId = Number(
    db
      .prepare("INSERT INTO movies (title, sort_title, genres, folder, added_at) VALUES (?, ?, ?, ?, ?)")
      .run("Route Stats Movie", "route stats movie", '["Comédie"]', "/tmp/rsm", Date.now()).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO watch_events (user_id, item_type, item_id, top_type, top_id, kind, ratio, seconds, created_at) VALUES (?, 'movie', ?, 'movie', ?, 'complete', 1, 1200, ?)",
  ).run(user.id, movieId, movieId, Date.now());

  const res = await GET(new Request("http://localhost:4247/api/stats", { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-cache");
  const body = (await res.json()) as {
    seconds7d: number;
    secondsTotal: number;
    completedTitles: number;
    topGenres: { genre: string; seconds: number }[];
    history: { title: string; kind: string }[];
  };
  assert.equal(body.seconds7d, 1200);
  assert.equal(body.secondsTotal, 1200);
  assert.deepEqual(body.topGenres, [{ genre: "Comédie", seconds: 1200 }]);
  assert.equal(body.history.length, 1);
  assert.equal(body.history[0].title, "Route Stats Movie");
});
