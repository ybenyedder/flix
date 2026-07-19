// Direct coverage for the path-containment invariant (src/server/paths.ts).
// Every filesystem path derived from client input must pass through these
// helpers, so a silent regression here (realpath skipped, prefix compared
// without a separator, "..%2f" mishandled) would quietly reopen traversal —
// scanner-symlinks.test.ts only exercises the scan-side walk, and the
// playback routes exercise the helpers indirectly. Isolated temp media dir,
// same env bootstrap pattern as kidsPlayback.test.ts.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "flix-paths-data-"));
// The media dir gets an "evil" SIBLING sharing its name as a prefix — the
// classic bug `target.startsWith(root)` misses (`/…/media` vs `/…/media-evil`).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flix-paths-root-"));
const tmpMedia = path.join(tmpRoot, "media");
const tmpSibling = path.join(tmpRoot, "media-evil");
fs.mkdirSync(tmpMedia, { recursive: true });
fs.mkdirSync(tmpSibling, { recursive: true });
process.env.FLIX_DATA_DIR = tmpData;
process.env.FLIX_MEDIA_DIR = tmpMedia;
process.on("exit", () => {
  for (const dir of [tmpData, tmpRoot]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

let Paths: typeof import("../src/server/paths");

before(async () => {
  Paths = await import("../src/server/paths");
});

test("resolveLibraryPath: plain relative paths resolve inside the root", () => {
  const abs = Paths.resolveLibraryPath("Films/Movie (2020)/movie.mkv");
  assert.ok(abs);
  assert.ok(abs.startsWith(tmpMedia + path.sep));
});

test("resolveLibraryPath: ..-traversal, absolute paths and prefix-sibling escapes are rejected", () => {
  assert.equal(Paths.resolveLibraryPath("../outside.mkv"), null);
  assert.equal(Paths.resolveLibraryPath("a/../../outside.mkv"), null);
  assert.equal(Paths.resolveLibraryPath("/etc/passwd"), null);
  // `/…/media-evil/x` shares the root as a STRING prefix — path.relative-based
  // containment must still reject it.
  assert.equal(Paths.resolveLibraryPath(path.join("..", "media-evil", "x.mkv")), null);
});

test("resolveLibraryPath: a filename merely STARTING with '..' is rejected too (fail-closed)", () => {
  // The containment check is `relative.startsWith("..")` — a plain string
  // test, so "..%2fescape.mkv" (an odd but harmless file name, no actual
  // traversal) is ALSO rejected. Over-strict on purpose: scanner-produced
  // names never start with "..", and fail-closed beats a cleverer check.
  assert.equal(Paths.resolveLibraryPath("..%2fescape.mkv"), null);
  assert.equal(Paths.resolveLibraryPath("..hidden.mkv"), null);
});

test("resolveRealLibraryPath: existing real file resolves; missing file is null", async () => {
  fs.mkdirSync(path.join(tmpMedia, "Films"), { recursive: true });
  fs.writeFileSync(path.join(tmpMedia, "Films", "real.mkv"), "x");
  assert.equal(await Paths.resolveRealLibraryPath("Films/real.mkv"), fs.realpathSync(path.join(tmpMedia, "Films", "real.mkv")));
  assert.equal(await Paths.resolveRealLibraryPath("Films/absent.mkv"), null);
});

test("resolveRealLibraryPath: a symlink whose realpath leaves the root is rejected, an internal one is followed", async () => {
  const outside = path.join(tmpSibling, "secret.mkv");
  fs.writeFileSync(outside, "top secret");
  fs.symlinkSync(outside, path.join(tmpMedia, "escape.mkv"));
  assert.equal(await Paths.resolveRealLibraryPath("escape.mkv"), null, "a symlink escaping the media root must be rejected");

  const insideTarget = path.join(tmpMedia, "Films", "real.mkv");
  fs.symlinkSync(insideTarget, path.join(tmpMedia, "alias.mkv"));
  assert.equal(await Paths.resolveRealLibraryPath("alias.mkv"), fs.realpathSync(insideTarget), "an internal symlink stays playable");
});

test("resolveRealLibraryPath: a broken symlink is treated as absent", async () => {
  fs.symlinkSync(path.join(tmpMedia, "never-existed.mkv"), path.join(tmpMedia, "dangling.mkv"));
  assert.equal(await Paths.resolveRealLibraryPath("dangling.mkv"), null);
});

test("resolveRealAbsolutePath: same containment for absolute inputs (sidecar subtitle paths)", async () => {
  assert.equal(await Paths.resolveRealAbsolutePath(path.join(tmpMedia, "Films", "real.mkv")), fs.realpathSync(path.join(tmpMedia, "Films", "real.mkv")));
  assert.equal(await Paths.resolveRealAbsolutePath(path.join(tmpSibling, "secret.mkv")), null);
  assert.equal(await Paths.resolveRealAbsolutePath("/etc/passwd"), null);
});
