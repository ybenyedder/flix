// getMovieDetail/getShowDetail: quality-badge aggregation and the path-free
// file label — real DB round-trip, isolated temp data dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flix-repo-items-test-"));
process.env.FLIX_DATA_DIR = tmp;
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test("getMovieDetail exposes quality (tallest video stream + HDR) and a path-free file label", async () => {
  const { getDb } = await import("../src/server/db");
  const { getMovieDetail } = await import("../src/server/library/repository");
  const db = getDb();

  const movieId = Number(
    db.prepare("INSERT INTO movies (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run("Dune", "dune", "/media/Dune (2021)", Date.now())
      .lastInsertRowid,
  );
  const fileId = Number(
    db
      .prepare("INSERT INTO media_files (movie_id, filepath, size, mtime, container, duration) VALUES (?, ?, ?, ?, ?, ?)")
      .run(movieId, "/media/Dune (2021)/Dune (2021) 2160p HDR10.mkv", 1000, Date.now(), "mkv", 9300).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO streams (media_file_id, stream_index, type, codec, height, hdr_format, is_default) VALUES (?, 0, 'video', 'hevc', 2160, 'HDR10', 1)",
  ).run(fileId);

  const detail = getMovieDetail(movieId);
  assert.ok(detail);
  assert.equal(detail?.quality.height, 2160);
  assert.equal(detail?.quality.hdr, true);
  assert.equal(detail?.files.length, 1);
  assert.equal(detail?.files[0].label, "Dune (2021) 2160p HDR10");
});

test("getMovieDetail returns null for an unknown id", async () => {
  const { getMovieDetail } = await import("../src/server/library/repository");
  assert.equal(getMovieDetail(999999), null);
});

test("getShowDetail nests seasons/episodes and attaches per-episode files", async () => {
  const { getDb } = await import("../src/server/db");
  const { getShowDetail } = await import("../src/server/library/repository");
  const db = getDb();

  const showId = Number(
    db.prepare("INSERT INTO shows (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run("Dark", "dark", "/media/Dark", Date.now()).lastInsertRowid,
  );
  const seasonId = Number(db.prepare("INSERT INTO seasons (show_id, season_number) VALUES (?, ?)").run(showId, 1).lastInsertRowid);
  const episodeId = Number(
    db
      .prepare("INSERT INTO episodes (show_id, season_id, episode_number, title, duration) VALUES (?, ?, ?, ?, ?)")
      .run(showId, seasonId, 1, "Secrets", 3000).lastInsertRowid,
  );
  db.prepare("INSERT INTO media_files (episode_id, filepath, size, mtime, container, duration) VALUES (?, ?, ?, ?, ?, ?)").run(
    episodeId,
    "/media/Dark/Season 01/Dark S01E01.mkv",
    500,
    Date.now(),
    "mkv",
    3000,
  );

  const detail = getShowDetail(showId);
  assert.ok(detail);
  assert.equal(detail?.seasons.length, 1);
  assert.equal(detail?.seasons[0].episodes.length, 1);
  assert.equal(detail?.seasons[0].episodes[0].files.length, 1);
  assert.equal(detail?.seasons[0].episodes[0].files[0].label, "Dark S01E01");
});

// The stream/subtitle hydration is batched (one IN (...) query per child
// table for all files of an item) — these tests pin down that the batched
// path yields exactly the per-file result: right rows on the right file,
// stream_index / insertion order preserved, nothing leaked across files.

test("getMovieDetail batching: each file gets its own streams and subtitles, ordered", async () => {
  const { getDb } = await import("../src/server/db");
  const { getMovieDetail } = await import("../src/server/library/repository");
  const db = getDb();

  const movieId = Number(
    db
      .prepare("INSERT INTO movies (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)")
      .run("Blade Runner", "blade runner", "/media/Blade Runner (1982)", Date.now()).lastInsertRowid,
  );
  const insFile = db.prepare("INSERT INTO media_files (movie_id, filepath, size, mtime, container, duration) VALUES (?, ?, ?, ?, ?, ?)");
  const fileA = Number(insFile.run(movieId, "/media/Blade Runner (1982)/Blade Runner (1982) 2160p.mkv", 2000, Date.now(), "mkv", 7000).lastInsertRowid);
  const fileB = Number(insFile.run(movieId, "/media/Blade Runner (1982)/Blade Runner (1982) 1080p.mp4", 1000, Date.now(), "mp4", 7000).lastInsertRowid);

  const insStream = db.prepare("INSERT INTO streams (media_file_id, stream_index, type, codec, height, hdr_format) VALUES (?, ?, ?, ?, ?, ?)");
  // fileA streams inserted OUT of stream_index order — the result must come back ordered
  insStream.run(fileA, 1, "audio", "truehd", null, null);
  insStream.run(fileA, 0, "video", "hevc", 2160, "HDR10");
  insStream.run(fileB, 0, "video", "h264", 1080, null);

  db.prepare("INSERT INTO subtitles (media_file_id, stream_index, source, language, format) VALUES (?, 2, 'embedded', 'eng', 'subrip')").run(fileA);
  db.prepare("INSERT INTO subtitles (media_file_id, source, external_path, language, format) VALUES (?, 'external', '/media/x.srt', 'fre', 'srt')").run(fileB);

  const detail = getMovieDetail(movieId);
  assert.ok(detail);
  assert.equal(detail?.files.length, 2);

  const [a, b] = detail.files; // ORDER BY id — fileA first
  assert.equal(a.id, fileA);
  assert.deepEqual(a.streams.map((s) => s.codec), ["hevc", "truehd"]); // re-ordered by stream_index
  assert.equal(a.subtitles.length, 1);
  assert.equal(a.subtitles[0].language, "eng");
  assert.equal(a.subtitles[0].source, "embedded");
  assert.equal(b.id, fileB);
  assert.deepEqual(b.streams.map((s) => s.codec), ["h264"]);
  assert.equal(b.subtitles.length, 1);
  assert.equal(b.subtitles[0].language, "fre");
  assert.equal(b.subtitles[0].source, "external");

  // Quality maps are memoised on the library version — this movie was added
  // AFTER earlier detail reads populated the cache, so a correct badge here
  // also proves the cache invalidated instead of serving the stale maps.
  assert.equal(detail?.quality.height, 2160);
  assert.equal(detail?.quality.hdr, true);
});

test("getShowDetail batching: streams/subtitles never leak across episode files", async () => {
  const { getDb } = await import("../src/server/db");
  const { getShowDetail } = await import("../src/server/library/repository");
  const db = getDb();

  const showId = Number(
    db.prepare("INSERT INTO shows (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run("Severance", "severance", "/media/Severance", Date.now())
      .lastInsertRowid,
  );
  const seasonId = Number(db.prepare("INSERT INTO seasons (show_id, season_number) VALUES (?, ?)").run(showId, 1).lastInsertRowid);
  const insEpisode = db.prepare("INSERT INTO episodes (show_id, season_id, episode_number, title) VALUES (?, ?, ?, ?)");
  const ep1 = Number(insEpisode.run(showId, seasonId, 1, "Good News About Hell").lastInsertRowid);
  const ep2 = Number(insEpisode.run(showId, seasonId, 2, "Half Loop").lastInsertRowid);

  const insFile = db.prepare("INSERT INTO media_files (episode_id, filepath, size, mtime) VALUES (?, ?, ?, ?)");
  const file1 = Number(insFile.run(ep1, "/media/Severance/Season 01/Severance S01E01.mkv", 100, Date.now()).lastInsertRowid);
  const file2 = Number(insFile.run(ep2, "/media/Severance/Season 01/Severance S01E02.mkv", 100, Date.now()).lastInsertRowid);

  const insStream = db.prepare("INSERT INTO streams (media_file_id, stream_index, type, codec, height) VALUES (?, ?, ?, ?, ?)");
  insStream.run(file1, 0, "video", "h264", 1080);
  insStream.run(file2, 0, "video", "hevc", 2160);
  db.prepare("INSERT INTO subtitles (media_file_id, source, external_path, language, format) VALUES (?, 'external', '/media/e2.srt', 'ger', 'srt')").run(file2);

  const detail = getShowDetail(showId);
  assert.ok(detail);
  const episodes = detail.seasons[0].episodes;
  assert.equal(episodes.length, 2);

  const [d1, d2] = episodes;
  assert.equal(d1.files[0].id, file1);
  assert.deepEqual(d1.files[0].streams.map((s) => s.codec), ["h264"]);
  assert.equal(d1.files[0].subtitles.length, 0); // ep2's subtitle must not bleed onto ep1
  assert.equal(d2.files[0].id, file2);
  assert.deepEqual(d2.files[0].streams.map((s) => s.codec), ["hevc"]);
  assert.equal(d2.files[0].subtitles.length, 1);
  assert.equal(d2.files[0].subtitles[0].language, "ger");

  assert.equal(detail?.quality.height, 2160);
});
