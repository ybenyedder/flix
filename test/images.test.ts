// Pure/filesystem-only tests for the image cache module — no ffmpeg, no DB.
// Covers magic-byte MIME sniffing, the Kodi sidecar priority order, and the
// dominant-colour palette formatting.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { sniffImageMime, findSidecarImages, findSeasonPoster, paletteFromRgb, posterCropRect } from "../src/server/library/images";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flix-images-test-"));
}
function touch(dir: string, name: string, bytes = "x"): void {
  fs.writeFileSync(path.join(dir, name), bytes);
}

// --- sniffImageMime ---------------------------------------------------------

test("sniffImageMime: detects jpeg/png/webp/gif/bmp from magic bytes", () => {
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
  assert.equal(sniffImageMime(webp), "image/webp");
  assert.equal(sniffImageMime(Buffer.from("GIF89a")), "image/gif");
  assert.equal(sniffImageMime(Buffer.from("GIF87a")), "image/gif");
  assert.equal(sniffImageMime(Buffer.from([0x42, 0x4d, 0, 0])), "image/bmp");
});

test("sniffImageMime: unknown/empty bytes fall back to octet-stream", () => {
  assert.equal(sniffImageMime(Buffer.from([1, 2, 3, 4])), "application/octet-stream");
  assert.equal(sniffImageMime(Buffer.alloc(0)), "application/octet-stream");
});

// --- findSidecarImages -------------------------------------------------------

test("findSidecarImages: <basename>-poster.jpg outranks poster.jpg/folder.jpg/cover.jpg", () => {
  const dir = tmpDir();
  touch(dir, "cover.jpg");
  touch(dir, "folder.jpg");
  touch(dir, "poster.jpg");
  touch(dir, "Movie (2020)-poster.jpg");
  const result = findSidecarImages(dir, "Movie (2020)");
  assert.equal(result.poster, path.join(dir, "Movie (2020)-poster.jpg"));
});

test("findSidecarImages: poster.jpg outranks folder.jpg outranks cover.jpg", () => {
  const dir = tmpDir();
  touch(dir, "cover.jpg");
  touch(dir, "folder.jpg");
  touch(dir, "poster.jpg");
  assert.equal(findSidecarImages(dir, null).poster, path.join(dir, "poster.jpg"));

  const dir2 = tmpDir();
  touch(dir2, "cover.jpg");
  touch(dir2, "folder.jpg");
  assert.equal(findSidecarImages(dir2, null).poster, path.join(dir2, "folder.jpg"));
});

test("findSidecarImages: fanart.jpg is picked up as the backdrop", () => {
  const dir = tmpDir();
  touch(dir, "fanart.jpg");
  assert.equal(findSidecarImages(dir, null).backdrop, path.join(dir, "fanart.jpg"));
});

test("findSidecarImages: clearlogo.png outranks logo.png", () => {
  const dir = tmpDir();
  touch(dir, "logo.png");
  touch(dir, "clearlogo.png");
  assert.equal(findSidecarImages(dir, null).logo, path.join(dir, "clearlogo.png"));
});

test("findSidecarImages: episode thumb only matches with a basename, and only its own", () => {
  const dir = tmpDir();
  touch(dir, "Show S01E01-thumb.jpg");
  touch(dir, "Show S01E02-thumb.jpg");
  assert.equal(findSidecarImages(dir, "Show S01E01").thumb, path.join(dir, "Show S01E01-thumb.jpg"));
  assert.equal(findSidecarImages(dir, null).thumb, null);
  assert.equal(findSidecarImages(dir, "Show S01E03").thumb, null);
});

test("findSidecarImages: empty/missing directory yields all nulls, never throws", () => {
  const result = findSidecarImages(path.join(os.tmpdir(), "flix-does-not-exist-xyz"), "whatever");
  assert.deepEqual(result, { poster: null, backdrop: null, logo: null, thumb: null });
});

// --- findSeasonPoster ---------------------------------------------------------

test("findSeasonPoster: zero-padded season number", () => {
  const dir = tmpDir();
  touch(dir, "season01-poster.jpg");
  touch(dir, "season12-poster.jpg");
  assert.equal(findSeasonPoster(dir, 1), path.join(dir, "season01-poster.jpg"));
  assert.equal(findSeasonPoster(dir, 12), path.join(dir, "season12-poster.jpg"));
  assert.equal(findSeasonPoster(dir, 2), null);
});

test("findSeasonPoster: season 0 uses the specials naming", () => {
  const dir = tmpDir();
  touch(dir, "season-specials-poster.jpg");
  assert.equal(findSeasonPoster(dir, 0), path.join(dir, "season-specials-poster.jpg"));
});

// --- paletteFromRgb ---------------------------------------------------------

test("paletteFromRgb: formats base,shadow,highlight as three hex colours", () => {
  const palette = paletteFromRgb(200, 100, 50);
  const parts = palette.split(",");
  assert.equal(parts.length, 3);
  for (const p of parts) assert.match(p, /^#[0-9a-f]{6}$/);
  assert.equal(parts[0], "#c86432");
});

test("paletteFromRgb: clamps out-of-range channel values", () => {
  const palette = paletteFromRgb(-10, 300, 128);
  const [base] = palette.split(",");
  assert.equal(base, "#00ff80");
});

// --- posterCropRect (2:3 crop maths for backdrop→poster reuse) ---------------

function isTwoThirds(w: number, h: number): boolean {
  // width/height ≈ 2/3, tolerant of a 1px rounding wobble on either dimension.
  return Math.abs(w * 3 - h * 2) <= 3;
}

test("posterCropRect: 16:9 backdrop crops to a centred 2:3 slice within bounds", () => {
  const rect = posterCropRect(1280, 720);
  assert.deepEqual(rect, { left: 400, top: 0, width: 480, height: 720 });
  assert.ok(isTwoThirds(rect.width, rect.height));
  assert.ok(rect.left + rect.width <= 1280 && rect.top + rect.height <= 720);
});

test("posterCropRect: never upsizes — height binds for any landscape source", () => {
  for (const [w, h] of [[1920, 1080], [1280, 720], [720, 480]] as const) {
    const rect = posterCropRect(w, h);
    assert.equal(rect.height, h, "keeps full height, crops width");
    assert.ok(rect.width <= w && rect.left >= 0 && rect.left + rect.width <= w);
    assert.ok(isTwoThirds(rect.width, rect.height));
  }
});

test("posterCropRect: a source already narrower than 2:3 crops height instead", () => {
  const rect = posterCropRect(720, 1280); // portrait source: width binds
  assert.equal(rect.width, 720);
  assert.ok(rect.height <= 1280 && rect.top >= 0 && rect.top + rect.height <= 1280);
  assert.ok(isTwoThirds(rect.width, rect.height));
});

test("posterCropRect: an exact 2:3 source is returned whole (no crop)", () => {
  const rect = posterCropRect(480, 720);
  assert.deepEqual(rect, { left: 0, top: 0, width: 480, height: 720 });
});
