// Playback subsystem tests: the decide() priority matrix (direct > remux >
// transcode, never reordered), its per-profile language preselection (which
// may never buy a burn-in/transcode), the stream route's byte-range parser, HLS
// segment-name validation, the pure segment-boundary/playlist/ffmpeg-argv
// builders, and — using a real tiny ffmpeg-generated clip — actual session
// spawn/serve/cap/ownership/teardown behaviour. Uses an isolated temp data +
// media dir (like auth.test.ts) so it never touches a real library.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { ClientCaps } from "../src/lib/flix/caps";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "flix-playback-data-"));
const tmpMedia = fs.mkdtempSync(path.join(os.tmpdir(), "flix-playback-media-"));
process.env.FLIX_DATA_DIR = tmpData;
process.env.FLIX_MEDIA_DIR = tmpMedia;
process.env.FLIX_MAX_TRANSCODES = "1"; // exercised by the capacity tests below
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

// --- generate one tiny real H.264/AAC MP4 clip for the spawn-based tests ---
// 20s with a 1s GOP (-g 25 @ 25fps) so the 4s HLS segmentation actually
// produces several real segments — enough to exercise a genuine seek
// (kill + respawn) rather than a single-segment degenerate case.
const CLIP_SECONDS = 20;
const CLIP_REL = path.join("Real Movie (2020)", "Real Movie.mp4");
const CLIP_ABS = path.join(tmpMedia, CLIP_REL);
let CLIP_DURATION = CLIP_SECONDS;
{
  fs.mkdirSync(path.dirname(CLIP_ABS), { recursive: true });
  const gen = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=duration=${CLIP_SECONDS}:size=320x240:rate=25`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=1000:duration=${CLIP_SECONDS}`,
      "-c:v",
      "libx264",
      "-g",
      "25",
      "-keyint_min",
      "25",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-loglevel",
      "error",
      CLIP_ABS,
    ],
    { stdio: "ignore" },
  );
  if (gen.status !== 0) throw new Error("failed to generate the real test clip for playback tests — is ffmpeg installed?");
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", CLIP_ABS]);
  const parsed = Number(probe.stdout.toString("utf8").trim());
  if (Number.isFinite(parsed) && parsed > 0) CLIP_DURATION = parsed;
}

// node --test transpiles this file to CJS (via tsx), which can't use top-level
// await — every module under test is instead loaded once in a `before()` hook,
// same effect, CJS-compatible.
let getDb: typeof import("../src/server/db").getDb;
let decide: typeof import("../src/server/playback/decision").decide;
let getFileStreamsForPlayback: typeof import("../src/server/playback/decision").getFileStreamsForPlayback;
let parseChapters: typeof import("../src/server/playback/decision").parseChapters;
let normalizeLangCode: typeof import("../src/server/playback/decision").normalizeLangCode;
let parseClientCaps: typeof import("../src/lib/flix/caps").parseClientCaps;
let MINIMAL_CAPS: typeof import("../src/lib/flix/caps").MINIMAL_CAPS;
let parseRange: typeof import("../src/app/api/stream/[fileId]/route").parseRange;
let ifRangeAllowsPartial: typeof import("../src/app/api/stream/[fileId]/route").ifRangeAllowsPartial;
let Sessions: typeof import("../src/server/playback/sessions");

before(async () => {
  ({ getDb } = await import("../src/server/db"));
  ({ decide, getFileStreamsForPlayback, parseChapters, normalizeLangCode } = await import("../src/server/playback/decision"));
  ({ parseClientCaps, MINIMAL_CAPS } = await import("../src/lib/flix/caps"));
  ({ parseRange, ifRangeAllowsPartial } = await import("../src/app/api/stream/[fileId]/route"));
  Sessions = await import("../src/server/playback/sessions");
});

type DB = ReturnType<typeof getDb>;

function baseCaps(overrides: Partial<ClientCaps> = {}): ClientCaps {
  return {
    containers: ["mp4"],
    video: [{ codec: "h264", profiles: ["high", "main", "baseline"], maxLevel: 51, bitDepth: 8 }],
    audio: ["aac"],
    maxWidth: 1920,
    maxHeight: 1080,
    hdr: false,
    ...overrides,
  };
}

let movieCounter = 0;
function insertMovie(db: DB): number {
  movieCounter++;
  const folder = `Movie ${movieCounter}`;
  const info = db.prepare("INSERT INTO movies (title, sort_title, folder, added_at) VALUES (?, ?, ?, ?)").run(folder, folder, folder, Date.now());
  return Number(info.lastInsertRowid);
}

function insertMediaFile(db: DB, movieId: number, filepath: string, duration = 120): number {
  const info = db
    .prepare("INSERT INTO media_files (movie_id, filepath, size, mtime, duration, probed_at, images_at, added_at) VALUES (?, ?, 0, 0, ?, 1, 0, ?)")
    .run(movieId, filepath, duration, Date.now());
  return Number(info.lastInsertRowid);
}

interface StreamOpts {
  type: "video" | "audio" | "subtitle";
  codec?: string | null;
  profile?: string | null;
  level?: number | null;
  width?: number | null;
  height?: number | null;
  bitDepth?: number | null;
  hdrFormat?: string | null;
  channels?: number | null;
  language?: string | null;
  isDefault?: boolean;
  attachedPic?: boolean;
}

function insertStream(db: DB, fileId: number, streamIndex: number, opts: StreamOpts): number {
  const info = db
    .prepare(
      `INSERT INTO streams (media_file_id, stream_index, type, codec, profile, level, width, height, bit_depth, hdr_format, channels, language, is_default, is_forced, attached_pic)
       VALUES (@media_file_id, @stream_index, @type, @codec, @profile, @level, @width, @height, @bit_depth, @hdr_format, @channels, @language, @is_default, 0, @attached_pic)`,
    )
    .run({
      media_file_id: fileId,
      stream_index: streamIndex,
      type: opts.type,
      codec: opts.codec ?? null,
      profile: opts.profile ?? null,
      level: opts.level ?? null,
      width: opts.width ?? null,
      height: opts.height ?? null,
      bit_depth: opts.bitDepth ?? null,
      hdr_format: opts.hdrFormat ?? (opts.type === "video" ? "SDR" : null),
      channels: opts.channels ?? null,
      language: opts.language ?? null,
      is_default: opts.isDefault ? 1 : 0,
      attached_pic: opts.attachedPic ? 1 : 0,
    });
  return Number(info.lastInsertRowid);
}

interface SubOpts {
  streamIndex?: number | null;
  source?: "embedded" | "external";
  externalPath?: string | null;
  language?: string | null;
  format?: string | null;
  isText?: boolean;
  isForced?: boolean;
}

