// Trickplay subsystem tests: the pure sprite-layout math (interval stretching,
// grid shape, aspect-derived tile height), the -vf chain builder, and — with a
// real tiny ffmpeg-generated clip, exactly like playback.test.ts — actual
// sprite generation, metadata lookup, mtime invalidation, stale-generation
// pruning and the FLIX_TRICKPLAY flag gate. Isolated temp data + media dirs.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "flix-trickplay-data-"));
const tmpMedia = fs.mkdtempSync(path.join(os.tmpdir(), "flix-trickplay-media-"));
process.env.FLIX_DATA_DIR = tmpData;
process.env.FLIX_MEDIA_DIR = tmpMedia;
process.env.FLIX_TRICKPLAY = "1";
process.on("exit", () => {
  for (const dir of [tmpData, tmpMedia]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// --- one tiny real H.264 clip (25s @ 25fps, 1s GOP) for the spawn tests -----
// 25s with a 10s sampling interval -> 3 tiles (t=0/10/20): a real multi-tile
// grid rather than the single-tile degenerate case.
const CLIP_SECONDS = 25;
const CLIP_REL = path.join("Trick Movie (2021)", "Trick Movie.mp4");
const CLIP_ABS = path.join(tmpMedia, CLIP_REL);
let CLIP_DURATION = CLIP_SECONDS;
{
  fs.mkdirSync(path.dirname(CLIP_ABS), { recursive: true });
  const gen = spawnSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", `testsrc=duration=${CLIP_SECONDS}:size=320x240:rate=25`, "-c:v", "libx264", "-g", "25", "-keyint_min", "25", "-pix_fmt", "yuv420p", "-loglevel", "error", CLIP_ABS],
    { stdio: "ignore" },
  );
  if (gen.status !== 0) throw new Error("failed to generate the test clip for trickplay tests — is ffmpeg installed?");
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", CLIP_ABS]);
  const parsed = Number(probe.stdout.toString("utf8").trim());
  if (Number.isFinite(parsed) && parsed > 0) CLIP_DURATION = parsed;
}

// Modules under test are loaded in before() (CJS-compatible, same pattern as
// playback.test.ts) so the env vars above are in force when config caches.
let getDb: typeof import("../src/server/db").getDb;
let resetConfigCache: typeof import("../src/server/config").resetConfigCache;
let Trickplay: typeof import("../src/server/library/trickplay");

before(async () => {
  ({ getDb } = await import("../src/server/db"));
  ({ resetConfigCache } = await import("../src/server/config"));
  Trickplay = await import("../src/server/library/trickplay");
});

const trickplayDir = () => path.join(tmpData, "cache", "trickplay");

let movieCounter = 0;
function insertClipRow(mtime = 1000): number {
  const db = getDb();
  movieCounter++;
  // media_files.filepath is UNIQUE — hardlink the one clip under fresh names.
  const rel = movieCounter === 1 ? CLIP_REL : path.join("Trick Movie (2021)", `Trick Movie ${movieCounter}.mp4`);
  const abs = path.join(tmpMedia, rel);
  if (!fs.existsSync(abs)) fs.linkSync(CLIP_ABS, abs);
  const movie = db.prepare("INSERT INTO movies (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run(`M${movieCounter}`, `M${movieCounter}`, `M${movieCounter}`, Date.now());
  const file = db
    .prepare("INSERT INTO media_files (movie_id, filepath, size, mtime, duration, probed_at, images_at, added_at) VALUES (?, ?, 0, ?, ?, 1, 1, ?)")
    .run(Number(movie.lastInsertRowid), rel, mtime, CLIP_DURATION, Date.now());
  const fileId = Number(file.lastInsertRowid);
  db.prepare(
    "INSERT INTO streams (media_file_id, stream_index, type, codec, width, height, is_default, is_forced, attached_pic) VALUES (?, 0, 'video', 'h264', 320, 240, 1, 0, 0)",
  ).run(fileId);
  return fileId;
}

// ============================================================================
// computeTrickplayLayout (pure)
// ============================================================================

test("computeTrickplayLayout: unknown duration -> null (nothing to sample)", () => {
  assert.equal(Trickplay.computeTrickplayLayout(0, 1920, 1080), null);
  assert.equal(Trickplay.computeTrickplayLayout(-3, 1920, 1080), null);
});

test("computeTrickplayLayout: a short clip gets one tile per 10s including t=0, columns capped at the tile count", () => {
  assert.deepEqual(Trickplay.computeTrickplayLayout(6, 320, 240), { interval: 10, cols: 1, rows: 1, count: 1, tileWidth: 320, tileHeight: 240 });
  assert.deepEqual(Trickplay.computeTrickplayLayout(25, 320, 240), { interval: 10, cols: 3, rows: 1, count: 3, tileWidth: 320, tileHeight: 240 });
});

test("computeTrickplayLayout: a feature film fills the fixed-column grid, 16:9 tiles from the source aspect", () => {
  const layout = Trickplay.computeTrickplayLayout(3600, 1920, 1080);
  assert.deepEqual(layout, { interval: 10, cols: 8, rows: 46, count: 361, tileWidth: 320, tileHeight: 180 });
});

test("computeTrickplayLayout: very long file stretches the interval instead of exceeding the tile cap", () => {
  const layout = Trickplay.computeTrickplayLayout(36_000, 1920, 1080);
  assert.ok(layout);
  assert.ok(layout.interval > 10, `interval should stretch, got ${layout.interval}`);
  assert.ok(layout.count <= Trickplay.TRICKPLAY_MAX_TILES);
  assert.equal(layout.rows, Math.ceil(layout.count / layout.cols));
});

test("computeTrickplayLayout: unknown source dimensions fall back to 16:9 tiles; odd ratios round to even pixels", () => {
  assert.equal(Trickplay.computeTrickplayLayout(60, null, null)?.tileHeight, 180);
  assert.equal(Trickplay.computeTrickplayLayout(60, 1440, 1080)?.tileHeight, 240);
  assert.equal(Trickplay.computeTrickplayLayout(60, 720, 576)?.tileHeight, 256);
});

// ============================================================================
// buildTrickplayFilter (pure)
// ============================================================================

test("buildTrickplayFilter: single fps->scale->tile chain", () => {
  const layout = { interval: 10, cols: 8, rows: 5, count: 40, tileWidth: 320, tileHeight: 180 };
  assert.equal(Trickplay.buildTrickplayFilter(layout), "fps=1/10,scale=320:180,tile=8x5");
});

// ============================================================================
// generateTrickplay / getTrickplayForFile (real ffmpeg)
// ============================================================================

test("generateTrickplay: builds a real JPEG sprite + metadata, readable back via getTrickplayForFile", async () => {
  const fileId = insertClipRow(1000);
  assert.equal(await Trickplay.generateTrickplay(fileId), true);

  const spritePath = path.join(trickplayDir(), `${fileId}-1000.jpg`);
  const metaPath = path.join(trickplayDir(), `${fileId}-1000.json`);
  assert.ok(fs.existsSync(spritePath), "sprite JPEG should exist");
  assert.ok(fs.existsSync(metaPath), "metadata sidecar should exist");

  const sprite = fs.readFileSync(spritePath);
  assert.ok(sprite.length > 0);
  assert.deepEqual([...sprite.subarray(0, 3)], [0xff, 0xd8, 0xff], "sprite should be a JPEG (magic bytes)");

  const found = Trickplay.getTrickplayForFile(fileId);
  assert.ok(found);
  assert.equal(found.spritePath, spritePath);
  assert.equal(found.mtime, 1000);
  assert.equal(found.meta.interval, 10);
  assert.equal(found.meta.tileWidth, 320);
  assert.equal(found.meta.tileHeight, 240); // 4:3 source
  assert.equal(found.meta.cols, 3);
  assert.equal(found.meta.count, 3); // 25s / 10s + t=0
  assert.ok(Math.abs(found.meta.duration - CLIP_DURATION) < 0.5);

  // The public meta must mirror src/lib/flix/types.ts's TrickplayMeta exactly
  // (no fileId/mtime/rows leakage — the route serialises this object as-is).
  assert.deepEqual(Object.keys(found.meta).sort(), ["cols", "count", "duration", "interval", "tileHeight", "tileWidth"]);

  // Idempotent: a second call finds the committed generation and no-ops.
  assert.equal(await Trickplay.generateTrickplay(fileId), true);
});

test("generateTrickplay: mtime change invalidates, regenerates under the new key and prunes the stale generation", async () => {
  const fileId = insertClipRow(1000);
  assert.equal(await Trickplay.generateTrickplay(fileId), true);
  assert.ok(Trickplay.getTrickplayForFile(fileId));

  // The file was "replaced": same id, new mtime -> the old generation is stale.
  getDb().prepare("UPDATE media_files SET mtime = 2000 WHERE id = ?").run(fileId);
  assert.equal(Trickplay.getTrickplayForFile(fileId), null, "stale generation must not serve");

  assert.equal(await Trickplay.generateTrickplay(fileId), true);
  assert.ok(Trickplay.getTrickplayForFile(fileId));
  assert.ok(fs.existsSync(path.join(trickplayDir(), `${fileId}-2000.jpg`)));
  assert.equal(fs.existsSync(path.join(trickplayDir(), `${fileId}-1000.jpg`)), false, "stale sprite should be pruned");
  assert.equal(fs.existsSync(path.join(trickplayDir(), `${fileId}-1000.json`)), false, "stale metadata should be pruned");
});

test("getTrickplayForFile: unknown fileId or never-generated file -> null", async () => {
  assert.equal(Trickplay.getTrickplayForFile(999_999), null);
  const fileId = insertClipRow(1000);
  assert.equal(Trickplay.getTrickplayForFile(fileId), null);
});

test("generateTrickplay/runTrickplayPass: FLIX_TRICKPLAY off -> no generation at all", async () => {
  const fileId = insertClipRow(1000);
  process.env.FLIX_TRICKPLAY = "0";
  resetConfigCache();
  try {
    assert.equal(await Trickplay.generateTrickplay(fileId), false);
    await Trickplay.runTrickplayPass();
    assert.equal(fs.existsSync(path.join(trickplayDir(), `${fileId}-1000.jpg`)), false);
    assert.equal(fs.existsSync(path.join(trickplayDir(), `${fileId}-1000.json`)), false);
  } finally {
    process.env.FLIX_TRICKPLAY = "1";
    resetConfigCache();
  }
});

test("runTrickplayPass: builds every missing sprite sequentially and is idempotent", async () => {
  const fileA = insertClipRow(1000);
  const fileB = insertClipRow(1000);
  await Trickplay.runTrickplayPass();
  assert.ok(Trickplay.getTrickplayForFile(fileA), "pass should build file A");
  assert.ok(Trickplay.getTrickplayForFile(fileB), "pass should build file B");
  // Nothing missing anymore: a second pass exits without touching anything.
  const mtimeBefore = fs.statSync(path.join(trickplayDir(), `${fileA}-1000.jpg`)).mtimeMs;
  await Trickplay.runTrickplayPass();
  assert.equal(fs.statSync(path.join(trickplayDir(), `${fileA}-1000.jpg`)).mtimeMs, mtimeBefore);
});
