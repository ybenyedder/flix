// Version/édition selection for multi-file movies: the pure file pick used by
// PlayerView (pickPlaybackFile — requested version, stale-id fallback, default
// files[0]) and the DetailModal picker labels (versionLabel / formatFileSize).
// All pure — no DB, no temp dirs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPlaybackFile } from "../src/store/player";
import { versionLabel, formatFileSize } from "../src/lib/flix/quality";

test("pickPlaybackFile: default pick is the first file (the historical behaviour)", () => {
  const files = [{ id: 10 }, { id: 11 }];
  assert.equal(pickPlaybackFile(files)?.id, 10);
  assert.equal(pickPlaybackFile(files, undefined)?.id, 10);
});

test("pickPlaybackFile: an existing requested version wins over files[0]", () => {
  const files = [{ id: 10 }, { id: 11 }, { id: 12 }];
  assert.equal(pickPlaybackFile(files, 12)?.id, 12);
  assert.equal(pickPlaybackFile(files, 10)?.id, 10);
});

test("pickPlaybackFile: a stale/foreign id falls back to the default instead of failing", () => {
  const files = [{ id: 10 }, { id: 11 }];
  assert.equal(pickPlaybackFile(files, 999)?.id, 10);
});

test("pickPlaybackFile: no files -> undefined (the caller surfaces its own error)", () => {
  assert.equal(pickPlaybackFile([]), undefined);
  assert.equal(pickPlaybackFile([], 5), undefined);
});

test("formatFileSize: French Go/Mo notation, decimal comma under 10 Go, unknown -> empty", () => {
  assert.equal(formatFileSize(0), "");
  assert.equal(formatFileSize(-5), "");
  assert.equal(formatFileSize(NaN), "");
  assert.equal(formatFileSize(500 * 1024), "1 Mo"); // sub-MiB floors to 1 Mo, never "0 Mo"
  assert.equal(formatFileSize(700 * 1024 ** 2), "700 Mo");
  assert.equal(formatFileSize(1024 ** 3), "1 Go");
  assert.equal(formatFileSize(4.25 * 1024 ** 3), "4,3 Go");
  assert.equal(formatFileSize(42.4 * 1024 ** 3), "42 Go");
});

function makeFile(version: string | null, height: number | null, size = 4 * 1024 ** 3) {
  return {
    version,
    size,
    streams: [
      // Cover art muxed as a video stream — must never be the quality source.
      { type: "video", height: 200, attachedPic: true },
      { type: "video", height, attachedPic: false },
      { type: "audio", height: null, attachedPic: false },
    ],
  };
}

test("versionLabel: the explicit edition name wins when present", () => {
  assert.equal(versionLabel(makeFile("Director's Cut", 2160), 0), "Director's Cut");
  assert.equal(versionLabel(makeFile("2160p", 2160), 1), "2160p");
});

test("versionLabel: fallback = quality badge + file size, attached pics ignored", () => {
  assert.equal(versionLabel(makeFile(null, 2160), 0), "4K · 4 Go");
  assert.equal(versionLabel(makeFile(null, 1080), 1), "HD · 4 Go");
  assert.equal(versionLabel(makeFile(null, 480), 0), "SD · 4 Go");
});

test("versionLabel: no usable video stream or size still yields a usable label", () => {
  assert.equal(versionLabel(makeFile(null, null), 2), "Version 3 · 4 Go");
  assert.equal(versionLabel({ version: null, size: 0, streams: [] }, 0), "Version 1");
});
