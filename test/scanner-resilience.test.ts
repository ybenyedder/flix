// Scanner persistence-safety behaviours, exercised through real runScan()
// passes over a temp media tree:
//  - an EXISTING but unreadable subtree (chmod 000: EACCES, the same shape as
//    an unmounted sub-mount or NFS EIO) must skip the prune phase instead of
//    cascading the whole library — and its user state — away;
//  - sidecar .srt / poster files dropped AFTER a video was indexed are picked
//    up on the next scan via the parent-directory mtime check;
//  - subtitles.external_path is stored RELATIVE to mediaDir (legacy absolute
//    rows still resolve);
//  - a missing ffprobe/ffmpeg BINARY (spawn ENOENT) leaves probed_at/images_at
//    at 0 so files are retried once the binary exists, instead of being
//    stamped broken forever;
//  - movies/shows missing from catalog_fts (crash between upserts and the FTS
//    pass) are re-indexed by the next scan's anti-join completion;
//  - unreferenced image-cache entries (originals, variants, `images` rows) and
//    trickplay sprites of deleted files are garbage-collected at scan end.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flix-resilience-test-"));
const tmpData = path.join(tmpRoot, "data");
const tmpMedia = path.join(tmpRoot, "media");
fs.mkdirSync(tmpData, { recursive: true });
fs.mkdirSync(tmpMedia, { recursive: true });
process.env.FLIX_DATA_DIR = tmpData;
process.env.FLIX_MEDIA_DIR = tmpMedia;

const lockedDir = path.join(tmpMedia, "Locked (2021)");
process.on("exit", () => {
  try {
    fs.chmodSync(lockedDir, 0o755); // rmSync can't clear a 000 directory
  } catch {
    /* best effort */
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

/** The walk only needs the extension — ffprobe failing on fake bytes just
 *  marks the file probed_at = -1, which doesn't affect indexing. */
function writeVideo(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "not a real video");
  return file;
}

/** Wait until the fire-and-forget background image pass is idle so the next
 *  assertion (or the scan-end cache GC) can't race it. */
async function waitImagesIdle(): Promise<void> {
  const { isImagesPassRunning } = await import("../src/server/library/imagesPass");
  const { getDb } = await import("../src/server/db");
  const db = getDb();
  await waitFor(() => {
    if (isImagesPassRunning()) return false;
    const row = db.prepare("SELECT COUNT(*) AS n FROM media_files WHERE images_at = 0").get() as { n: number };
    return row.n === 0;
  }, "image pass to go idle");
}

// ---------------------------------------------------------------------------
// Fix: unreadable subtree must not prune the library
// ---------------------------------------------------------------------------

test("an existing but unreadable media subfolder skips the prune phase instead of deleting its entries", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root — chmod 000 does not block reads");
    return;
  }

  writeVideo(path.join(tmpMedia, "Movie Alpha (2020)"), "Movie Alpha (2020).mkv");
  writeVideo(lockedDir, "Locked (2021).mkv");

  const { runScan } = await import("../src/server/library/scanner");
  const { getDb } = await import("../src/server/db");
  const db = getDb();

  const first = await runScan();
  assert.equal(first.status, "ready");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM media_files").get() as { n: number }).n,
    2,
    "both movies indexed by the first scan",
  );

  // Make the subfolder EXIST but be unreadable — the readdir EACCES used to be
  // swallowed, the walk came back "empty", and prune wiped everything below it.
  fs.chmodSync(lockedDir, 0o000);
  try {
    const second = await runScan();
    assert.equal(second.status, "ready");
    assert.equal(second.removed, 0, "nothing pruned while part of the tree is unreadable");
    const kept = db.prepare("SELECT id FROM media_files WHERE filepath = ?").get("Locked (2021)/Locked (2021).mkv");
    assert.ok(kept, "the unreadable folder's file must survive the scan");
    assert.ok(db.prepare("SELECT id FROM movies WHERE folder = 'Locked (2021)'").get(), "its movie row must survive too");
  } finally {
    fs.chmodSync(lockedDir, 0o755);
  }

  // Readable again: the file is unchanged, still present, nothing removed.
  const third = await runScan();
  assert.equal(third.status, "ready");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM media_files").get() as { n: number }).n, 2);

  // And a REAL deletion still prunes normally (no walk errors this time).
  fs.rmSync(path.join(tmpMedia, "Movie Alpha (2020)"), { recursive: true, force: true });
  const fourth = await runScan();
  assert.equal(fourth.status, "ready");
  assert.equal(fourth.removed, 1);
  assert.equal(db.prepare("SELECT id FROM media_files WHERE filepath = ?").get("Movie Alpha (2020)/Movie Alpha (2020).mkv"), undefined);
});

// ---------------------------------------------------------------------------
// Fix: sidecars dropped after indexation + relative external_path
// ---------------------------------------------------------------------------

