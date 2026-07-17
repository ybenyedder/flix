// Pure, testable helpers extracted from sessions.ts: HLS segment-boundary math,
// static VOD playlist rendering, the segment-name allowlist, and the ffmpeg
// argument-vector builders (remux / transcode / hls output). Everything here is
// side-effect-free — no getConfig, no Session state, no module-level session
// map, no spawn, no filesystem — so the exact argv and boundary/playlist output
// can be unit-tested without a real ffmpeg binary. sessions.ts imports what it
// needs from this module and re-exports the public symbols, so nothing this
// module holds may import back from sessions.ts (would create a cycle).

import path from "path";

export const SEG_SECONDS = 4;

// ---------------------------------------------------------------------------
// Pure helpers — segment boundary math and playlist rendering never touch the
// filesystem or ffmpeg, so they're fully unit-testable.
// ---------------------------------------------------------------------------

/** Compute segment boundary timestamps `[0, b1, b2, …, totalDuration]` (n+1
 *  entries describe n segments). With a keyframe list, boundary n is the first
 *  keyframe at/after n*segSeconds (matching how ffmpeg's own `-c copy` HLS
 *  segmenter cuts); without one (transcode, or an unindexed/failed remux), it
 *  falls back to a uniform n*segSeconds grid. */
export function computeSegmentBoundaries(totalDuration: number, keyframes: number[] | null, segSeconds = SEG_SECONDS): number[] {
  if (!(totalDuration > 0)) return [0, 0];
  const boundaries = [0];
  if (keyframes && keyframes.length) {
    const sorted = [...keyframes].filter((k) => k > 0 && k < totalDuration).sort((a, b) => a - b);
    let n = 1;
    // `target` and `last` both only increase, and a keyframe that fails a smaller
    // (target,last) can never satisfy a larger one — so a single forward scan of
    // sorted[] finds every boundary (O(n) instead of a find() from 0 each step).
    let i = 0;
    while (n * segSeconds < totalDuration) {
      const target = n * segSeconds;
      const last = boundaries[boundaries.length - 1];
      while (i < sorted.length && !(sorted[i] >= target && sorted[i] > last + 0.01)) i++;
      if (i >= sorted.length) break; // sparse tail — merge the remainder into one final segment
      boundaries.push(sorted[i]);
      i++;
      n++;
    }
  } else {
    let n = 1;
    while (n * segSeconds < totalDuration) {
      boundaries.push(n * segSeconds);
      n++;
    }
  }
  boundaries.push(totalDuration);
  return boundaries;
}

/** Render the complete, static VOD manifest for a session's full duration —
 *  every segment is declared up front (with `#EXT-X-ENDLIST`) so a player can
 *  request any index immediately, including seeking far ahead of what ffmpeg
 *  has produced so far. */
