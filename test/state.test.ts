// Per-profile state (my list/ratings/progress): the pure watched-threshold
// helper, a real-DB round-trip through userState.ts scoped per user and
// rejecting references to items that don't exist, plus route-level validation
// of POST /api/state (kind checked first, position clamped to duration, a
// foreign mediaFileId ignored). Isolated temp data dir, same pattern as
// auth.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flix-state-test-"));
process.env.FLIX_DATA_DIR = tmp;
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test("computeWatched flags watched at the 92% threshold", async () => {
  const { computeWatched } = await import("../src/server/state/userState");
  assert.equal(computeWatched(0, 0), false);
  assert.equal(computeWatched(91, 100), false);
  assert.equal(computeWatched(92, 100), true);
  assert.equal(computeWatched(100, 100), true);
});

test("toggleMyList/setRating/setProgress round-trip through getUserState, scoped per user and rejecting unknown items", async () => {
  const { getDb } = await import("../src/server/db");
  const { getUserState, toggleMyList, setRating, setProgress } = await import("../src/server/state/userState");
  const db = getDb();

  const movieId = Number(
    db.prepare("INSERT INTO movies (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run("Test Movie", "test movie", "/tmp/x", Date.now()).lastInsertRowid,
  );
  const showId = Number(
    db.prepare("INSERT INTO shows (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run("Test Show", "test show", "/tmp/y", Date.now()).lastInsertRowid,
  );
  const seasonId = Number(db.prepare("INSERT INTO seasons (show_id, season_number) VALUES (?, ?)").run(showId, 1).lastInsertRowid);
  const episodeId = Number(
    db
      .prepare("INSERT INTO episodes (show_id, season_id, episode_number, title, duration) VALUES (?, ?, ?, ?, ?)")
      .run(showId, seasonId, 1, "Pilot", 1200).lastInsertRowid,
  );

  const userA = 1;
  const userB = 2;

  assert.equal(toggleMyList(userA, "movie", 999999, true).ok, false);

  assert.equal(toggleMyList(userA, "movie", movieId, true).ok, true);
  assert.equal(toggleMyList(userA, "show", showId, true).ok, true);
  assert.equal(setRating(userA, "movie", movieId, 2).ok, true);
  assert.equal(setProgress(userA, "episode", episodeId, 600, 1200, null).ok, true);

  const stateA = getUserState(userA);
  assert.equal(stateA.myList.length, 2);
  assert.equal(stateA.ratings.length, 1);
  assert.equal(stateA.ratings[0].value, 2);
  assert.equal(stateA.progress.length, 1);
  assert.equal(stateA.progress[0].topType, "show");
  assert.equal(stateA.progress[0].topId, showId);
  assert.equal(stateA.progress[0].subtitle, "S1 : É1 — Pilot");
  assert.equal(stateA.progress[0].watched, false);

  const stateB = getUserState(userB);
  assert.equal(stateB.myList.length, 0);

  assert.equal(toggleMyList(userA, "movie", movieId, false).ok, true);
  assert.equal(getUserState(userA).myList.length, 1);

  assert.equal(setRating(userA, "movie", movieId, 0).ok, true);
  assert.equal(getUserState(userA).ratings.length, 0);

  assert.equal(setProgress(userA, "episode", episodeId, 1150, 1200, null).ok, true);
  assert.equal(getUserState(userA).progress[0].watched, true);

  assert.equal(setProgress(userA, "episode", 999999, 10, 100, null).ok, false);
});

test("recordWatchEvent: resolves top_type/top_id (movie credits itself, episode credits its show), rejects unknown items", async () => {
  const { getDb } = await import("../src/server/db");
  const { recordWatchEvent } = await import("../src/server/state/userState");
  const db = getDb();

  const movieId = Number(
    db.prepare("INSERT INTO movies (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run("Watch Movie", "watch movie", "/tmp/wm", Date.now()).lastInsertRowid,
  );
  const showId = Number(
    db.prepare("INSERT INTO shows (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run("Watch Show", "watch show", "/tmp/ws", Date.now()).lastInsertRowid,
  );
  const seasonId = Number(db.prepare("INSERT INTO seasons (show_id, season_number) VALUES (?, ?)").run(showId, 1).lastInsertRowid);
  const episodeId = Number(
    db.prepare("INSERT INTO episodes (show_id, season_id, episode_number, title, duration) VALUES (?, ?, ?, ?, ?)").run(showId, seasonId, 1, "Pilot", 1200).lastInsertRowid,
  );

  const userId = 99;
  assert.equal(recordWatchEvent(userId, "movie", movieId, "complete", 0.95, 1140).ok, true);
  assert.equal(recordWatchEvent(userId, "episode", episodeId, "abandon", 0.05, 130).ok, true);
  assert.equal(recordWatchEvent(userId, "movie", 999999, "complete", 1, 100).ok, false);
  assert.equal(recordWatchEvent(userId, "episode", 999999, "abandon", 0, 100).ok, false);

  const rows = db.prepare("SELECT item_type, top_type, top_id, kind, ratio, seconds FROM watch_events WHERE user_id = ? ORDER BY item_type").all(userId) as {
    item_type: string;
    top_type: string;
    top_id: number;
    kind: string;
    ratio: number;
    seconds: number;
  }[];
  assert.equal(rows.length, 2);
  const episodeEvent = rows.find((r) => r.item_type === "episode");
  const movieEvent = rows.find((r) => r.item_type === "movie");
  assert.equal(movieEvent?.top_type, "movie");
  assert.equal(movieEvent?.top_id, movieId);
  assert.equal(movieEvent?.kind, "complete");
  assert.equal(episodeEvent?.top_type, "show");
  assert.equal(episodeEvent?.top_id, showId); // denormalised to the SHOW, not the episode
  assert.equal(episodeEvent?.kind, "abandon");
  assert.equal(episodeEvent?.seconds, 130);
});

test("POST /api/state: kind is validated before itemId, position is clamped to duration, a foreign mediaFileId is ignored", async () => {
  const { getDb } = await import("../src/server/db");
  const { ensureAuth, createUser, getUserByName, createSessionToken } = await import("../src/server/auth");
  const { POST } = await import("../src/app/api/state/route");
  const db = getDb();

  // A real authenticated user — the bearer token also exempts the route from
  // the CSRF origin check (token clients aren't a CSRF vector).
  ensureAuth();
  assert.equal(createUser("stateuser", "statepass123").ok, true);
  const user = getUserByName("stateuser");
  assert.ok(user);
  const token = createSessionToken(user.id);
  const post = (body: unknown) =>
    POST(
      new Request("http://localhost:4247/api/state", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  // Unknown/missing kind → "kind invalide" even when itemId is absent too (the
  // discriminator is validated first, not hidden behind an itemId complaint).
  const noKind = await post({});
  assert.equal(noKind.status, 400);
  assert.equal((await noKind.json()).error, "kind invalide");
  const badKind = await post({ kind: "bogus", itemId: 1 });
  assert.equal(badKind.status, 400);
  assert.equal((await badKind.json()).error, "kind invalide");
  // Valid kind but no itemId → the itemId complaint.
  const noItem = await post({ kind: "myList", itemType: "movie" });
  assert.equal(noItem.status, 400);
  assert.equal((await noItem.json()).error, "itemId invalide");

  const movieA = Number(
    db.prepare("INSERT INTO movies (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run("Route Movie A", "route movie a", "/tmp/ra", Date.now()).lastInsertRowid,
  );
  const movieB = Number(
    db.prepare("INSERT INTO movies (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run("Route Movie B", "route movie b", "/tmp/rb", Date.now()).lastInsertRowid,
  );
  const fileA = Number(db.prepare("INSERT INTO media_files (movie_id, filepath, size, mtime) VALUES (?, ?, ?, ?)").run(movieA, "/tmp/ra/a.mkv", 1000, 0).lastInsertRowid);
  const fileB = Number(db.prepare("INSERT INTO media_files (movie_id, filepath, size, mtime) VALUES (?, ?, ?, ?)").run(movieB, "/tmp/rb/b.mkv", 1000, 0).lastInsertRowid);

  const progressRow = () =>
    db.prepare("SELECT position, duration, media_file_id FROM progress WHERE user_id = ? AND item_type = 'movie' AND item_id = ?").get(user.id, movieA) as {
      position: number;
      duration: number;
      media_file_id: number | null;
    };

  // position > duration → clamped to duration, never persisted past the end.
  const clamped = await post({ kind: "progress", itemType: "movie", itemId: movieA, position: 5000, duration: 600, mediaFileId: fileA });
  assert.equal(clamped.status, 200);
  assert.equal(progressRow().position, 600);
  assert.equal(progressRow().media_file_id, fileA); // fileA belongs to movieA → persisted

  // A mediaFileId belonging to ANOTHER item is ignored (progress still saved).
  const foreign = await post({ kind: "progress", itemType: "movie", itemId: movieA, position: 100, duration: 600, mediaFileId: fileB });
  assert.equal(foreign.status, 200);
  assert.equal(progressRow().position, 100);
  assert.equal(progressRow().media_file_id, null);
});

test("recordWatchEvent: clamps ratio and seconds into sane bounds", async () => {
  const { getDb } = await import("../src/server/db");
  const { recordWatchEvent } = await import("../src/server/state/userState");
  const db = getDb();

  const movieId = Number(
    db.prepare("INSERT INTO movies (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run("Clamp Movie", "clamp movie", "/tmp/cm", Date.now()).lastInsertRowid,
  );
  const userId = 100;
  assert.equal(recordWatchEvent(userId, "movie", movieId, "complete", 5, -10).ok, true);
  const row = db.prepare("SELECT ratio, seconds FROM watch_events WHERE user_id = ?").get(userId) as { ratio: number; seconds: number };
  assert.equal(row.ratio, 1);
  assert.equal(row.seconds, 0);
});

test("setWatched(movie): forces the 92%-style state, emits one complete event per transition, non-vu erases the row", async () => {
  const { getDb } = await import("../src/server/db");
  const { setWatched, getUserState } = await import("../src/server/state/userState");
  const db = getDb();

  const movieId = Number(
    db.prepare("INSERT INTO movies (title, sort_title, duration, folder, added_at) VALUES (?, ?, ?, ?, ?)").run("Seen Movie", "seen movie", 6000, "/tmp/sm", Date.now()).lastInsertRowid,
  );
  const userId = 200;

  assert.equal(setWatched(userId, "movie", 999999, true).ok, false);

  assert.equal(setWatched(userId, "movie", movieId, true).ok, true);
  const row = db.prepare("SELECT position, duration, watched, dismissed FROM progress WHERE user_id = ? AND item_type = 'movie' AND item_id = ?").get(userId, movieId) as {
    position: number;
    duration: number;
    watched: number;
    dismissed: number;
  };
  assert.equal(row.watched, 1);
  assert.equal(row.position, 6000); // position = duration, like a real full viewing
  assert.equal(row.duration, 6000);
  assert.equal(row.dismissed, 0);
  assert.equal(getUserState(userId).progress[0].watched, true);

  // One "complete" watch event on the unwatched -> watched transition; a
  // second setWatched(true) must NOT stack another one.
  const eventCount = () =>
    Number((db.prepare("SELECT COUNT(*) AS n FROM watch_events WHERE user_id = ? AND kind = 'complete'").get(userId) as { n: number }).n);
  assert.equal(eventCount(), 1);
  assert.equal(setWatched(userId, "movie", movieId, true).ok, true);
  assert.equal(eventCount(), 1);

  // "Non vu" erases progression + flag (the historical event stays).
  assert.equal(setWatched(userId, "movie", movieId, false).ok, true);
  assert.equal(db.prepare("SELECT 1 FROM progress WHERE user_id = ? AND item_type = 'movie' AND item_id = ?").get(userId, movieId), undefined);
  assert.equal(getUserState(userId).progress.length, 0);
  assert.equal(eventCount(), 1);
});

test("setWatched(show): fans out to every indexed episode, and back to none", async () => {
  const { getDb } = await import("../src/server/db");
  const { setWatched, getUserState } = await import("../src/server/state/userState");
  const db = getDb();

  const showId = Number(
    db.prepare("INSERT INTO shows (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run("Seen Show", "seen show", "/tmp/ss", Date.now()).lastInsertRowid,
  );
  const s1 = Number(db.prepare("INSERT INTO seasons (show_id, season_number) VALUES (?, 1)").run(showId).lastInsertRowid);
  const s2 = Number(db.prepare("INSERT INTO seasons (show_id, season_number) VALUES (?, 2)").run(showId).lastInsertRowid);
  const episodeIds = [
    [s1, 1, 1500],
    [s1, 2, 1500],
    [s2, 1, 0], // unknown duration — still flagged watched, position stays 0
  ].map(([seasonId, num, duration]) =>
    Number(db.prepare("INSERT INTO episodes (show_id, season_id, episode_number, duration) VALUES (?, ?, ?, ?)").run(showId, seasonId, num, duration).lastInsertRowid),
  );
  const userId = 201;

  assert.equal(setWatched(userId, "show", 999999, true).ok, false);

  assert.equal(setWatched(userId, "show", showId, true).ok, true);
  const rows = db
    .prepare("SELECT item_id, position, duration, watched FROM progress WHERE user_id = ? AND item_type = 'episode' ORDER BY item_id")
    .all(userId) as { item_id: number; position: number; duration: number; watched: number }[];
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.item_id),
    [...episodeIds].sort((a, b) => a - b),
  );
  for (const r of rows) {
    assert.equal(r.watched, 1);
    assert.equal(r.position, r.duration);
  }
  // Every event is denormalised onto the SHOW for the reco engine.
  const tops = db.prepare("SELECT DISTINCT top_type, top_id FROM watch_events WHERE user_id = ?").all(userId) as { top_type: string; top_id: number }[];
  assert.deepEqual(tops, [{ top_type: "show", top_id: showId }]);

  assert.equal(setWatched(userId, "show", showId, false).ok, true);
  assert.equal(getUserState(userId).progress.length, 0);
});

test("dismissProgress: hides the entry from Continue Watching, keeps the position, and a new progress write brings it back", async () => {
  const { getDb } = await import("../src/server/db");
  const { setProgress, dismissProgress, getUserState } = await import("../src/server/state/userState");
  const db = getDb();

  const movieId = Number(
    db.prepare("INSERT INTO movies (title, sort_title, duration, folder, added_at) VALUES (?, ?, ?, ?, ?)").run("CW Movie", "cw movie", 600, "/tmp/cw", Date.now()).lastInsertRowid,
  );
  const userId = 202;

  // Nothing to dismiss yet.
  assert.equal(dismissProgress(userId, "movie", movieId).ok, false);

  assert.equal(setProgress(userId, "movie", movieId, 300, 600, null).ok, true);

  // The Continue Watching row keeps every summary matching this predicate
  // (see HomeView) — the exact contract dismissProgress works against.
  const inContinueWatching = () =>
    getUserState(userId).progress.some((p) => p.itemId === movieId && p.duration > 0 && p.position > 5 && p.position / p.duration < 0.92);

  assert.equal(inContinueWatching(), true);

  assert.equal(dismissProgress(userId, "movie", movieId).ok, true);
  assert.equal(inContinueWatching(), false);

  // Dismissed, not destroyed: flag set, position/duration intact in the DB,
  // and the summary still exposes the position so resume keeps working.
  const dbRow = db.prepare("SELECT position, duration, dismissed FROM progress WHERE user_id = ? AND item_type = 'movie' AND item_id = ?").get(userId, movieId) as {
    position: number;
    duration: number;
    dismissed: number;
  };
  assert.equal(dbRow.dismissed, 1);
  assert.equal(dbRow.position, 300);
  assert.equal(dbRow.duration, 600);
  const summary = getUserState(userId).progress.find((p) => p.itemId === movieId);
  assert.ok(summary);
  assert.equal(summary.dismissed, true);
  assert.equal(summary.position, 300);

  // A new playback progress write resets the flag — the entry reappears.
  assert.equal(setProgress(userId, "movie", movieId, 350, 600, null).ok, true);
  assert.equal(inContinueWatching(), true);
  const refreshed = getUserState(userId).progress.find((p) => p.itemId === movieId);
  assert.equal(refreshed?.dismissed, false);
  assert.equal(refreshed?.duration, 600);
});

test("POST /api/state: setWatched and dismissProgress validate their payloads and mutate through the route", async () => {
  const { getDb } = await import("../src/server/db");
  const { ensureAuth, createUser, getUserByName, createSessionToken } = await import("../src/server/auth");
  const { POST } = await import("../src/app/api/state/route");
  const db = getDb();

  ensureAuth();
  assert.equal(createUser("watcheduser", "watchedpass123").ok, true);
  const user = getUserByName("watcheduser");
  assert.ok(user);
  const token = createSessionToken(user.id);
  const post = (body: unknown) =>
    POST(
      new Request("http://localhost:4247/api/state", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const movieId = Number(
    db.prepare("INSERT INTO movies (title, sort_title, duration, folder, added_at) VALUES (?, ?, ?, ?, ?)").run("Route Seen", "route seen", 500, "/tmp/rs", Date.now()).lastInsertRowid,
  );

  // watched must be a real boolean, and dismissProgress only accepts
  // progress-level item types (movie|episode — not show).
  const badWatched = await post({ kind: "setWatched", itemType: "movie", itemId: movieId, watched: "yes" });
  assert.equal(badWatched.status, 400);
  assert.equal((await badWatched.json()).error, "watched invalide");
  const badDismiss = await post({ kind: "dismissProgress", itemType: "show", itemId: movieId });
  assert.equal(badDismiss.status, 400);
  assert.equal((await badDismiss.json()).error, "itemType invalide");

  const markSeen = await post({ kind: "setWatched", itemType: "movie", itemId: movieId, watched: true });
  assert.equal(markSeen.status, 200);
  const row = () =>
    db.prepare("SELECT watched, dismissed FROM progress WHERE user_id = ? AND item_type = 'movie' AND item_id = ?").get(user.id, movieId) as
      | { watched: number; dismissed: number }
      | undefined;
  assert.equal(row()?.watched, 1);

  const dismissed = await post({ kind: "dismissProgress", itemType: "movie", itemId: movieId });
  assert.equal(dismissed.status, 200);
  assert.equal(row()?.dismissed, 1);

  const unseen = await post({ kind: "setWatched", itemType: "movie", itemId: movieId, watched: false });
  assert.equal(unseen.status, 200);
  assert.equal(row(), undefined);

  const missingDismiss = await post({ kind: "dismissProgress", itemType: "movie", itemId: movieId });
  assert.equal(missingDismiss.status, 404);
});
