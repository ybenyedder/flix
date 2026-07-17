// Upload session-manager behaviour, exercised through the real module against a
// temp media dir: capability probe, init (creates .part + sidecar under the
// dot-dir), a two-chunk resumable append, offset-mismatch rejection carrying the
// authoritative received, atomic finalize into the library, abort teardown, and
// stale-session cleanup. Isolated temp data + media dirs; the post-finalize
// rescan is pointed at nonexistent ffmpeg/ffprobe so it can't spawn or hang.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flix-upload-mgr-test-"));
const tmpData = path.join(tmpRoot, "data");
const tmpMedia = path.join(tmpRoot, "media");
fs.mkdirSync(tmpData, { recursive: true });
fs.mkdirSync(tmpMedia, { recursive: true });
process.env.FLIX_DATA_DIR = tmpData;
process.env.FLIX_MEDIA_DIR = tmpMedia;
// The fire-and-forget rescan finalize() triggers must not spawn real binaries
// (which could keep the test process alive) — a missing binary fails fast.
process.env.FFPROBE_PATH = "flix-test-no-ffprobe";
process.env.FFMPEG_PATH = "flix-test-no-ffmpeg";

process.on("exit", () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const uploadsDir = path.join(tmpMedia, ".flix-uploads");

function webStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

test("upload manager: init → 2-chunk append → offset mismatch → finalize into place", async () => {
  const mgr = await import("../src/server/upload/manager");

  const cap = await mgr.checkUploadCapability();
  assert.equal(cap.writable, true, "temp media dir must be writable");
  assert.ok(cap.chunkSize > 0);

  const chunkA = Buffer.from("HELLO!"); // 6 bytes
  const chunkB = Buffer.from("WRLD"); // 4 bytes
  const total = chunkA.length + chunkB.length; // 10

  const init = await mgr.initUpload({
    filename: "Test Movie (2021).mkv",
    size: total,
    destination: { kind: "movie", title: "Test Movie", year: 2021 },
  });
  assert.equal(init.received, 0);
  assert.equal(init.targetRel, "movies/Test Movie (2021)/Test Movie (2021).mkv");
  const id = init.uploadId;

  // .part + sidecar created under the dot-dir.
  assert.ok(fs.existsSync(path.join(uploadsDir, `${id}.part`)));
  assert.ok(fs.existsSync(path.join(uploadsDir, `${id}.json`)));

  const status = mgr.getUploadStatus(id);
  assert.equal(status?.received, 0);
  assert.equal(status?.size, total);
  assert.equal(status?.targetRel, init.targetRel);

  // Two sequential chunks.
  const r1 = await mgr.appendChunk(id, 0, webStream(chunkA));
  assert.equal(r1.received, 6);
  const r2 = await mgr.appendChunk(id, 6, webStream(chunkB));
  assert.equal(r2.received, 10);

  // Wrong offset → 409 carrying the authoritative received.
  await assert.rejects(
    mgr.appendChunk(id, 0, webStream(Buffer.from("x"))),
    (err: unknown) => {
      const e = err as { name?: string; status?: number; received?: number };
      assert.equal(e.name, "UploadError");
      assert.equal(e.status, 409);
      assert.equal(e.received, 10);
      return true;
    },
  );

  // Finalize renames into the library.
  const fin = await mgr.finalizeUpload(id);
  assert.equal(fin.rel, "movies/Test Movie (2021)/Test Movie (2021).mkv");

  const finalAbs = path.join(tmpMedia, "movies", "Test Movie (2021)", "Test Movie (2021).mkv");
  assert.ok(fs.existsSync(finalAbs), "final file exists at the expected rel path");
  assert.equal(fs.readFileSync(finalAbs, "utf8"), "HELLO!WRLD");

  // .part + sidecar are gone, session forgotten.
  assert.equal(fs.existsSync(path.join(uploadsDir, `${id}.part`)), false);
  assert.equal(fs.existsSync(path.join(uploadsDir, `${id}.json`)), false);
  assert.equal(mgr.getUploadStatus(id), null);
});

test("upload manager: abort removes both files", async () => {
  const mgr = await import("../src/server/upload/manager");

  const init = await mgr.initUpload({
    filename: "Abort Me.mkv",
    size: 5,
    destination: { kind: "movie", title: "Abort Me", year: 2000 },
  });
  const id = init.uploadId;
  assert.ok(fs.existsSync(path.join(uploadsDir, `${id}.part`)));
  assert.ok(fs.existsSync(path.join(uploadsDir, `${id}.json`)));

  await mgr.abortUpload(id);
  assert.equal(fs.existsSync(path.join(uploadsDir, `${id}.part`)), false);
  assert.equal(fs.existsSync(path.join(uploadsDir, `${id}.json`)), false);
});

test("upload manager: cleanupStaleUploads reaps a session older than the max age", async () => {
  const mgr = await import("../src/server/upload/manager");

  const init = await mgr.initUpload({
    filename: "Stale S01E01.mkv",
    size: 8,
    destination: { kind: "episode", show: "Stale", showYear: 1999, season: 1 },
  });
  const id = init.uploadId;
  const sidecar = path.join(uploadsDir, `${id}.json`);
  const part = path.join(uploadsDir, `${id}.part`);
  assert.ok(fs.existsSync(sidecar));

  // Backdate the sidecar's updatedAt to 48h ago (older than the 24h default).
  const data = JSON.parse(fs.readFileSync(sidecar, "utf8"));
  data.updatedAt = Date.now() - 48 * 60 * 60 * 1000;
  fs.writeFileSync(sidecar, JSON.stringify(data));

  await mgr.cleanupStaleUploads();
  assert.equal(fs.existsSync(sidecar), false, "stale sidecar reaped");
  assert.equal(fs.existsSync(part), false, "stale .part reaped");
});