export function buildPlaylist(boundaries: number[]): string {
  const segCount = Math.max(1, boundaries.length - 1);
  const durations: number[] = [];
  for (let i = 0; i < segCount; i++) durations.push(Math.max(0, boundaries[i + 1] - boundaries[i]));
  const target = Math.max(1, Math.ceil(Math.max(SEG_SECONDS, ...durations)));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-MEDIA-SEQUENCE:0", '#EXT-X-MAP:URI="init.mp4"'];
  for (let i = 0; i < segCount; i++) {
    lines.push(`#EXTINF:${durations[i].toFixed(3)},`);
    lines.push(`seg${String(i).padStart(5, "0")}.m4s`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

export const SEGMENT_NAME_RE = /^(stream\.m3u8|init\.mp4|seg\d{5}\.m4s)$/;

function maxrateKbpsForHeight(height: number): number {
  if (height >= 2160) return 20_000;
  if (height >= 1440) return 12_000;
  if (height >= 1080) return 8_000;
  if (height >= 720) return 5_000;
  return 2_500;
}

// ---------------------------------------------------------------------------
// ffmpeg argument builders — pure (no spawning), so the exact argv is
// unit-testable without a real ffmpeg binary.
// ---------------------------------------------------------------------------

function hlsOutputArgs(dir: string, startNumber: number): string[] {
  return [
    "-f",
    "hls",
    "-hls_time",
    String(SEG_SECONDS),
    "-hls_segment_type",
    "fmp4",
    // Write each segment to a ".tmp" name and rename it atomically once
    // complete — getSessionAsset serves a segment as soon as fs.existsSync
    // sees it, so without this a request landing mid-write would stream a
    // truncated segment to the player.
    "-hls_flags",
    "temp_file",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_filename",
    path.join(dir, "seg%05d.m4s"),
    "-hls_playlist_type",
    "vod",
    "-start_number",
    String(startNumber),
    // ffmpeg's own manifest is never served (see file header) — kept under a
    // name the segment route's strict allowlist will never match.
    path.join(dir, "ffmpeg-internal.m3u8"),
  ];
}

// Audio codecs ffmpeg can `-c:a copy` into the fMP4 (HLS) segments this path
// produces. FLAC/DTS/TrueHD/PCM/Vorbis cannot be copied into MP4 — ffmpeg treats
// FLAC-in-MP4 as experimental and aborts ("Could not write header … Experimental
// feature"), killing the whole remux — so they MUST be re-encoded even when the
// browser could decode them from a native file. The remux CONTAINER is the
// constraint here, not the client's decoder (which `audioTrack.supported` covers).
const FMP4_COPYABLE_AUDIO = new Set(["aac", "ac3", "eac3", "mp3", "opus", "alac"]);

/** Whether an audio codec can be stream-copied into our fMP4 HLS segments. */
export function isRemuxCopyableAudio(codec: string | null | undefined): boolean {
  return typeof codec === "string" && FMP4_COPYABLE_AUDIO.has(codec.toLowerCase());
}

export interface RemuxArgsInput {
  absPath: string;
  videoStreamIndex: number;
  audioStreamIndex: number | null;
  audioNeedsTranscode: boolean;
  startNumber: number;
  seekTo: number | null;
  dir: string;
}

/** `-c:v copy` always — this path never touches video quality. Audio is
 *  copied too unless the client can't decode it, in which case only the
 *  audio is re-encoded (AAC 256k), which is still a "remux" as far as the
 *  video stream — the only thing that actually matters for quality — is
 *  concerned. */
export function buildRemuxArgs(input: RemuxArgsInput): string[] {
  const args: string[] = ["-nostdin", "-v", "error"];
  const seekTo = input.seekTo;
  const seeking = seekTo !== null && seekTo > 0;
  if (seekTo !== null && seeking) args.push("-ss", seekTo.toFixed(3));
  args.push("-i", input.absPath);
  args.push("-map", `0:${input.videoStreamIndex}`, "-c:v", "copy");
  if (input.audioStreamIndex !== null) {
    args.push("-map", `0:${input.audioStreamIndex}`);
    args.push(...(input.audioNeedsTranscode ? ["-c:a", "aac", "-b:a", "256k"] : ["-c:a", "copy"]));
  }
  // Re-baselines PTS to 0 for this run so the segments it writes (named from
  // -start_number onward) carry consistent timestamps despite starting mid-file.
  if (seeking) args.push("-copyts", "-start_at_zero", "-muxdelay", "0");
  args.push(...hlsOutputArgs(input.dir, input.startNumber));
  return args;
}

export interface TranscodeArgsInput {
  absPath: string;
  videoStreamIndex: number;
  audioStreamIndex: number | null;
  audioNeedsTranscode: boolean;
  targetHeight: number;
  sourceHeight: number | null;
  hdrFormat: string | null;
  zscaleAvailable: boolean;
  burnInSubtitleStreamIndex: number | null;
  startNumber: number;
  seekTo: number | null;
  dir: string;
}

/** Last-resort re-encode: high-quality libx264 (crf 18, high profile) capped
 *  at a configurable resolution. HDR sources are tonemapped to SDR here —
 *  unlike direct/remux (which preserve HDR losslessly when the client
 *  supports it), transcode exists specifically for clients that DON'T, so
 *  universal SDR output is the pragmatic choice for this fallback path. */
export function buildTranscodeArgs(input: TranscodeArgsInput): string[] {
  const args: string[] = ["-nostdin", "-v", "error"];
  const seekTo = input.seekTo;
  if (seekTo !== null && seekTo > 0) args.push("-ss", seekTo.toFixed(3));
  args.push("-i", input.absPath);

  const targetHeight = input.sourceHeight ? Math.min(input.targetHeight, input.sourceHeight) : input.targetHeight;
  const needsTonemap = !!input.hdrFormat && input.hdrFormat !== "SDR" && input.zscaleAvailable;
  const chain: string[] = [];
  if (needsTonemap) chain.push("zscale=t=linear:npl=100", "tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709");
  chain.push(`scale=-2:${targetHeight}`);

  if (input.burnInSubtitleStreamIndex !== null) {
    const filterChain = chain.join(",");
    args.push("-filter_complex", `[0:${input.videoStreamIndex}]${filterChain}[base];[base][0:${input.burnInSubtitleStreamIndex}]overlay[outv]`);
    args.push("-map", "[outv]");
  } else {
    args.push("-map", `0:${input.videoStreamIndex}`, "-vf", chain.join(","));
  }

  if (input.audioStreamIndex !== null) {
    args.push("-map", `0:${input.audioStreamIndex}`);
    args.push(...(input.audioNeedsTranscode ? ["-c:a", "aac", "-b:a", "256k"] : ["-c:a", "copy"]));
  }

  const kbps = maxrateKbpsForHeight(targetHeight);
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-maxrate",
    `${kbps}k`,
    "-bufsize",
    `${kbps * 2}k`,
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-pix_fmt",
    "yuv420p",
    "-force_key_frames",
    `expr:gte(t,n_forced*${SEG_SECONDS})`,
  );
  args.push(...hlsOutputArgs(input.dir, input.startNumber));
  return args;
}

/** Highest segment index produced CONTIGUOUSLY from `startNumber` — the scan
 *  stops at the first hole. The session directory accumulates segments across
 *  runs (seek forward, then back, then forward again reuses it), so a plain
 *  global max would count stale segments from a PREVIOUS run beyond the gap:
 *  a request landing inside that gap would look "within the horizon", never
 *  trigger a reseek, and poll out its whole 20s deadline into a 504 — the live
 *  process writes strictly sequentially from startNumber and will never fill
 *  the hole. Pure, exported for tests. */
export function contiguousMaxProducedIndex(producedIndexes: Iterable<number>, startNumber: number): number {
  const produced = new Set(producedIndexes);
  let max = startNumber - 1;
  while (produced.has(max + 1)) max += 1;
  return max;
}