test("a .srt and a poster dropped AFTER indexation are picked up on the next scan (dir-mtime trigger)", async () => {
  const { runScan } = await import("../src/server/library/scanner");
  const { getDb } = await import("../src/server/db");
  const db = getDb();

  const movieDir = path.join(tmpMedia, "Sidecar Movie (2019)");
  writeVideo(movieDir, "Sidecar Movie (2019).mkv");

  const first = await runScan();
  assert.equal(first.status, "ready");
  const fileRow = db.prepare("SELECT id FROM media_files WHERE filepath = ?").get("Sidecar Movie (2019)/Sidecar Movie (2019).mkv") as
    | { id: number }
    | undefined;
  assert.ok(fileRow);
  const fileId = fileRow.id;
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM subtitles WHERE media_file_id = ? AND source = 'external'").get(fileId) as { n: number }).n,
    0,
  );
  // Let the background image pass stamp the file (no images available yet).
  await waitImagesIdle();
  const stamped = db.prepare("SELECT images_at FROM media_files WHERE id = ?").get(fileId) as { images_at: number };
  assert.ok(stamped.images_at > 0, "image pass stamped the file before any sidecar existed");

  // NOW drop the sidecars — the video file itself never changes.
  fs.writeFileSync(path.join(movieDir, "Sidecar Movie (2019).fr.srt"), "1\n00:00:01,000 --> 00:00:02,000\nBonjour\n");
  // Any JPEG magic is enough for the cache (sharp metadata is best-effort).
  fs.writeFileSync(path.join(movieDir, "poster.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  // Deterministic mtimes: strictly newer than both scannedAt and images_at.
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(movieDir, "poster.jpg"), future, future);
  fs.utimesSync(movieDir, future, future);

  const second = await runScan();
  assert.equal(second.status, "ready");

  // Subtitle refresh ran for the UNCHANGED file, storing a mediaDir-relative path.
  const sub = db
    .prepare("SELECT id, external_path, language, format FROM subtitles WHERE media_file_id = ? AND source = 'external'")
    .get(fileId) as { id: number; external_path: string; language: string | null; format: string } | undefined;
  assert.ok(sub, "the dropped .srt must be indexed by the rescan");
  assert.equal(sub.external_path, "Sidecar Movie (2019)/Sidecar Movie (2019).fr.srt");
  assert.equal(sub.language, "fr");
  assert.equal(sub.format, "subrip");

  // The image pass was re-armed (images_at reset) and picked the poster up.
  const movie = db.prepare("SELECT id FROM movies WHERE folder = 'Sidecar Movie (2019)'").get() as { id: number };
  await waitFor(() => {
    const row = db.prepare("SELECT poster_hash FROM movies WHERE id = ?").get(movie.id) as { poster_hash: string | null };
    return row.poster_hash !== null;
  }, "dropped poster to be cached");
  const { poster_hash } = db.prepare("SELECT poster_hash FROM movies WHERE id = ?").get(movie.id) as { poster_hash: string };
  const { getConfig } = await import("../src/server/config");
  assert.ok(fs.existsSync(path.join(getConfig().imagesDir, poster_hash)), "poster bytes live in the image store");

  // Relative external_path resolves to servable VTT…
  const { getVttForSubtitle } = await import("../src/server/playback/subtitles");
  const vtt = await getVttForSubtitle(sub.id);
  assert.ok(vtt);
  assert.match(vtt.content, /^WEBVTT/);
  assert.match(vtt.content, /Bonjour/);

  // …and a LEGACY absolute row (pre-fix data) still resolves through the old path.
  const legacyId = Number(
    db
      .prepare("INSERT INTO subtitles (media_file_id, source, external_path, language, is_forced, is_sdh, format, is_text) VALUES (?, 'external', ?, 'fr', 0, 0, 'subrip', 1)")
      .run(fileId, path.join(movieDir, "Sidecar Movie (2019).fr.srt")).lastInsertRowid,
  );
  const legacyVtt = await getVttForSubtitle(legacyId);
  assert.ok(legacyVtt);
  assert.match(legacyVtt.content, /Bonjour/);
  db.prepare("DELETE FROM subtitles WHERE id = ?").run(legacyId);
});

