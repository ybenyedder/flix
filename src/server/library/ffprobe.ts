// ffprobe wrapper — never shells out (array-of-arguments spawn only), never
// touches the network, and always resolves (never throws / never hangs): a
// stuck or hostile file gets SIGKILLed after PROBE_TIMEOUT_MS just like the
// ffmpeg audio-decode guard in Auralis's analysis.ts.

import { spawn } from "child_process";
import { getConfig } from "../config";
import { createLogger } from "../logger";

const log = createLogger("ffprobe");

const PROBE_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024; // guards against a pathological/hostile file

const BITMAP_SUBTITLE_CODECS = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "xsub"]);
export const SUBTITLE_FORMAT_MAP: Record<string, string> = {
  subrip: "subrip",
  srt: "subrip",
  mov_text: "subrip",
  ass: "ass",
  ssa: "ass",
  webvtt: "webvtt",
  hdmv_pgs_subtitle: "pgs",
  dvd_subtitle: "vobsub",
};

export function subtitleFormatFor(codec: string | null): string | null {
  return codec ? SUBTITLE_FORMAT_MAP[codec] ?? null : null;
}
export function isBitmapSubtitleCodec(codec: string | null): boolean {
  return codec !== null && BITMAP_SUBTITLE_CODECS.has(codec);
}

interface FfprobeDisposition {
  default?: number;
  forced?: number;
  attached_pic?: number;
}
interface FfprobeSideData {
  side_data_type?: string;
}
interface FfprobeStreamRaw {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  bits_per_raw_sample?: string;
  pix_fmt?: string;
  color_transfer?: string;
  color_primaries?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
  disposition?: FfprobeDisposition;
  side_data_list?: FfprobeSideData[];
}
interface FfprobeFormatRaw {
  format_name?: string;
  duration?: string;
  bit_rate?: string;
}
interface FfprobeChapterRaw {
  start_time?: string;
  tags?: Record<string, string>;
}
interface FfprobeJson {
  format?: FfprobeFormatRaw;
  streams?: FfprobeStreamRaw[];
  chapters?: FfprobeChapterRaw[];
}

export type HdrFormat = "SDR" | "HDR10" | "HLG" | "DV";
export type StreamType = "video" | "audio" | "subtitle" | "other";

export interface ProbedStream {
  index: number;
  type: StreamType;
  codec: string | null;
  profile: string | null;
  level: number | null;
  width: number | null;
  height: number | null;
  bitDepth: number | null;
  frameRate: number | null;
  pixelFormat: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  hdrFormat: HdrFormat | null;
  channels: number | null;
  channelLayout: string | null;
  sampleRate: number | null;
  language: string | null;
  title: string | null;
  bitrate: number | null;
  isDefault: boolean;
  isForced: boolean;
  attachedPic: boolean;
}

export interface ProbedChapter {
  start: number;
  title: string | null;
}

export interface ProbeResult {
  container: string | null;
  duration: number;
  bitrate: number | null;
  streams: ProbedStream[];
  chapters: ProbedChapter[];
}

