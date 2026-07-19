// Parental-control gate on the PLAYBACK layer. items/search/recommend already
// hide adult titles from kids profiles behind a 404, but media_files and
// subtitles ids are small enumerable integers — so the routes that take them
// raw (/api/stream, /api/play/decision, /api/play/session, /api/subs) must
// apply the same content-rating rule with the same 404-never-403 shape, or a
// kids profile could simply play anything by counting upwards. Covers both
// the shared helpers (src/server/playback/access.ts) and the actual route
// handlers, driven with real signed session tokens. Isolated temp data +
// media dirs, like playback.test.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "flix-kidsplay-data-"));
const tmpMedia = fs.mkdtempSync(path.join(os.tmpdir(), "flix-kidsplay-media-"));
process.env.FLIX_DATA_DIR = tmpData;
process.env.FLIX_MEDIA_DIR = tmpMedia;
process.on("exit", () => {
  try {
    fs.rmSync(tmpData, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  try {
    fs.rmSync(tmpMedia, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Modules under test are loaded in before() — same CJS-compatibility pattern
// as playback.test.ts (node --test transpiles this file to CJS via tsx).
let getDb: typeof import("../src/server/db").getDb;
let Access: typeof import("../src/server/playback/access");
let Auth: typeof import("../src/server/auth");
let streamGET: typeof import("../src/app/api/stream/[fileId]/route").GET;
let subsGET: typeof import("../src/app/api/subs/[id]/route").GET;
let decisionPOST: typeof import("../src/app/api/play/decision/route").POST;
let sessionPOST: typeof import("../src/app/api/play/session/route").POST;
let libraryGET: typeof import("../src/app/api/library/route").GET;
let statePOST: typeof import("../src/app/api/state/route").POST;

let kidToken = "";
let adultToken = "";

before(async () => {
  ({ getDb } = await import("../src/server/db"));
  Access = await import("../src/server/playback/access");
  Auth = await import("../src/server/auth");
  ({ GET: streamGET } = await import("../src/app/api/stream/[fileId]/route"));
  ({ GET: subsGET } = await import("../src/app/api/subs/[id]/route"));
  ({ POST: decisionPOST } = await import("../src/app/api/play/decision/route"));
  ({ POST: sessionPOST } = await import("../src/app/api/play/session/route"));
  ({ GET: libraryGET } = await import("../src/app/api/library/route"));
  ({ POST: statePOST } = await import("../src/app/api/state/route"));

  const kid = Auth.createUser("kidprofile", "password123", { isKids: true });
  const adult = Auth.createUser("adultprofile", "password123");
  if (!kid.ok || !kid.id || !adult.ok || !adult.id) throw new Error("failed to create test profiles");
  kidToken = Auth.createSessionToken(kid.id);
  adultToken = Auth.createSessionToken(adult.id);
});

// The library route's ensureLibraryReady() spins up the auto-rescan watcher;
// its fs.watch handle would keep the test process alive forever — same
// teardown watcher.test.ts does after every case.
after(async () => {
  const { stopWatcher } = await import("../src/server/library/watcher");
  stopWatcher();
});

type DB = ReturnType<typeof getDb>;

const KID = { is_kids: 1 };
const ADULT = { is_kids: 0 };

let counter = 0;

/** Movie + media file (optionally with a real file on disk so the stream
 *  route can actually serve bytes). Returns the media_files id. */
function insertMovieFile(db: DB, contentRating: string | null, opts: { realFile?: boolean; withStreams?: boolean } = {}): number {
  counter++;
  const folder = `Gate Movie ${counter}`;
  const movieId = Number(
    db.prepare("INSERT INTO movies (title, sort_title, folder, content_rating, added_at) VALUES (?, ?, ?, ?, ?)").run(folder, folder, folder, contentRating, Date.now()).lastInsertRowid,
  );
  const rel = path.join(folder, `Gate Movie ${counter}.mp4`);
  if (opts.realFile) {
    fs.mkdirSync(path.join(tmpMedia, folder), { recursive: true });
    fs.writeFileSync(path.join(tmpMedia, rel), "not-really-an-mp4-but-bytes-are-bytes");
  }
  const fileId = Number(
    db.prepare("INSERT INTO media_files (movie_id, filepath, size, mtime, duration, probed_at, images_at, added_at) VALUES (?, ?, 0, 0, 120, 1, 0, ?)").run(movieId, rel, Date.now()).lastInsertRowid,
  );
  if (opts.withStreams) {
    db.prepare(
      "INSERT INTO streams (media_file_id, stream_index, type, codec, profile, level, width, height, bit_depth, hdr_format, is_default, is_forced, attached_pic) VALUES (?, 0, 'video', 'h264', 'High', 40, 1920, 1080, 8, 'SDR', 0, 0, 0)",
    ).run(fileId);
    db.prepare("INSERT INTO streams (media_file_id, stream_index, type, codec, channels, is_default, is_forced, attached_pic) VALUES (?, 1, 'audio', 'aac', 2, 1, 0, 0)").run(fileId);
  }
  return fileId;
}

/** Show → season → episode → media file; the rating lives on the SHOW, which
 *  is exactly the join the gate has to walk. Returns the media_files id. */
function insertEpisodeFile(db: DB, showRating: string | null): number {
  counter++;
  const folder = `Gate Show ${counter}`;
  const showId = Number(
    db.prepare("INSERT INTO shows (title, sort_title, folder, content_rating, added_at) VALUES (?, ?, ?, ?, ?)").run(folder, folder, folder, showRating, Date.now()).lastInsertRowid,
  );
  const seasonId = Number(db.prepare("INSERT INTO seasons (show_id, season_number) VALUES (?, 1)").run(showId).lastInsertRowid);
  const episodeId = Number(db.prepare("INSERT INTO episodes (show_id, season_id, episode_number, added_at) VALUES (?, ?, 1, ?)").run(showId, seasonId, Date.now()).lastInsertRowid);
  return Number(
    db
      .prepare("INSERT INTO media_files (episode_id, filepath, size, mtime, duration, probed_at, images_at, added_at) VALUES (?, ?, 0, 0, 42, 1, 0, ?)")
      .run(episodeId, path.join(folder, "S01E01.mkv"), Date.now()).lastInsertRowid,
  );
}

/** External .srt sidecar subtitle for a file, written for real on disk (the
 *  subs route converts it to VTT). Returns the subtitles id. */
function insertExternalSrt(db: DB, fileId: number): number {
  counter++;
  const abs = path.join(tmpMedia, `gate-sub-${counter}.srt`);
  fs.writeFileSync(abs, "1\n00:00:01,000 --> 00:00:02,000\nBonjour\n");
  return Number(
    db.prepare("INSERT INTO subtitles (media_file_id, stream_index, source, external_path, format, is_forced, is_sdh, is_text) VALUES (?, NULL, 'external', ?, 'subrip', 0, 0, 1)").run(fileId, abs)
      .lastInsertRowid,
  );
}

function authed(url: string, token: string, init: RequestInit = {}): Request {
  return new Request(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
}

const CAPS = { containers: ["mp4"], video: [{ codec: "h264", profiles: ["high", "main", "baseline"], maxLevel: 51, bitDepth: 8 }], audio: ["aac"], maxWidth: 1920, maxHeight: 1080, hdr: false };

// ============================================================================
// Shared helpers (access.ts)
// ============================================================================

test("isFileAllowedForUser: adult-rated movie is hidden from kids, visible to everyone else", () => {
  const db = getDb();
  const fileId = insertMovieFile(db, "R");
  assert.equal(Access.isFileAllowedForUser(KID, fileId), false);
  assert.equal(Access.isFileAllowedForUser(ADULT, fileId), true);
});

test("isFileAllowedForUser: kid-safe and unrated movies stay playable for kids (fail-open, like the catalogue)", () => {
  const db = getDb();
  assert.equal(Access.isFileAllowedForUser(KID, insertMovieFile(db, "PG")), true);
  assert.equal(Access.isFileAllowedForUser(KID, insertMovieFile(db, null)), true);
});

test("isFileAllowedForUser: an episode inherits its SHOW's rating through the episode→show join", () => {
  const db = getDb();
  assert.equal(Access.isFileAllowedForUser(KID, insertEpisodeFile(db, "TV-MA")), false);
  assert.equal(Access.isFileAllowedForUser(KID, insertEpisodeFile(db, "TV-Y")), true);
});

test("isFileAllowedForUser: a missing fileId is allowed through — the route's own lookup 404s identically", () => {
  assert.equal(Access.isFileAllowedForUser(KID, 999_999), true);
});

test("isSubtitleAllowedForUser: follows the subtitle to its file's parent item", () => {
  const db = getDb();
  const adultSub = insertExternalSrt(db, insertMovieFile(db, "TV-MA"));
  const safeSub = insertExternalSrt(db, insertMovieFile(db, "G"));
  assert.equal(Access.isSubtitleAllowedForUser(KID, adultSub), false);
  assert.equal(Access.isSubtitleAllowedForUser(ADULT, adultSub), true);
  assert.equal(Access.isSubtitleAllowedForUser(KID, safeSub), true);
  assert.equal(Access.isSubtitleAllowedForUser(KID, 999_999), true);
});

// ============================================================================
// Route handlers — the 404 must be indistinguishable from "doesn't exist"
// ============================================================================

test("GET /api/stream/<id>: kids profile gets 404 for an adult title, adult profile streams it", async () => {
  const db = getDb();
  const fileId = insertMovieFile(db, "R", { realFile: true });
  const ctx = { params: Promise.resolve({ fileId: String(fileId) }) };

  const kidRes = await streamGET(authed(`http://localhost:4247/api/stream/${fileId}`, kidToken) as Parameters<typeof streamGET>[0], ctx);
  assert.equal(kidRes.status, 404);

  const adultRes = await streamGET(authed(`http://localhost:4247/api/stream/${fileId}`, adultToken) as Parameters<typeof streamGET>[0], ctx);
  assert.equal(adultRes.status, 200);
  assert.ok(adultRes.headers.get("etag"), "stream responses must carry cache validators");
  assert.ok(adultRes.headers.get("last-modified"));
  await adultRes.body?.cancel();
});

test("POST /api/play/decision: kids profile gets the same 404 as an unknown fileId", async () => {
  const db = getDb();
  const fileId = insertMovieFile(db, "TV-MA", { withStreams: true });
  const post = (token: string) =>
    decisionPOST(
      authed("http://localhost:4247/api/play/decision", token, {
        method: "POST",
        body: JSON.stringify({ fileId, caps: CAPS }),
      }),
    );

  const kidRes = await post(kidToken);
  assert.equal(kidRes.status, 404);
  const kidBody = (await kidRes.json()) as { error?: string };
  assert.equal(kidBody.error, "Fichier introuvable"); // byte-identical to the unknown-id response

  const adultRes = await post(adultToken);
  assert.equal(adultRes.status, 200);
  const adultBody = (await adultRes.json()) as { mode?: string };
  assert.equal(adultBody.mode, "direct");
});

test("POST /api/play/session: kids profile gets 404, adult profile gets its direct-play session", async () => {
  const db = getDb();
  const fileId = insertMovieFile(db, "NC-17", { withStreams: true });
  const post = (token: string) =>
    sessionPOST(
      authed("http://localhost:4247/api/play/session", token, {
        method: "POST",
        body: JSON.stringify({ fileId, caps: CAPS, deviceId: "kids-gate-test" }),
      }),
    );

  const kidRes = await post(kidToken);
  assert.equal(kidRes.status, 404);

  const adultRes = await post(adultToken);
  assert.equal(adultRes.status, 200);
  const adultBody = (await adultRes.json()) as { mode?: string };
  assert.equal(adultBody.mode, "direct"); // fully supported file -> no session/ffmpeg needed
});

test("GET /api/subs/<id>: kids profile gets 404 for an adult title's subtitle, adult profile gets the VTT", async () => {
  const db = getDb();
  const subId = insertExternalSrt(db, insertMovieFile(db, "R"));
  const ctx = { params: Promise.resolve({ id: String(subId) }) };

  const kidRes = await subsGET(authed(`http://localhost:4247/api/subs/${subId}`, kidToken), ctx);
  assert.equal(kidRes.status, 404);

  const adultRes = await subsGET(authed(`http://localhost:4247/api/subs/${subId}`, adultToken), ctx);
  assert.equal(adultRes.status, 200);
  assert.match(await adultRes.text(), /^WEBVTT/);
  assert.match(adultRes.headers.get("cache-control") ?? "", /private/); // per-profile response — never shared-cacheable
});

// ============================================================================
// Catalogue + state mutations — the gate must hold on the LIST and WRITE paths
// too, not just playback (a kids profile reading /api/library raw, or probing
// POST /api/state, must learn nothing the 404s above are hiding).
// ============================================================================

test("GET /api/library: kids profile gets a filtered catalogue, adjusted counts and a distinct ETag", async () => {
  const db = getDb();
  insertMovieFile(db, "R");
  insertMovieFile(db, "G");
  insertEpisodeFile(db, "TV-MA");
  insertEpisodeFile(db, "TV-Y");

  type Body = { movies: { contentRating: string | null }[]; shows: { contentRating: string | null }[]; countMovies: number; countShows: number };
  const adultRes = await libraryGET(authed("http://localhost:4247/api/library", adultToken));
  assert.equal(adultRes.status, 200);
  const adultBody = (await adultRes.json()) as Body;
  const kidRes = await libraryGET(authed("http://localhost:4247/api/library", kidToken));
  assert.equal(kidRes.status, 200);
  const kidBody = (await kidRes.json()) as Body;

  assert.ok(adultBody.movies.some((m) => m.contentRating === "R"), "adult profile must see the adult movie");
  assert.ok(!kidBody.movies.some((m) => m.contentRating === "R"), "kids profile must not see the adult movie");
  assert.ok(kidBody.movies.some((m) => m.contentRating === "G"), "kids profile keeps kid-safe titles");
  assert.ok(!kidBody.shows.some((s) => s.contentRating === "TV-MA"));
  assert.ok(kidBody.shows.some((s) => s.contentRating === "TV-Y"));
  // Counts must follow the filtered lists — a bigger count would announce how
  // many titles were hidden.
  assert.equal(kidBody.countMovies, kidBody.movies.length);
  assert.equal(kidBody.countShows, kidBody.shows.length);
  assert.ok(kidBody.countMovies < adultBody.countMovies);
  // The weak validator differs per profile kind, so a kid 304 can never
  // validate an adult body cached by an intermediary (or the same browser
  // after a profile switch).
  assert.ok(adultRes.headers.get("etag"));
  assert.notEqual(kidRes.headers.get("etag"), adultRes.headers.get("etag"));
});

test("POST /api/state: kids mutations on an adult title return the exact unknown-id 404 (no existence oracle)", async () => {
  const db = getDb();
  const movieIdOf = (fileId: number) => (db.prepare("SELECT movie_id AS id FROM media_files WHERE id = ?").get(fileId) as { id: number }).id;
  const adultId = movieIdOf(insertMovieFile(db, "R"));
  const safeId = movieIdOf(insertMovieFile(db, "PG"));

  const post = (token: string, payload: unknown) =>
    statePOST(authed("http://localhost:4247/api/state", token, { method: "POST", body: JSON.stringify(payload) }));

  // The canonical body every mutation returns for an id that doesn't exist…
  const unknown = await post(kidToken, { kind: "myList", itemType: "movie", itemId: 999_999, add: true });
  assert.equal(unknown.status, 404);
  const unknownBody = await unknown.text();

  // …must be byte-identical to the refusal on an existing adult title.
  const denied = await post(kidToken, { kind: "myList", itemType: "movie", itemId: adultId, add: true });
  assert.equal(denied.status, 404);
  assert.equal(await denied.text(), unknownBody);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM my_list WHERE item_type = 'movie' AND item_id = ?").get(adultId) as { n: number }).n, 0, "the refused write must not land");

  // Every kind is gated, not just myList.
  assert.equal((await post(kidToken, { kind: "rating", itemType: "movie", itemId: adultId, value: 1 })).status, 404);
  assert.equal((await post(kidToken, { kind: "setWatched", itemType: "movie", itemId: adultId, watched: true })).status, 404);
  assert.equal((await post(kidToken, { kind: "progress", itemType: "movie", itemId: adultId, position: 10, duration: 100 })).status, 404);
  assert.equal((await post(kidToken, { kind: "watchEvent", itemType: "movie", itemId: adultId, eventKind: "complete", ratio: 1, seconds: 100 })).status, 404);
  assert.equal((await post(kidToken, { kind: "dismissProgress", itemType: "movie", itemId: adultId })).status, 404);

  // An episode inherits its show's rating through the episode→show join.
  const adultEpId = (db.prepare("SELECT episode_id AS id FROM media_files WHERE id = ?").get(insertEpisodeFile(db, "TV-MA")) as { id: number }).id;
  assert.equal((await post(kidToken, { kind: "progress", itemType: "episode", itemId: adultEpId, position: 5, duration: 42 })).status, 404);

  // Kid-safe titles stay writable for kids; adult profiles are never gated.
  assert.equal((await post(kidToken, { kind: "myList", itemType: "movie", itemId: safeId, add: true })).status, 200);
  assert.equal((await post(adultToken, { kind: "myList", itemType: "movie", itemId: adultId, add: true })).status, 200);
});

// Kept LAST: it deliberately exhausts the per-client rate-limit bucket, which
// is process-wide state shared with every other subs request in this file.
test("GET /api/subs/<id>: request bursts beyond the window cap are rejected with 429", async () => {
  const db = getDb();
  const subId = insertExternalSrt(db, insertMovieFile(db, null));
  const ctx = { params: Promise.resolve({ id: String(subId) }) };
  let sawTooMany = false;
  for (let i = 0; i < 70 && !sawTooMany; i++) {
    const res = await subsGET(authed(`http://localhost:4247/api/subs/${subId}`, adultToken), ctx);
    if (res.status === 429) sawTooMany = true;
    else await res.body?.cancel();
  }
  assert.equal(sawTooMany, true, "expected the sliding-window limiter to kick in within the burst");
});