test("an in-place .srt edit (directory mtime untouched) re-converts the cached VTT on the next scan", async () => {
  const { runScan } = await import("../src/server/library/scanner");
  const { getVttForSubtitle } = await import("../src/server/playback/subtitles");
  const { getDb } = await import("../src/server/db");
  const db = getDb();

  const movieDir = path.join(tmpMedia, "Sidecar Movie (2019)");
  const srt = path.join(movieDir, "Sidecar Movie (2019).fr.srt");
  const fileRow = db.prepare("SELECT id FROM media_files WHERE filepath = ?").get("Sidecar Movie (2019)/Sidecar Movie (2019).mkv") as {
    id: number;
  };
  const before = db.prepare("SELECT id FROM subtitles WHERE media_file_id = ? AND source = 'external'").get(fileRow.id) as { id: number };
  // Warm the VTT cache — a missed refresh would keep serving these bytes.
  const warmed = await getVttForSubtitle(before.id);
  assert.ok(warmed);
  assert.match(warmed.content, /Bonjour/);

  // Edit IN PLACE: the .srt's mtime moves but the directory's does not (POSIX
  // only bumps a dir on entry create/delete/rename). Pin the dir mtime to the
  // PAST explicitly so the old directory-mtime path cannot trigger the refresh
  // — only the walk's folded subtitle-file mtime can.
  fs.writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,000\nBonsoir\n");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(srt, future, future);
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(movieDir, past, past);

  const scan = await runScan();
  assert.equal(scan.status, "ready");

  const after = db.prepare("SELECT id FROM subtitles WHERE media_file_id = ? AND source = 'external'").get(fileRow.id) as
    | { id: number }
    | undefined;
  assert.ok(after, "the sidecar row must survive the rescan");
  assert.notEqual(after.id, before.id, "the refresh must re-create the row — the new id busts the server VTT cache AND the browser's immutable cache");
  const vtt = await getVttForSubtitle(after.id);
  assert.ok(vtt);
  assert.match(vtt.content, /Bonsoir/, "the edited subtitle text must be served, not the stale cached VTT");
});

// ---------------------------------------------------------------------------
// Fix: FTS anti-join completion
// ---------------------------------------------------------------------------

test("a movie missing from catalog_fts becomes searchable again after a no-op rescan", async () => {
  const { runScan } = await import("../src/server/library/scanner");
  const { getDb } = await import("../src/server/db");
  const db = getDb();

  const movie = db.prepare("SELECT id FROM movies WHERE folder = 'Sidecar Movie (2019)'").get() as { id: number };
  assert.ok(movie);
  db.prepare("DELETE FROM catalog_fts WHERE item_type = 'movie' AND item_id = ?").run(movie.id);
  assert.equal(db.prepare("SELECT rowid FROM catalog_fts WHERE item_type = 'movie' AND item_id = ?").get(movie.id), undefined);

  const result = await runScan(); // no file changed — only the anti-join can bring it back
  assert.equal(result.status, "ready");
  assert.ok(db.prepare("SELECT rowid FROM catalog_fts WHERE item_type = 'movie' AND item_id = ?").get(movie.id));
  const hit = db.prepare("SELECT item_id FROM catalog_fts WHERE catalog_fts MATCH 'Sidecar' AND item_type = 'movie'").get() as
    | { item_id: number }
    | undefined;
  assert.equal(hit?.item_id, movie.id);
});

// ---------------------------------------------------------------------------
// Fix: image + trickplay cache GC
// ---------------------------------------------------------------------------

test("scan-end GC removes unreferenced image-cache entries and orphaned trickplay sprites, keeps referenced ones", async () => {
  const { runScan } = await import("../src/server/library/scanner");
  const { getDb } = await import("../src/server/db");
  const { getConfig } = await import("../src/server/config");
  const db = getDb();
  const { imagesDir, cacheDir } = getConfig();
  await waitImagesIdle(); // GC refuses to run while the image pass is writing

  const orphanHash = "a".repeat(40);
  const keptHash = "b".repeat(40);
  fs.writeFileSync(path.join(imagesDir, orphanHash), "orphan-bytes");
  fs.writeFileSync(path.join(imagesDir, keptHash), "kept-bytes");
  fs.mkdirSync(path.join(imagesDir, "variants"), { recursive: true });
  fs.writeFileSync(path.join(imagesDir, "variants", `${orphanHash}_480.webp`), "orphan-variant");
  fs.writeFileSync(path.join(imagesDir, "variants", `${keptHash}_480.webp`), "kept-variant");
  db.prepare("INSERT OR IGNORE INTO images (hash, kind, source) VALUES (?, 'poster', 'sidecar')").run(orphanHash);
  db.prepare("INSERT OR IGNORE INTO images (hash, kind, source) VALUES (?, 'backdrop', 'sidecar')").run(keptHash);
  const movie = db.prepare("SELECT id FROM movies WHERE folder = 'Sidecar Movie (2019)'").get() as { id: number };
  db.prepare("UPDATE movies SET backdrop_hash = ? WHERE id = ?").run(keptHash, movie.id);

  const trickplayDir = path.join(cacheDir, "trickplay");
  fs.mkdirSync(trickplayDir, { recursive: true });
  fs.writeFileSync(path.join(trickplayDir, "999999-123.jpg"), "orphan-sprite");
  fs.writeFileSync(path.join(trickplayDir, "999999-123.json"), "{}");
  const liveFile = db.prepare("SELECT id, mtime FROM media_files ORDER BY id LIMIT 1").get() as { id: number; mtime: number };
  fs.writeFileSync(path.join(trickplayDir, `${liveFile.id}-${liveFile.mtime}.jpg`), "live-sprite");

  const result = await runScan();
  assert.equal(result.status, "ready");

  assert.equal(fs.existsSync(path.join(imagesDir, orphanHash)), false, "orphan original deleted");
  assert.equal(fs.existsSync(path.join(imagesDir, "variants", `${orphanHash}_480.webp`)), false, "orphan variant deleted");
  assert.equal(db.prepare("SELECT hash FROM images WHERE hash = ?").get(orphanHash), undefined, "orphan images row deleted");
  assert.equal(fs.existsSync(path.join(imagesDir, keptHash)), true, "referenced original kept");
  assert.equal(fs.existsSync(path.join(imagesDir, "variants", `${keptHash}_480.webp`)), true, "referenced variant kept");
  assert.ok(db.prepare("SELECT hash FROM images WHERE hash = ?").get(keptHash), "referenced images row kept");

  assert.equal(fs.existsSync(path.join(trickplayDir, "999999-123.jpg")), false, "orphan sprite deleted");
  assert.equal(fs.existsSync(path.join(trickplayDir, "999999-123.json")), false, "orphan sprite metadata deleted");
  assert.equal(fs.existsSync(path.join(trickplayDir, `${liveFile.id}-${liveFile.mtime}.jpg`)), true, "live file's sprite kept");
});

