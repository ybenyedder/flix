// Scanner symlink behaviour, exercised through a real runScan() over a temp
// media tree: symlinked dirs/files are followed when their realpath stays
// inside the media root (the same containment policy resolveRealLibraryPath
// applies at stream time), links escaping the root are skipped, a link cycle
// can't hang the walk, and a broken link can't abort the scan. Also covers
// the NFO pass's single-query media_files preload end-to-end (movie + episode
// branches), and that a rescan over the same tree is idempotent.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flix-symlink-test-"));
const tmpData = path.join(tmpRoot, "data");
const tmpMedia = path.join(tmpRoot, "media");
const outside = path.join(tmpRoot, "outside"); // deliberately NOT under the media root
fs.mkdirSync(tmpData, { recursive: true });
fs.mkdirSync(tmpMedia, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
process.env.FLIX_DATA_DIR = tmpData;
process.env.FLIX_MEDIA_DIR = tmpMedia;
process.on("exit", () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** The walk only needs the extension — ffprobe failing on fake bytes just
 *  marks the file probed_at = -1, which doesn't affect indexing. */
function writeVideo(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "not a real video");
  return file;
}

test("scan follows in-root symlinks, skips escaping/broken ones, survives a link cycle", async () => {
  // 1. plain movie (control) + a movie.nfo the NFO pass must still apply
  writeVideo(path.join(tmpMedia, "Plain Movie (2020)"), "Plain Movie (2020).mkv");
  fs.writeFileSync(
    path.join(tmpMedia, "Plain Movie (2020)", "movie.nfo"),
    "<movie><title>Plain Movie Reloaded</title><year>2020</year></movie>",
  );

  // 2. symlinked DIRECTORY whose target lives inside the media root but in a
  //    dot-folder the walk skips — so it's only reachable through the link
  const hiddenDir = path.join(tmpMedia, ".store", "Linked Movie (2018)");
  writeVideo(hiddenDir, "Linked Movie (2018).mkv");
  fs.symlinkSync(hiddenDir, path.join(tmpMedia, "Linked Movie (2018)"));

  // 3. symlinked FILE whose target lives inside the media root
  const hiddenFile = writeVideo(path.join(tmpMedia, ".blobs"), "blob0001.mkv");
  fs.symlinkSync(hiddenFile, path.join(tmpMedia, "Linked File (2017).mkv"));

  // 4. directory + file symlinks escaping the media root — must be skipped,
  //    matching resolveRealLibraryPath's refusal to serve them
  writeVideo(path.join(outside, "Escape Dir (2019)"), "Escape Dir (2019).mkv");
  fs.symlinkSync(path.join(outside, "Escape Dir (2019)"), path.join(tmpMedia, "Escape Dir (2019)"));
  const outsideFile = writeVideo(outside, "escape-file.mkv");
  fs.symlinkSync(outsideFile, path.join(tmpMedia, "Escape File (2016).mkv"));

  // 5. cycle: a link pointing back at the media root itself
  fs.symlinkSync(tmpMedia, path.join(tmpMedia, "Loop"));

  // 6. broken symlink
  fs.symlinkSync(path.join(tmpMedia, "does-not-exist.mkv"), path.join(tmpMedia, "Broken (2015).mkv"));

  // 7. a show with an episode-level NFO — the episode branch of the NFO pass
  const seasonDir = path.join(tmpMedia, "Some Show (2021)", "Season 01");
  writeVideo(seasonDir, "Some Show S01E01.mkv");
  fs.writeFileSync(path.join(seasonDir, "Some Show S01E01.nfo"), "<episodedetails><title>Cold Harbor</title></episodedetails>");

  const { runScan } = await import("../src/server/library/scanner");
  const result = await runScan();
  assert.equal(result.status, "ready");

  const { getDb } = await import("../src/server/db");
  const db = getDb();
  const filepaths = (db.prepare("SELECT filepath FROM media_files ORDER BY filepath").all() as { filepath: string }[]).map((r) => r.filepath);

  // followed: plain file, in-root dir link, in-root file link, the show
  assert.ok(filepaths.includes("Plain Movie (2020)/Plain Movie (2020).mkv"));
  assert.ok(filepaths.includes("Linked Movie (2018)/Linked Movie (2018).mkv"));
  assert.ok(filepaths.includes("Linked File (2017).mkv"));
  assert.ok(filepaths.includes("Some Show (2021)/Season 01/Some Show S01E01.mkv"));

  // skipped: escaping links, the cycle, the broken link
  assert.ok(!filepaths.some((p) => p.startsWith("Escape Dir")));
  assert.ok(!filepaths.some((p) => p.startsWith("Escape File")));
  assert.ok(!filepaths.some((p) => p.startsWith("Loop/")));
  assert.ok(!filepaths.some((p) => p.startsWith("Broken")));
  assert.equal(filepaths.length, 4);

  // NFO pass (batched media_files preload) still applied both branches
  const movieTitle = (db.prepare("SELECT title FROM movies WHERE folder = 'Plain Movie (2020)'").get() as { title: string } | undefined)?.title;
  assert.equal(movieTitle, "Plain Movie Reloaded");
  const episodeTitle = (db.prepare("SELECT title FROM episodes ORDER BY id LIMIT 1").get() as { title: string | null } | undefined)?.title;
  assert.equal(episodeTitle, "Cold Harbor");
});

test("a rescan over the same symlinked tree is idempotent", async () => {
  const { runScan } = await import("../src/server/library/scanner");
  const { getDb } = await import("../src/server/db");
  const db = getDb();
  const countBefore = (db.prepare("SELECT COUNT(*) AS n FROM media_files").get() as { n: number }).n;

  const result = await runScan();
  assert.equal(result.status, "ready");
  assert.equal(result.added, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.removed, 0);

  const countAfter = (db.prepare("SELECT COUNT(*) AS n FROM media_files").get() as { n: number }).n;
  assert.equal(countAfter, countBefore);
});