function insertSubtitle(db: DB, fileId: number, opts: SubOpts): number {
  const info = db
    .prepare(
      `INSERT INTO subtitles (media_file_id, stream_index, source, external_path, language, format, is_forced, is_sdh, is_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      fileId,
      opts.streamIndex ?? null,
      opts.source ?? "embedded",
      opts.externalPath ?? null,
      opts.language ?? null,
      opts.format ?? null,
      opts.isForced ? 1 : 0,
      opts.isText === false ? 0 : 1,
    );
  return Number(info.lastInsertRowid);
}

// A fully-equipped "normal" file (h264 High@4.0, 1080p, SDR, default AAC
// stereo audio, mp4 container) that every case below tweaks from.
function makeFullFile(db: DB, ext = ".mp4"): { fileId: number; audioId: number } {
  const movieId = insertMovie(db);
  const fileId = insertMediaFile(db, movieId, `Movie ${movieId}/Movie${ext}`, 120);
  insertStream(db, fileId, 0, { type: "video", codec: "h264", profile: "High", level: 40, width: 1920, height: 1080, bitDepth: 8, hdrFormat: "SDR" });
  const audioId = insertStream(db, fileId, 1, { type: "audio", codec: "aac", channels: 2, isDefault: true });
  return { fileId, audioId };
}

// ============================================================================
// decide() — priority matrix
// ============================================================================

test("decide: unknown fileId returns null", () => {
  assert.equal(decide(999_999, baseCaps()), null);
});

test("decide: everything supported -> direct play, zero loss", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  const d = decide(fileId, baseCaps());
  assert.equal(d?.mode, "direct");
  assert.equal(d?.url, `/api/stream/${fileId}`);
  assert.equal(d?.videoCodec, "h264");
});

test("decide: container unsupported but codecs fine -> remux, never transcode", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db, ".mkv");
  const d = decide(fileId, baseCaps({ containers: ["mp4"] })); // caps only know mp4, file is mkv
  assert.equal(d?.mode, "remux");
  assert.equal(d?.reason, "container-unsupported-video-codec-ok");
});

test("decide: audio codec unsupported but video+container fine -> remux (only audio would re-encode)", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  const d = decide(fileId, baseCaps({ audio: ["ac3"] })); // client can't decode this file's aac
  assert.equal(d?.mode, "remux");
  assert.equal(d?.reason, "audio-codec-unsupported-video-codec-ok");
});

test("decide: video codec entirely unsupported -> transcode (last resort)", () => {
  const db = getDb();
  const movieId = insertMovie(db);
  const fileId = insertMediaFile(db, movieId, `Movie ${movieId}/Movie.mp4`, 120);
  insertStream(db, fileId, 0, { type: "video", codec: "hevc", profile: "Main 10", level: 120, width: 1920, height: 1080, bitDepth: 10, hdrFormat: "SDR" });
  insertStream(db, fileId, 1, { type: "audio", codec: "aac", channels: 2, isDefault: true });
  const d = decide(fileId, baseCaps()); // caps only declare h264
  assert.equal(d?.mode, "transcode");
  assert.equal(d?.reason, "video-codec-unsupported");
});

test("decide: profile not in the client's allowed list -> transcode", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  const d = decide(fileId, baseCaps({ video: [{ codec: "h264", profiles: ["baseline"], maxLevel: 51, bitDepth: 8 }] })); // file is High
  assert.equal(d?.mode, "transcode");
});

test("decide: level exceeds the client's ceiling -> transcode", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db); // level 40
  const d = decide(fileId, baseCaps({ video: [{ codec: "h264", maxLevel: 31 }] }));
  assert.equal(d?.mode, "transcode");
});

test("decide: bit depth exceeds the client's ceiling -> transcode", () => {
  const db = getDb();
  const movieId = insertMovie(db);
  const fileId = insertMediaFile(db, movieId, `Movie ${movieId}/Movie.mp4`, 120);
  insertStream(db, fileId, 0, { type: "video", codec: "hevc", profile: "Main 10", width: 1920, height: 1080, bitDepth: 10, hdrFormat: "SDR" });
  insertStream(db, fileId, 1, { type: "audio", codec: "aac", isDefault: true });
  const d = decide(fileId, baseCaps({ containers: ["mp4"], video: [{ codec: "hevc", bitDepth: 8 }] }));
  assert.equal(d?.mode, "transcode");
});

test("decide: resolution exceeds the client's ceiling -> transcode", () => {
  const db = getDb();
  const movieId = insertMovie(db);
  const fileId = insertMediaFile(db, movieId, `Movie ${movieId}/Movie.mp4`, 120);
  insertStream(db, fileId, 0, { type: "video", codec: "h264", profile: "High", level: 51, width: 3840, height: 2160, bitDepth: 8, hdrFormat: "SDR" });
  insertStream(db, fileId, 1, { type: "audio", codec: "aac", isDefault: true });
  const d = decide(fileId, baseCaps({ maxWidth: 1920, maxHeight: 1080 }));
  assert.equal(d?.mode, "transcode");
});

test("decide: HDR content on a client without HDR support -> transcode", () => {
  const db = getDb();
  const movieId = insertMovie(db);
  const fileId = insertMediaFile(db, movieId, `Movie ${movieId}/Movie.mp4`, 120);
  insertStream(db, fileId, 0, { type: "video", codec: "hevc", profile: "Main 10", bitDepth: 10, hdrFormat: "HDR10", width: 1920, height: 1080 });
  insertStream(db, fileId, 1, { type: "audio", codec: "aac", isDefault: true });
  const d = decide(fileId, baseCaps({ video: [{ codec: "hevc", bitDepth: 10 }], hdr: false }));
  assert.equal(d?.mode, "transcode");
});

test("decide: HDR content IS direct-played when the client declares HDR support (never downgraded needlessly)", () => {
  const db = getDb();
  const movieId = insertMovie(db);
  const fileId = insertMediaFile(db, movieId, `Movie ${movieId}/Movie.mp4`, 120);
  insertStream(db, fileId, 0, { type: "video", codec: "hevc", profile: "Main 10", bitDepth: 10, hdrFormat: "HDR10", width: 1920, height: 1080 });
  insertStream(db, fileId, 1, { type: "audio", codec: "aac", isDefault: true });
  const d = decide(fileId, baseCaps({ video: [{ codec: "hevc", bitDepth: 10 }], hdr: true }));
  assert.equal(d?.mode, "direct");
});

test("decide: a non-default audio track requested forces remux even though direct would otherwise apply", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  insertStream(db, fileId, 2, { type: "audio", codec: "aac", channels: 6, isDefault: false });
  const d = decide(fileId, baseCaps({ audio: ["aac"] }), { audioIdx: 2 });
  assert.equal(d?.mode, "remux");
  assert.equal(d?.reason, "non-default-audio-track-requested");
});

test("decide: requesting a bitmap (burn-in) subtitle forces transcode regardless of everything else", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  const subId = insertSubtitle(db, fileId, { streamIndex: 2, source: "embedded", format: "pgs", isText: false });
  const d = decide(fileId, baseCaps(), { subtitleId: subId });
  assert.equal(d?.mode, "transcode");
  assert.equal(d?.reason, "subtitle-burn-in-required");
  assert.equal(d?.requiresBurnIn, true);
});

test("decide: an EXTERNAL bitmap subtitle never forces transcode — burn-in only applies to embedded tracks", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  // A VobSub sidecar: bitmap (is_text = 0) but external, so there is no input
  // stream index to overlay — transcoding would re-encode the whole video
  // WITHOUT the subtitle. The decision must stay on the lossless path.
  const subId = insertSubtitle(db, fileId, { streamIndex: null, source: "external", externalPath: "/media/Movie/Movie.sub", format: "vobsub", isText: false });
  const d = decide(fileId, baseCaps(), { subtitleId: subId });
  assert.equal(d?.mode, "direct");
  assert.equal(d?.requiresBurnIn, false);
  assert.equal(d?.subtitleId, subId);
});

test("decide: a text subtitle selection never forces remux/transcode by itself", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  const subId = insertSubtitle(db, fileId, { streamIndex: 2, source: "embedded", format: "subrip", isText: true });
  const d = decide(fileId, baseCaps(), { subtitleId: subId });
  assert.equal(d?.mode, "direct");
  assert.equal(d?.requiresBurnIn, false);
});

test("decide: audio-only file (no video stream) with everything supported -> direct", () => {
  const db = getDb();
  const movieId = insertMovie(db);
  const fileId = insertMediaFile(db, movieId, `Movie ${movieId}/Movie.mp4`, 120);
  insertStream(db, fileId, 0, { type: "audio", codec: "aac", isDefault: true });
  const d = decide(fileId, baseCaps());
  assert.equal(d?.mode, "direct");
});

test("decide: audio-only file with an unsupported audio codec -> remux, not transcode (no video to re-encode)", () => {
  const db = getDb();
  const movieId = insertMovie(db);
  const fileId = insertMediaFile(db, movieId, `Movie ${movieId}/Movie.mp4`, 120);
  insertStream(db, fileId, 0, { type: "audio", codec: "flac", isDefault: true });
  const d = decide(fileId, baseCaps({ audio: ["aac"] }));
  assert.equal(d?.mode, "remux");
});

test("decide: exposes audioTracks and subtitles with correct supported/requiresBurnIn flags", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  insertStream(db, fileId, 2, { type: "audio", codec: "dts", channels: 6, isDefault: false });
  const subId = insertSubtitle(db, fileId, { streamIndex: 3, source: "embedded", format: "pgs", isText: false });
  const d = decide(fileId, baseCaps({ audio: ["aac"] }));
  assert.equal(d?.audioTracks.length, 2);
  assert.equal(d?.audioTracks.find((t) => t.codec === "aac")?.supported, true);
  assert.equal(d?.audioTracks.find((t) => t.codec === "dts")?.supported, false);
  assert.equal(d?.subtitles.find((s) => s.id === subId)?.requiresBurnIn, true);
});

// ============================================================================
// decide() — per-profile language preferences (pref.audioLang / pref.subtitleLang)
// ============================================================================

/** Direct-playable file with an English default track + a French secondary —
 *  the canonical preselection scenario every pref test below tweaks from. */
function makeBilingualFile(db: DB): { fileId: number } {
  const movieId = insertMovie(db);
  const fileId = insertMediaFile(db, movieId, `Movie ${movieId}/Movie.mp4`, 120);
  insertStream(db, fileId, 0, { type: "video", codec: "h264", profile: "High", level: 40, width: 1920, height: 1080, bitDepth: 8, hdrFormat: "SDR" });
  insertStream(db, fileId, 1, { type: "audio", codec: "aac", channels: 2, isDefault: true, language: "eng" });
  insertStream(db, fileId, 2, { type: "audio", codec: "aac", channels: 6, language: "fre" });
  return { fileId };
}

test("normalizeLangCode: folds 2-letter and ISO 639-2 bibliographic variants onto one canonical code", () => {
  assert.equal(normalizeLangCode("fr"), "fra");
  assert.equal(normalizeLangCode("fre"), "fra");
  assert.equal(normalizeLangCode("fra"), "fra");
  assert.equal(normalizeLangCode("FRE"), "fra");
  assert.equal(normalizeLangCode(" ger "), "deu");
  assert.equal(normalizeLangCode("eng"), "eng");
  assert.equal(normalizeLangCode("xx"), "xx"); // unknown → verbatim, lowercased
  assert.equal(normalizeLangCode("ZUL"), "zul");
});

test("decide: pref.audioLang picks the matching track — the exact cost of an explicit pick (remux), never a transcode", () => {
  const db = getDb();
  const { fileId } = makeBilingualFile(db);
  // "fra" preference matches the "fre"-tagged track (B/T alias folding).
  const d = decide(fileId, baseCaps(), { prefs: { audioLang: "fra" } });
  assert.equal(d?.audioStreamIndex, 2);
  assert.equal(d?.mode, "remux");
  assert.equal(d?.reason, "non-default-audio-track-requested");
  // Mode parity with the explicit selection of the very same track: the
  // preference may never cost more than the user's own TrackMenu pick would.
  const explicit = decide(fileId, baseCaps(), { audioIdx: 2 });
  assert.equal(d?.mode, explicit?.mode);
  assert.notEqual(d?.mode, "transcode");
});

test("decide: pref.audioLang already satisfied by the default track keeps direct play (no pointless remux)", () => {
  const db = getDb();
  const movieId = insertMovie(db);
  const fileId = insertMediaFile(db, movieId, `Movie ${movieId}/Movie.mp4`, 120);
  insertStream(db, fileId, 0, { type: "video", codec: "h264", profile: "High", level: 40, width: 1920, height: 1080, bitDepth: 8 });
  // A NON-default French track listed before the default French one: the
  // default must still win — switching tracks for a language it already
  // speaks would trade direct play for a remux for nothing.
  insertStream(db, fileId, 1, { type: "audio", codec: "aac", channels: 2, language: "fre" });
  insertStream(db, fileId, 2, { type: "audio", codec: "aac", channels: 6, isDefault: true, language: "fra" });
  const d = decide(fileId, baseCaps(), { prefs: { audioLang: "fr" } });
  assert.equal(d?.mode, "direct");
  assert.equal(d?.audioStreamIndex, 2);
});

test("decide: pref.audioLang absent from the file -> untouched default behaviour", () => {
  const db = getDb();
  const { fileId } = makeBilingualFile(db);
  const d = decide(fileId, baseCaps(), { prefs: { audioLang: "ita" } });
  assert.equal(d?.mode, "direct");
  assert.equal(d?.audioStreamIndex, 1); // the default track
});

test("decide: an explicit audioIdx always wins over pref.audioLang", () => {
  const db = getDb();
  const { fileId } = makeBilingualFile(db);
  insertStream(db, fileId, 3, { type: "audio", codec: "aac", channels: 2, language: "jpn" });
  const d = decide(fileId, baseCaps(), { audioIdx: 3, prefs: { audioLang: "fre" } });
  assert.equal(d?.audioStreamIndex, 3);
});

test("decide: pref.subtitleLang preselects the TEXT track of that language without touching the mode", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  const subId = insertSubtitle(db, fileId, { streamIndex: 2, source: "embedded", language: "fre", format: "subrip", isText: true });
  const d = decide(fileId, baseCaps(), { prefs: { subtitleLang: "fra" } });
  assert.equal(d?.subtitleId, subId);
  assert.equal(d?.requiresBurnIn, false);
  assert.equal(d?.mode, "direct"); // a text subtitle never changes the mode
});

test("decide: pref.subtitleLang NEVER preselects a bitmap track — no preference-induced burn-in/transcode", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  insertSubtitle(db, fileId, { streamIndex: 2, source: "embedded", language: "fre", format: "pgs", isText: false });
  const d = decide(fileId, baseCaps(), { prefs: { subtitleLang: "fre" } });
  assert.equal(d?.subtitleId, null);
  assert.equal(d?.requiresBurnIn, false);
  assert.equal(d?.mode, "direct"); // the mode the file gets WITHOUT any subtitle request
});

test("decide: pref.subtitleLang prefers text over bitmap and non-forced over forced", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  insertSubtitle(db, fileId, { streamIndex: 2, source: "embedded", language: "fre", format: "pgs", isText: false });
  const forcedId = insertSubtitle(db, fileId, { streamIndex: 3, source: "embedded", language: "fre", format: "subrip", isText: true, isForced: true });
  const fullId = insertSubtitle(db, fileId, { streamIndex: 4, source: "embedded", language: "fre", format: "subrip", isText: true });
  const d = decide(fileId, baseCaps(), { prefs: { subtitleLang: "fre" } });
  assert.equal(d?.subtitleId, fullId);
  // With only the forced text track available, it still beats "nothing".
  const dbOnlyForced = getDb();
  const { fileId: fileB } = makeFullFile(dbOnlyForced);
  const onlyForcedId = insertSubtitle(dbOnlyForced, fileB, { streamIndex: 2, source: "embedded", language: "fre", format: "subrip", isText: true, isForced: true });
  assert.notEqual(onlyForcedId, forcedId);
  assert.equal(decide(fileB, baseCaps(), { prefs: { subtitleLang: "fre" } })?.subtitleId, onlyForcedId);
});

test("decide: pref.subtitleLang 'off' (or no pref) preselects nothing", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  insertSubtitle(db, fileId, { streamIndex: 2, source: "embedded", language: "fre", format: "subrip", isText: true });
  assert.equal(decide(fileId, baseCaps(), { prefs: { subtitleLang: "off" } })?.subtitleId, null);
  assert.equal(decide(fileId, baseCaps(), { prefs: {} })?.subtitleId, null);
  assert.equal(decide(fileId, baseCaps(), { prefs: { subtitleLang: null } })?.subtitleId, null);
});

test("decide: an explicit subtitleId always wins over pref.subtitleLang (an explicit bitmap pick MAY transcode)", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  insertSubtitle(db, fileId, { streamIndex: 2, source: "embedded", language: "fre", format: "subrip", isText: true });
  const bitmapId = insertSubtitle(db, fileId, { streamIndex: 3, source: "embedded", language: "eng", format: "pgs", isText: false });
  const d = decide(fileId, baseCaps(), { subtitleId: bitmapId, prefs: { subtitleLang: "fre" } });
  assert.equal(d?.subtitleId, bitmapId);
  assert.equal(d?.requiresBurnIn, true);
  assert.equal(d?.mode, "transcode"); // the USER asked for the burn-in — allowed
});

// ============================================================================
// decide() — chapters exposure (start/end/title, end derived from neighbours)
// ============================================================================

test("decide: no chapters column -> empty chapters array (never undefined)", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  assert.deepEqual(decide(fileId, baseCaps())?.chapters, []);
});

test("decide: stored ffprobe chapters ({start,title} rows) come back with derived ends", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db); // duration 120
  db.prepare("UPDATE media_files SET chapters = ? WHERE id = ?").run(
    JSON.stringify([
      { start: 0, title: "Intro" },
      { start: 30, title: "Chapter 1" },
      { start: 100, title: "Générique de fin" },
    ]),
    fileId,
  );
  const d = decide(fileId, baseCaps());
  assert.deepEqual(d?.chapters, [
    { start: 0, end: 30, title: "Intro" },
    { start: 30, end: 100, title: "Chapter 1" },
    { start: 100, end: 120, title: "Générique de fin" },
  ]);
});

test("decide: a malformed chapters column degrades to an empty list, never a crash", () => {
  const db = getDb();
  const { fileId } = makeFullFile(db);
  db.prepare("UPDATE media_files SET chapters = ? WHERE id = ?").run("{not json", fileId);
  assert.deepEqual(decide(fileId, baseCaps())?.chapters, []);
});

test("parseChapters: null/malformed/non-array input -> []", () => {
  assert.deepEqual(parseChapters(null, 120), []);
  assert.deepEqual(parseChapters("", 120), []);
  assert.deepEqual(parseChapters("{not json", 120), []);
  assert.deepEqual(parseChapters('{"start":0}', 120), []);
  assert.deepEqual(parseChapters("42", 120), []);
});

test("parseChapters: drops rows without a finite non-negative numeric start, coerces bad titles to null", () => {
  const raw = JSON.stringify([{ start: 0, title: "Ok" }, { start: "10", title: "Bad start" }, { title: "No start" }, null, { start: -5 }, { start: 60, title: 42 }]);
  assert.deepEqual(parseChapters(raw, 120), [
    { start: 0, end: 60, title: "Ok" },
    { start: 60, end: 120, title: null },
  ]);
});

test("parseChapters: re-sorts by start so a shuffled column still yields coherent ends", () => {
  const raw = JSON.stringify([
    { start: 50, title: "B" },
    { start: 0, title: "A" },
  ]);
  assert.deepEqual(parseChapters(raw, 120), [
    { start: 0, end: 50, title: "A" },
    { start: 50, end: 120, title: "B" },
  ]);
});

test("parseChapters: unknown duration -> the last chapter gets a zero-length end (its own start), not a lie", () => {
  const raw = JSON.stringify([
    { start: 0, title: "A" },
    { start: 50, title: "B" },
  ]);
  assert.deepEqual(parseChapters(raw, 0), [
    { start: 0, end: 50, title: "A" },
    { start: 50, end: 50, title: "B" },
  ]);
});

test("getFileStreamsForPlayback: returns null for a missing file, and parses cached keyframes", () => {
  assert.equal(getFileStreamsForPlayback(999_999), null);
  const db = getDb();
  const movieId = insertMovie(db);
  const fileId = insertMediaFile(db, movieId, `Movie ${movieId}/Movie.mp4`, 42);
  insertStream(db, fileId, 0, { type: "video", codec: "h264", width: 1920, height: 1080, hdrFormat: "SDR" });
  db.prepare("UPDATE media_files SET keyframes = ? WHERE id = ?").run(JSON.stringify([0, 4, 8]), fileId);
  const info = getFileStreamsForPlayback(fileId);
  assert.deepEqual(info?.keyframes, [0, 4, 8]);
  assert.equal(info?.video?.streamIndex, 0);
  assert.equal(info?.duration, 42);
});

// ============================================================================
// parseClientCaps validation
// ============================================================================

test("parseClientCaps: rejects malformed input, accepts well-formed caps", () => {
  assert.equal(parseClientCaps(null), null);
  assert.equal(parseClientCaps({}), null);
  assert.equal(parseClientCaps({ containers: "mp4", audio: [], video: [] }), null);
  assert.equal(parseClientCaps({ containers: [], audio: [], video: [{ codec: 123 }] }), null);
  const ok = parseClientCaps({ containers: ["mp4"], audio: ["aac"], video: [{ codec: "h264", maxLevel: 51 }], maxWidth: 3840, maxHeight: 2160, hdr: true });
  assert.deepEqual(ok, { containers: ["mp4"], audio: ["aac"], video: [{ codec: "h264", maxLevel: 51 }], maxWidth: 3840, maxHeight: 2160, hdr: true });
  assert.equal(MINIMAL_CAPS.video.length, 0);
});

// ============================================================================
// parseRange (stream route)
// ============================================================================

test("parseRange: no header -> null (whole-file response)", () => {
  assert.equal(parseRange(null, 1000), null);
});

test("parseRange: standard start-end range", () => {
  assert.deepEqual(parseRange("bytes=0-499", 1000), { start: 0, end: 499 });
});

test("parseRange: open-ended range clamps to fileSize-1", () => {
  assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
});

test("parseRange: suffix range (last N bytes)", () => {
  assert.deepEqual(parseRange("bytes=-500", 1000), { start: 500, end: 999 });
});

test("parseRange: suffix larger than the file clamps start to 0", () => {
  assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
});

test("parseRange: malformed / unsatisfiable ranges are all 'invalid'", () => {
  assert.equal(parseRange("bytes=abc-def", 1000), "invalid");
  assert.equal(parseRange("bytes=-0", 1000), "invalid");
  assert.equal(parseRange("bytes=1000-1005", 1000), "invalid"); // start >= fileSize
  assert.equal(parseRange("bytes=500-100", 1000), "invalid"); // end < start
  assert.equal(parseRange("bytes=", 1000), "invalid");
});

test("parseRange: a syntactically valid multipart range is ignored (full 200 body), never a 416", () => {
  // RFC 9110-legal multi-ranges some TV/UPnP players emit — we don't serve
  // multipart/byteranges, and the conformant fallback is to ignore the header.
  assert.equal(parseRange("bytes=0-99,200-299", 1000), null);
  assert.equal(parseRange("bytes=0-99, 200-299, -100", 1000), null);
  assert.equal(parseRange("bytes=0-, 500-999", 1000), null);
});

test("parseRange: a malformed multi-range list stays 'invalid' (416)", () => {
  assert.equal(parseRange("bytes=0-99,abc-def", 1000), "invalid");
  assert.equal(parseRange("bytes=,", 1000), "invalid");
  assert.equal(parseRange("bytes=0-99,-", 1000), "invalid");
});

// ============================================================================
// ifRangeAllowsPartial (stream route cache validators)
// ============================================================================

test("ifRangeAllowsPartial: absent header lets the Range stand on its own", () => {
  assert.equal(ifRangeAllowsPartial(null, '"abc-123"', Date.now()), true);
});

test("ifRangeAllowsPartial: entity-tag form matches only the exact strong ETag", () => {
  const mtimeMs = Date.UTC(2026, 0, 2, 3, 4, 5, 250);
  assert.equal(ifRangeAllowsPartial('"abc-123"', '"abc-123"', mtimeMs), true);
  assert.equal(ifRangeAllowsPartial('"stale-etag"', '"abc-123"', mtimeMs), false);
  // Weak validators are never acceptable for ranges (RFC 9110 §13.1.5).
  assert.equal(ifRangeAllowsPartial('W/"abc-123"', '"abc-123"', mtimeMs), false);
});

test("ifRangeAllowsPartial: date form only matches when the file hasn't changed since", () => {
  const mtimeMs = Date.UTC(2026, 0, 2, 3, 4, 5, 250);
  assert.equal(ifRangeAllowsPartial(new Date(mtimeMs).toUTCString(), '"e"', mtimeMs), true);
  assert.equal(ifRangeAllowsPartial(new Date(mtimeMs - 5_000).toUTCString(), '"e"', mtimeMs), false); // file replaced since
  assert.equal(ifRangeAllowsPartial("not-a-date", '"e"', mtimeMs), false);
});

// ============================================================================
// Segment filename allowlist
// ============================================================================

test("SEGMENT_NAME_RE: accepts exactly the three legal asset names", () => {
  assert.ok(Sessions.SEGMENT_NAME_RE.test("stream.m3u8"));
  assert.ok(Sessions.SEGMENT_NAME_RE.test("init.mp4"));
  assert.ok(Sessions.SEGMENT_NAME_RE.test("seg00000.m4s"));
  assert.ok(Sessions.SEGMENT_NAME_RE.test("seg12345.m4s"));
});

test("SEGMENT_NAME_RE: rejects anything else, including path traversal and case variants", () => {
  for (const bad of ["seg0.m4s", "seg000000.m4s", "../../etc/passwd", "seg00001.mp4", "STREAM.M3U8", "init.mp4.bak", "seg-0001.m4s", "", "stream.m3u8/../x"]) {
    assert.equal(Sessions.SEGMENT_NAME_RE.test(bad), false, `expected "${bad}" to be rejected`);
  }
});

// ============================================================================
// isRemuxCopyableAudio — the fMP4 stream-copy allowlist
// ============================================================================

test("isRemuxCopyableAudio: only codecs fMP4 can carry via -c:a copy", () => {
  // Copyable into MP4/fMP4.
  for (const c of ["aac", "ac3", "eac3", "mp3", "opus", "alac", "AAC", "AC3"]) {
    assert.equal(Sessions.isRemuxCopyableAudio(c), true, `${c} should be copyable`);
  }
  // Must transcode even when the browser can decode them natively — MP4 can't
  // stream-copy these (FLAC-in-MP4 is "experimental" and aborts ffmpeg).
  for (const c of ["flac", "dts", "truehd", "vorbis", "pcm_s16le", "FLAC", "", null, undefined]) {
    assert.equal(Sessions.isRemuxCopyableAudio(c as string | null), false, `${JSON.stringify(c)} should not be copyable`);
  }
});

// ============================================================================
// computeSegmentBoundaries / buildPlaylist (pure)
// ============================================================================

test("computeSegmentBoundaries: uniform grid when no keyframe index is available", () => {
  assert.deepEqual(Sessions.computeSegmentBoundaries(10, null), [0, 4, 8, 10]);
});

test("computeSegmentBoundaries: snaps each boundary to the next real keyframe at/after the target", () => {
  assert.deepEqual(Sessions.computeSegmentBoundaries(10, [0, 3.5, 4.2, 8.1, 9]), [0, 4.2, 8.1, 10]);
});

test("computeSegmentBoundaries: a sparse keyframe tail merges the remainder into one final segment", () => {
  assert.deepEqual(Sessions.computeSegmentBoundaries(20, [0, 3]), [0, 20]);
});

test("computeSegmentBoundaries: non-positive duration degrades to a single zero-length placeholder", () => {
  assert.deepEqual(Sessions.computeSegmentBoundaries(0, null), [0, 0]);
});

test("buildPlaylist: renders a complete static VOD manifest with real per-segment durations", () => {
  const playlist = Sessions.buildPlaylist([0, 4, 8, 10]);
  const lines = playlist.trim().split("\n");
  assert.equal(lines[0], "#EXTM3U");
  assert.ok(lines.includes("#EXT-X-PLAYLIST-TYPE:VOD"));
  assert.ok(lines.includes('#EXT-X-MAP:URI="init.mp4"'));
  assert.equal(lines.at(-1), "#EXT-X-ENDLIST");
  assert.ok(lines.includes("#EXTINF:4.000,"));
  assert.ok(lines.includes("#EXTINF:2.000,"));
  assert.ok(lines.includes("seg00000.m4s"));
  assert.ok(lines.includes("seg00002.m4s"));
  assert.equal(lines.filter((l) => l.startsWith("#EXTINF")).length, 3);
});

test("contiguousMaxProducedIndex: stops at the first hole so stale segments from an earlier run don't count", () => {
  assert.equal(Sessions.contiguousMaxProducedIndex([0, 1, 2, 7, 8], 0), 2); // 7/8 are leftovers from a previous run
  assert.equal(Sessions.contiguousMaxProducedIndex([7, 8], 7), 8);
  assert.equal(Sessions.contiguousMaxProducedIndex([0, 1, 2], 5), 4); // nothing produced yet from THIS run
  assert.equal(Sessions.contiguousMaxProducedIndex([], 0), -1);
});

// ============================================================================
// ffmpeg argv builders (pure — no spawning)
// ============================================================================

test("buildRemuxArgs: -c:v copy always, no seek flags on a cold start", () => {
  const args = Sessions.buildRemuxArgs({ absPath: "/media/f.mkv", videoStreamIndex: 0, audioStreamIndex: 1, audioNeedsTranscode: false, startNumber: 0, seekTo: null, dir: "/tmp/s" });
  assert.ok(args.includes("-i"));
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 3), ["-map", "0:0", "-c:v"]);
  assert.ok(args.join(" ").includes("-c:v copy"));
  assert.ok(args.join(" ").includes("-map 0:1 -c:a copy"));
  assert.equal(args.includes("-ss"), false);
  assert.equal(args.includes("-copyts"), false);
});

test("buildRemuxArgs: seeking adds -ss before -i and the copyts/start_at_zero/muxdelay trio", () => {
  const args = Sessions.buildRemuxArgs({ absPath: "/media/f.mkv", videoStreamIndex: 0, audioStreamIndex: 1, audioNeedsTranscode: false, startNumber: 5, seekTo: 20, dir: "/tmp/s" });
  const ssIdx = args.indexOf("-ss");
  const iIdx = args.indexOf("-i");
  assert.ok(ssIdx >= 0 && ssIdx < iIdx);
  assert.equal(args[ssIdx + 1], "20.000");
  assert.ok(args.includes("-copyts"));
  assert.ok(args.includes("-start_at_zero"));
  assert.ok(args.includes("-muxdelay"));
  assert.ok(args.includes("-start_number"));
  assert.equal(args[args.indexOf("-start_number") + 1], "5");
});

test("buildRemuxArgs: an unsupported audio codec is transcoded to AAC while video stays copy", () => {
  const args = Sessions.buildRemuxArgs({ absPath: "/media/f.mkv", videoStreamIndex: 0, audioStreamIndex: 1, audioNeedsTranscode: true, startNumber: 0, seekTo: null, dir: "/tmp/s" });
  assert.ok(args.join(" ").includes("-c:v copy"));
  assert.ok(args.join(" ").includes("-c:a aac"));
  assert.equal(args.includes("-b:a"), true);
});

test("buildTranscodeArgs: high-quality libx264 ladder, no filter_complex without burn-in", () => {
  const args = Sessions.buildTranscodeArgs({
    absPath: "/media/f.mkv",
    videoStreamIndex: 0,
    audioStreamIndex: 1,
    audioNeedsTranscode: false,
    targetHeight: 1080,
    sourceHeight: 2160,
    hdrFormat: "SDR",
    zscaleAvailable: true,
    burnInSubtitleStreamIndex: null,
    startNumber: 0,
    seekTo: null,
    dir: "/tmp/s",
  });
  assert.ok(args.includes("-crf"));
  assert.equal(args[args.indexOf("-crf") + 1], "18");
  assert.ok(args.includes("libx264"));
  assert.equal(args.includes("-filter_complex"), false);
  assert.ok(args.includes("-vf"));
  assert.equal(args[args.indexOf("-vf") + 1], "scale=-2:1080");
  assert.equal(args[args.indexOf("-maxrate") + 1], "8000k");
  assert.equal(args[args.indexOf("-bufsize") + 1], "16000k");
});

test("buildTranscodeArgs: HDR source + zscale available inserts the tonemap chain", () => {
  const args = Sessions.buildTranscodeArgs({
    absPath: "/media/f.mkv",
    videoStreamIndex: 0,
    audioStreamIndex: null,
    audioNeedsTranscode: false,
    targetHeight: 1080,
    sourceHeight: 1080,
    hdrFormat: "HDR10",
    zscaleAvailable: true,
    burnInSubtitleStreamIndex: null,
    startNumber: 0,
    seekTo: null,
    dir: "/tmp/s",
  });
  assert.match(args[args.indexOf("-vf") + 1], /^zscale=t=linear.*scale=-2:1080$/);
});

test("buildTranscodeArgs: burn-in subtitle uses filter_complex + [outv] map instead of -vf", () => {
  const args = Sessions.buildTranscodeArgs({
    absPath: "/media/f.mkv",
    videoStreamIndex: 0,
    audioStreamIndex: 1,
    audioNeedsTranscode: false,
    targetHeight: 1080,
    sourceHeight: 1080,
    hdrFormat: "SDR",
    zscaleAvailable: false,
    burnInSubtitleStreamIndex: 3,
    startNumber: 0,
    seekTo: null,
    dir: "/tmp/s",
  });
  assert.equal(args.includes("-vf"), false);
  assert.ok(args.includes("-filter_complex"));
  assert.match(args[args.indexOf("-filter_complex") + 1], /\[0:3\]overlay\[outv\]$/);
  assert.ok(args.includes("[outv]"));
});

test("hls output args write segments via temp_file so a request can never see a half-written segment", () => {
  const remux = Sessions.buildRemuxArgs({ absPath: "/media/f.mkv", videoStreamIndex: 0, audioStreamIndex: 1, audioNeedsTranscode: false, startNumber: 0, seekTo: null, dir: "/tmp/s" });
  assert.equal(remux[remux.indexOf("-hls_flags") + 1], "temp_file");
  const transcode = Sessions.buildTranscodeArgs({
    absPath: "/media/f.mkv",
    videoStreamIndex: 0,
    audioStreamIndex: 1,
    audioNeedsTranscode: false,
    targetHeight: 1080,
    sourceHeight: 1080,
    hdrFormat: "SDR",
    zscaleAvailable: false,
    burnInSubtitleStreamIndex: null,
    startNumber: 0,
    seekTo: null,
    dir: "/tmp/s",
  });
  assert.equal(transcode[transcode.indexOf("-hls_flags") + 1], "temp_file");
});

// ============================================================================
// Real ffmpeg session lifecycle (spawn, serve, cap, ownership, teardown)
// ============================================================================

function fullCapsForClip(): ClientCaps {
  // Forces remux (video codec matches, container doesn't) so these tests stay
  // fast — a real -c:v copy remux of a 6s clip completes almost instantly.
  return { containers: [], video: [{ codec: "h264" }], audio: ["aac"], maxWidth: 1920, maxHeight: 1080, hdr: false };
}

let clipCopyCounter = 0;

// media_files.filepath is UNIQUE, so each call needs its own path — hardlink
// the one generated clip under a fresh name rather than re-encoding per test.
function insertClipRow(db: DB): number {
  clipCopyCounter++;
  const rel = clipCopyCounter === 1 ? CLIP_REL : path.join("Real Movie (2020)", `Real Movie ${clipCopyCounter}.mp4`);
  const abs = path.join(tmpMedia, rel);
  if (!fs.existsSync(abs)) fs.linkSync(CLIP_ABS, abs);

  const movieId = insertMovie(db);
  const fileId = insertMediaFile(db, movieId, rel, CLIP_DURATION);
  insertStream(db, fileId, 0, { type: "video", codec: "h264", width: 320, height: 240, hdrFormat: "SDR" });
  insertStream(db, fileId, 1, { type: "audio", codec: "aac", channels: 2, isDefault: true });
  return fileId;
}

test("createSession: real remux session spawns ffmpeg and serves playlist/init/segment", async () => {
  const db = getDb();
  const fileId = insertClipRow(db);
  const result = await Sessions.createSession({ fileId, userId: 1, deviceId: "dev-remux-1", caps: fullCapsForClip() });
  assert.equal(result.ok, true);
  if (!result.ok || result.mode === "direct") throw new Error("expected a remux session");
  assert.equal(result.mode, "remux");

  try {
    const session = Sessions.getOwnedSession(result.id, 1);
    assert.ok(session);
    if (!session) return;

    const playlist = await Sessions.getSessionAsset(session, "stream.m3u8");
    assert.equal(playlist.kind, "playlist");
    if (playlist.kind !== "playlist") return;
    assert.match(playlist.body, /^#EXTM3U/);
    assert.match(playlist.body, /#EXT-X-ENDLIST/);
    const segCount = (playlist.body.match(/#EXTINF/g) ?? []).length;
    assert.ok(segCount >= 2, `expected several segments from a ${CLIP_DURATION}s 1s-GOP clip, got ${segCount}`);

    const init = await Sessions.getSessionAsset(session, "init.mp4");
    assert.equal(init.kind, "file");
    if (init.kind === "file") assert.ok(fs.statSync(init.path).size > 0, "init.mp4 was served empty");

    const seg0 = await Sessions.getSessionAsset(session, "seg00000.m4s");
    assert.equal(seg0.kind, "file");
    if (seg0.kind === "file") assert.ok(fs.statSync(seg0.path).size > 0);

    // Jump straight to the LAST segment, well beyond what a freshly-spawned
    // process could have produced yet — this must trigger a kill + reseek
    // (getSessionAsset's internal "beyond production horizon" branch) rather
    // than just waiting, and still resolve within the poll timeout.
    const lastIdx = segCount - 1;
    const lastName = `seg${String(lastIdx).padStart(5, "0")}.m4s`;
    const last = await Sessions.getSessionAsset(session, lastName);
    assert.equal(last.kind, "file");
    if (last.kind === "file") assert.ok(fs.statSync(last.path).size > 0);
  } finally {
    Sessions.destroySession(result.id, 1);
  }
});

test("getSessionAsset: init.mp4 requested first is never served empty (the 0-byte-init race)", async () => {
  const db = getDb();
  const fileId = insertClipRow(db);
  const result = await Sessions.createSession({ fileId, userId: 1, deviceId: "dev-init-race", caps: fullCapsForClip() });
  assert.equal(result.ok, true);
  if (!result.ok || result.mode === "direct") throw new Error("expected a remux session");
  try {
    const session = Sessions.getOwnedSession(result.id, 1);
    assert.ok(session);
    if (!session) return;
    // Request init.mp4 as the VERY FIRST asset, right after createSession
    // returns — this is the window in which ffmpeg has created the file but
    // not yet flushed its ftyp+moov, so it's present-but-empty. getSessionAsset
    // must wait it out (assetReady gate) and never hand back a zero-byte init,
    // which would kill hls.js before the first frame.
    const init = await Sessions.getSessionAsset(session, "init.mp4");
    assert.equal(init.kind, "file", "init.mp4 should resolve to a file, not time out");
    if (init.kind === "file") assert.ok(fs.statSync(init.path).size > 0, "init.mp4 was served before ffmpeg wrote it (0 bytes)");
  } finally {
    Sessions.destroySession(result.id, 1);
  }
});

test("createSession: cross-user access is denied — a session is only visible to its owner", async () => {
  const db = getDb();
  const fileId = insertClipRow(db);
  const result = await Sessions.createSession({ fileId, userId: 1, deviceId: "dev-owner", caps: fullCapsForClip() });
  assert.equal(result.ok, true);
  if (!result.ok || result.mode === "direct") throw new Error("expected a remux session");
  try {
    assert.equal(Sessions.getOwnedSession(result.id, 2), null); // wrong user
    assert.ok(Sessions.getOwnedSession(result.id, 1)); // right user
    assert.equal(Sessions.destroySession(result.id, 2), false); // can't destroy someone else's
    assert.ok(Sessions.getOwnedSession(result.id, 1)); // ...and it's still alive
  } finally {
    Sessions.destroySession(result.id, 1);
  }
});

test("createSession: same (user, device) reusing a session replaces it without touching the capacity cap", async () => {
  const db = getDb();
  const fileId = insertClipRow(db);
  const first = await Sessions.createSession({ fileId, userId: 7, deviceId: "dev-reuse", caps: fullCapsForClip() });
  assert.equal(first.ok, true);
  if (!first.ok || first.mode === "direct") throw new Error("expected remux");
  try {
    const second = await Sessions.createSession({ fileId, userId: 7, deviceId: "dev-reuse", caps: fullCapsForClip() });
    assert.equal(second.ok, true);
    if (!second.ok || second.mode === "direct") throw new Error("expected remux");
    assert.notEqual(second.id, first.id);
    assert.equal(Sessions.getOwnedSession(first.id, 7), null); // replaced
    assert.ok(Sessions.getOwnedSession(second.id, 7));
    Sessions.destroySession(second.id, 7);
  } finally {
    Sessions.destroySession(first.id, 7);
  }
});

function waitForExit(proc: import("child_process").ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once("exit", () => resolve());
  });
}

test("getSessionAsset: init.mp4 with a dead process triggers one respawn instead of a guaranteed timeout", async () => {
  const db = getDb();
  const fileId = insertClipRow(db);
  const result = await Sessions.createSession({ fileId, userId: 5, deviceId: "dev-init-respawn", caps: fullCapsForClip() });
  assert.equal(result.ok, true);
  if (!result.ok || result.mode === "direct") throw new Error("expected a remux session");
  try {
    const session = Sessions.getOwnedSession(result.id, 5);
    assert.ok(session);
    if (!session) return;

    // Let the first run prove it works, then kill it and wipe its output —
    // simulating a spawn that died before producing anything.
    const first = await Sessions.getSessionAsset(session, "init.mp4");
    assert.equal(first.kind, "file");
    const proc = session.proc;
    assert.ok(proc);
    proc?.kill("SIGKILL");
    if (proc) await waitForExit(proc);
    for (const entry of fs.readdirSync(session.dir)) fs.rmSync(path.join(session.dir, entry), { force: true });

    const second = await Sessions.getSessionAsset(session, "init.mp4");
    assert.equal(second.kind, "file");
  } finally {
    Sessions.destroySession(result.id, 5);
  }
});

test("getSessionAsset: two concurrent reseek requests share ONE respawn — the second never kills the first's fresh ffmpeg", async () => {
  const db = getDb();
  const fileId = insertClipRow(db);
  // Transcode mode: its respawn path awaits (hasZscale) between the kill and
  // the new spawn, which is exactly the window where the old code let a second
  // concurrent request fire its own kill + respawn.
  const transcodeCaps: ClientCaps = { containers: [], video: [], audio: ["aac"], maxWidth: 1920, maxHeight: 1080, hdr: false };
  const result = await Sessions.createSession({ fileId, userId: 6, deviceId: "dev-respawn-race", caps: transcodeCaps });
  assert.equal(result.ok, true);
  if (!result.ok || result.mode === "direct") throw new Error("expected a transcode session");
  assert.equal(result.mode, "transcode");
  try {
    const session = Sessions.getOwnedSession(result.id, 6);
    assert.ok(session);
    if (!session) return;

    // Kill the initial run and clear its segments so BOTH requests below
    // genuinely need a respawn.
    const init = await Sessions.getSessionAsset(session, "init.mp4");
    assert.equal(init.kind, "file");
    const proc = session.proc;
    proc?.kill("SIGKILL");
    if (proc) await waitForExit(proc);
    for (const entry of fs.readdirSync(session.dir)) {
      if (entry.startsWith("seg")) fs.rmSync(path.join(session.dir, entry), { force: true });
    }

    const [a, b] = await Promise.all([Sessions.getSessionAsset(session, "seg00001.m4s"), Sessions.getSessionAsset(session, "seg00002.m4s")]);
    assert.equal(a.kind, "file");
    assert.equal(b.kind, "file");
    // Serialisation proof: exactly one respawn happened, for the FIRST request
    // — the second waited it out and found its segment within the production
    // horizon. (The old code respawned twice: the second kill orphaned the
    // first ffmpeg and left currentStartNumber at 2.)
    assert.equal(session.currentStartNumber, 1);
  } finally {
    Sessions.destroySession(result.id, 6);
  }
});

test("createSession: exceeding FLIX_MAX_TRANSCODES (=1 for this test run) returns 429 on a second concurrent session", async () => {
  const db = getDb();
  const fileId = insertClipRow(db);
  const first = await Sessions.createSession({ fileId, userId: 42, deviceId: "dev-a", caps: fullCapsForClip() });
  assert.equal(first.ok, true);
  if (!first.ok || first.mode === "direct") throw new Error("expected remux");
  try {
    const second = await Sessions.createSession({ fileId, userId: 42, deviceId: "dev-b", caps: fullCapsForClip() });
    assert.equal(second.ok, false);
    if (second.ok) throw new Error("expected capacity rejection");
    assert.equal(second.status, 429);
  } finally {
    Sessions.destroySession(first.id, 42);
  }
});

test("createSession: CONCURRENT requests can't all slip past the capacity cap while the first is still starting", async () => {
  const db = getDb();
  const fileIdA = insertClipRow(db);
  const fileIdB = insertClipRow(db);
  // Both fired before either finishes starting up: the slot must be reserved
  // synchronously, or the long awaits inside createSession (path resolution,
  // keyframe indexing) would let both pass the sessions.size check.
  const [a, b] = await Promise.all([
    Sessions.createSession({ fileId: fileIdA, userId: 50, deviceId: "dev-cc-a", caps: fullCapsForClip() }),
    Sessions.createSession({ fileId: fileIdB, userId: 51, deviceId: "dev-cc-b", caps: fullCapsForClip() }),
  ]);
  try {
    const succeeded = [a, b].filter((r) => r.ok);
    assert.equal(succeeded.length, 1, "exactly one of the two concurrent requests may win the single slot");
    const rejected = [a, b].find((r) => !r.ok);
    assert.ok(rejected && !rejected.ok);
    if (rejected && !rejected.ok) assert.equal(rejected.status, 429);
  } finally {
    for (const [r, uid] of [[a, 50], [b, 51]] as const) {
      if (r.ok && r.mode !== "direct") Sessions.destroySession(r.id, uid);
    }
  }
});

test("destroySession: kills the live ffmpeg process (SIGKILL sent)", async () => {
  const db = getDb();
  const fileId = insertClipRow(db);
  const result = await Sessions.createSession({ fileId, userId: 3, deviceId: "dev-kill", caps: fullCapsForClip() });
  assert.equal(result.ok, true);
  if (!result.ok || result.mode === "direct") throw new Error("expected remux");
  const session = Sessions.getOwnedSession(result.id, 3);
  const proc = session?.proc;
  Sessions.destroySession(result.id, 3);
  assert.equal(Sessions.getOwnedSession(result.id, 3), null);
  if (proc) assert.equal(proc.killed, true);
});

test("killAllSessions: tears down every live session and process, regardless of owner", async () => {
  const db = getDb();
  const fileIdA = insertClipRow(db);
  const fileIdB = insertClipRow(db);
  const a = await Sessions.createSession({ fileId: fileIdA, userId: 10, deviceId: "dev-x", caps: fullCapsForClip() });
  assert.equal(a.ok, true);
  if (!a.ok || a.mode === "direct") throw new Error("expected remux");
  Sessions.destroySession(a.id, 10); // free the single slot for this run's cap
  const b = await Sessions.createSession({ fileId: fileIdB, userId: 11, deviceId: "dev-y", caps: fullCapsForClip() });
  assert.equal(b.ok, true);
  if (!b.ok || b.mode === "direct") throw new Error("expected remux");

  const bSession = Sessions.getOwnedSession(b.id, 11);
  const proc = bSession?.proc;
  Sessions.killAllSessions();
  assert.equal(Sessions.getActiveSessionCount(), 0);
  assert.equal(Sessions.getOwnedSession(b.id, 11), null);
  if (proc) assert.equal(proc.killed, true);
  // A stale reference kept across killAllSessions must be marked too — an
  // in-flight segment request holding it may never respawn ffmpeg.
  assert.equal(bSession?.destroyed, true);
});

test("getSessionAsset: a stale reference to a DESTROYED session never respawns ffmpeg (immediate not-found)", async () => {
  const db = getDb();
  const fileId = insertClipRow(db);
  const result = await Sessions.createSession({ fileId, userId: 8, deviceId: "dev-destroyed", caps: fullCapsForClip() });
  assert.equal(result.ok, true);
  if (!result.ok || result.mode === "direct") throw new Error("expected remux");
  const session = Sessions.getOwnedSession(result.id, 8);
  assert.ok(session);
  if (!session) return;

  Sessions.destroySession(result.id, 8);
  assert.equal(session.destroyed, true);

  // Before the destroyed flag, proc === null here looked exactly like a
  // crashed process: the request respawned a fresh ffmpeg into a directory
  // being rm'd — an orphan even killAllSessions could no longer see.
  const started = Date.now();
  assert.deepEqual(await Sessions.getSessionAsset(session, "seg00000.m4s"), { kind: "not-found" });
  assert.deepEqual(await Sessions.getSessionAsset(session, "init.mp4"), { kind: "not-found" });
  assert.equal(session.proc, null); // nothing was respawned
  assert.ok(Date.now() - started < 5_000, "a destroyed session must answer immediately, not poll");
});

test("getSessionAsset: a segment whose ffmpeg is dead fails fast instead of polling out the full 20s deadline", async () => {
  const db = getDb();
  const fileId = insertClipRow(db);
  const result = await Sessions.createSession({ fileId, userId: 9, deviceId: "dev-dead-poll", caps: fullCapsForClip() });
  assert.equal(result.ok, true);
  if (!result.ok || result.mode === "direct") throw new Error("expected remux");
  try {
    const session = Sessions.getOwnedSession(result.id, 9);
    assert.ok(session);
    if (!session) return;
    const init = await Sessions.getSessionAsset(session, "init.mp4");
    assert.equal(init.kind, "file");

    // Kill ffmpeg and point the session at a nonexistent source: the respawn
    // this request triggers dies instantly (ENOSPC / corrupt source / missing
    // binary all look the same), so the segment can never appear.
    const proc = session.proc;
    proc?.kill("SIGKILL");
    if (proc) await waitForExit(proc);
    for (const entry of fs.readdirSync(session.dir)) {
      if (entry.startsWith("seg")) fs.rmSync(path.join(session.dir, entry), { force: true });
    }
    session.absPath = path.join(tmpMedia, "definitely-missing.mp4");

    const started = Date.now();
    const asset = await Sessions.getSessionAsset(session, "seg00001.m4s");
    const elapsed = Date.now() - started;
    assert.equal(asset.kind, "timeout");
    assert.ok(elapsed < 10_000, `dead-process segment poll must break early, took ${elapsed}ms`);
  } finally {
    Sessions.destroySession(result.id, 9);
  }
});

test("indexKeyframesForFile: concurrent calls for the same file share ONE in-flight ffprobe", async () => {
  const p1 = Sessions.indexKeyframesForFile(987_654, CLIP_ABS);
  const p2 = Sessions.indexKeyframesForFile(987_654, CLIP_ABS);
  assert.equal(p1, p2); // same in-flight promise — never a second concurrent ffprobe
  const kf = await p1;
  assert.ok(kf && kf.length >= 2, "the real clip has several keyframes");
  const p3 = Sessions.indexKeyframesForFile(987_654, CLIP_ABS);
  assert.notEqual(p3, p1); // the finally released the slot once settled
  await p3;
});

test("probeFfmpegAvailable: memoised probe reports the real ffmpeg as available", async () => {
  const p1 = Sessions.probeFfmpegAvailable();
  const p2 = Sessions.probeFfmpegAvailable();
  assert.equal(p1, p2); // one spawn per process — health never probes per request
  assert.equal(await p1, true);
});

test("createSession: at capacity, an idle session whose ffmpeg already died is evicted instead of a 429", async () => {
  const db = getDb();
  const fileIdA = insertClipRow(db);
  const fileIdB = insertClipRow(db);
  const first = await Sessions.createSession({ fileId: fileIdA, userId: 60, deviceId: "dev-evict-a", caps: fullCapsForClip() });
  assert.equal(first.ok, true);
  if (!first.ok || first.mode === "direct") throw new Error("expected remux");
  const session = Sessions.getOwnedSession(first.id, 60);
  assert.ok(session);
  if (!session) return;

  // Simulate the idle-kill scenario: ffmpeg long dead, last access beyond the
  // 60s idle window — yet still counted against the cap until the 5min purge.
  const proc = session.proc;
  proc?.kill("SIGKILL");
  if (proc) await waitForExit(proc);
  session.lastAccess = Date.now() - 61_000;

  const second = await Sessions.createSession({ fileId: fileIdB, userId: 61, deviceId: "dev-evict-b", caps: fullCapsForClip() });
  try {
    assert.equal(second.ok, true, "the dead idle session must be evicted, not answered with a 429");
    if (!second.ok || second.mode === "direct") throw new Error("expected remux");
    assert.equal(Sessions.getOwnedSession(first.id, 60), null); // the corpse is gone
  } finally {
    if (second.ok && second.mode !== "direct") Sessions.destroySession(second.id, 61);
    Sessions.destroySession(first.id, 60); // no-op when already evicted
  }
});