// ---------------------------------------------------------------------------
// Fix: missing ffprobe/ffmpeg binary must not stamp files as done
// ---------------------------------------------------------------------------

test("a missing ffprobe/ffmpeg binary leaves probed_at/images_at at 0 so files retry on the next scan", async () => {
  const { runScan } = await import("../src/server/library/scanner");
  const { runImagesPass } = await import("../src/server/library/imagesPass");
  const { resetZscaleCache } = await import("../src/server/library/frameExtract");
  const { resetConfigCache } = await import("../src/server/config");
  const { getDb } = await import("../src/server/db");
  const db = getDb();

  await waitImagesIdle(); // drain earlier fire-and-forget passes first

  const prevFfprobe = process.env.FFPROBE_PATH;
  const prevFfmpeg = process.env.FFMPEG_PATH;
  process.env.FFPROBE_PATH = path.join(tmpRoot, "no-such-ffprobe");
  process.env.FFMPEG_PATH = path.join(tmpRoot, "no-such-ffmpeg");
  resetConfigCache();
  resetZscaleCache();

  try {
    writeVideo(path.join(tmpMedia, "Unprobed (2022)"), "Unprobed (2022).mkv");
    const result = await runScan();
    assert.equal(result.status, "ready");
    const row = db.prepare("SELECT id, probed_at FROM media_files WHERE filepath = ?").get("Unprobed (2022)/Unprobed (2022).mkv") as {
      id: number;
      probed_at: number;
    };
    assert.equal(row.probed_at, 0, "spawn ENOENT must NOT stamp probed_at = -1");

    // Force the images pass to actually need ffmpeg (a generated backdrop
    // requires a duration), then run it directly with the missing binary.
    const { isImagesPassRunning } = await import("../src/server/library/imagesPass");
    await waitFor(() => !isImagesPassRunning(), "scan-triggered image pass to finish");
    db.prepare("UPDATE media_files SET duration = 100, images_at = 0 WHERE id = ?").run(row.id);
    await runImagesPass();
    const after = db.prepare("SELECT images_at FROM media_files WHERE id = ?").get(row.id) as { images_at: number };
    assert.equal(after.images_at, 0, "spawn ENOENT must NOT stamp images_at");
  } finally {
    if (prevFfprobe === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = prevFfprobe;
    if (prevFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prevFfmpeg;
    resetConfigCache();
    resetZscaleCache();
  }

  // With a real ffprobe back on PATH the file IS retried: fake bytes fail the
  // probe for real this time, which is allowed to stamp probed_at = -1.
  const { execSync } = await import("node:child_process");
  let hasRealFfprobe = true;
  try {
    execSync("ffprobe -version", { stdio: "ignore" });
  } catch {
    hasRealFfprobe = false;
  }
  if (hasRealFfprobe) {
    const retry = await runScan();
    assert.equal(retry.status, "ready");
    const row = db.prepare("SELECT probed_at FROM media_files WHERE filepath = ?").get("Unprobed (2022)/Unprobed (2022).mkv") as {
      probed_at: number;
    };
    assert.equal(row.probed_at, -1, "the retried probe ran and marked the fake file unprobeable");
  }
});