function parseFrameRate(raw: string | undefined): number | null {
  if (!raw) return null;
  const [num, den] = raw.split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

/** HDR10 (SMPTE 2084 PQ), HLG (ARIB STD-B67) come straight from the transfer
 *  characteristic; Dolby Vision only shows up as a side-data block. */
function detectHdr(s: FfprobeStreamRaw): HdrFormat {
  const isDolbyVision = (s.side_data_list ?? []).some((sd) => sd.side_data_type?.toLowerCase().includes("dolby vision"));
  if (isDolbyVision) return "DV";
  if (s.color_transfer === "smpte2084") return "HDR10";
  if (s.color_transfer === "arib-std-b67") return "HLG";
  return "SDR";
}

function mapStream(s: FfprobeStreamRaw): ProbedStream {
  const type: StreamType = s.codec_type === "video" || s.codec_type === "audio" || s.codec_type === "subtitle" ? s.codec_type : "other";
  const disposition = s.disposition ?? {};
  // pix_fmt encodes bit depth in its suffix (yuv420p10le → 10) when the more
  // reliable bits_per_raw_sample tag is absent.
  const pixFmtBits = s.pix_fmt?.match(/(\d+)(?:le|be)?$/);
  return {
    index: s.index,
    type,
    codec: s.codec_name ?? null,
    profile: s.profile ?? null,
    level: typeof s.level === "number" ? s.level : null,
    width: s.width ?? null,
    height: s.height ?? null,
    bitDepth: s.bits_per_raw_sample ? Number(s.bits_per_raw_sample) : pixFmtBits ? Number(pixFmtBits[1]) : null,
    frameRate: type === "video" ? parseFrameRate(s.avg_frame_rate) ?? parseFrameRate(s.r_frame_rate) : null,
    pixelFormat: s.pix_fmt ?? null,
    colorTransfer: s.color_transfer ?? null,
    colorPrimaries: s.color_primaries ?? null,
    hdrFormat: type === "video" ? detectHdr(s) : null,
    channels: s.channels ?? null,
    channelLayout: s.channel_layout ?? null,
    sampleRate: s.sample_rate ? Number(s.sample_rate) : null,
    language: s.tags?.language ?? null,
    title: s.tags?.title ?? null,
    bitrate: s.bit_rate ? Number(s.bit_rate) : null,
    isDefault: disposition.default === 1,
    isForced: disposition.forced === 1,
    attachedPic: disposition.attached_pic === 1,
  };
}

function buildResult(parsed: FfprobeJson): ProbeResult {
  const streams = (parsed.streams ?? []).map(mapStream);
  const chapters = (parsed.chapters ?? []).map((c) => ({
    start: c.start_time ? Number(c.start_time) : 0,
    title: c.tags?.title ?? null,
  }));
  const duration = parsed.format?.duration ? Number(parsed.format.duration) : 0;
  return {
    container: parsed.format?.format_name ?? null,
    duration: Number.isFinite(duration) ? duration : 0,
    bitrate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
    streams,
    chapters,
  };
}

// "Binary not found" latch (spawn ENOENT): a missing/mistyped FFPROBE_PATH is
// a deployment problem, not a bad file — the scanner checks this after a null
// probe so it can leave probed_at = 0 (retry next scan) instead of stamping
// the file broken forever. Reset at the start of each probe pass.
let spawnEnoent = false;
export function ffprobeWasMissing(): boolean {
  return spawnEnoent;
}
export function resetFfprobeMissing(): void {
  spawnEnoent = false;
}
function noteSpawnError(error: unknown): void {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") spawnEnoent = true;
}

/** Probe one media file. Resolves to null (never rejects) on any failure —
 *  missing binary, malformed input, timeout — so a single bad file can never
 *  abort the scan's probe pass. */
export function probeFile(absPath: string): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    const { ffprobePath } = getConfig();
    const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", absPath];

    let proc;
    try {
      // stderr is "ignore", not "pipe": it is never read here, and an unread
      // pipe blocks the child once its 64 KiB buffer fills (chatty error spew
      // would then hang the probe until the SIGKILL timeout).
      proc = spawn(/*turbopackIgnore: true*/ ffprobePath, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      noteSpawnError(error);
      log.warn("failed to spawn ffprobe", { message: error instanceof Error ? error.message : String(error) });
      resolve(null);
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: ProbeResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    const killTimer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(null);
    }, PROBE_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_STDOUT_BYTES) chunks.push(chunk);
    });
    proc.on("error", (error) => {
      noteSpawnError(error);
      finish(null);
    });
    proc.on("close", (code) => {
      if (code !== 0 || !chunks.length) {
        finish(null);
        return;
      }
      try {
        finish(buildResult(JSON.parse(Buffer.concat(chunks).toString("utf8")) as FfprobeJson));
      } catch {
        finish(null);
      }
    });
  });
}
