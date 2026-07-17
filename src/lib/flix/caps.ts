// Playback capability model — describes what a given client (a browser tab, the
// Electron shell, a native Android/Android TV app) can decode NATIVELY, i.e.
// without any help from the server. `decide()` (src/server/playback/decision.ts)
// matches a file's probed streams against this to pick direct play > remux >
// transcode, in that strict priority order.
//
// Shared between client and server code, so this file must stay free of any
// Node-only API (fs, path, child_process, …) — it is imported both from a
// "use client" component (buildBrowserCaps, calling MediaSource/document) and
// from server route handlers (just the types, for validating a posted caps
// object before handing it to decide()).

export interface VideoCap {
  codec: string; // ffprobe codec_name id: "h264", "hevc", "av1", "vp9", "vp8", …
  profiles?: string[]; // allowed profiles (case-insensitive); omitted = any
  maxLevel?: number; // ffprobe `level` ceiling (e.g. H.264 level 51 = 5.1)
  bitDepth?: number; // max decodable bit depth (8/10/12); omitted = any
}

export interface ClientCaps {
  containers: string[]; // container ids (see videoContainerId) playable via a plain <video src>/native player
  video: VideoCap[];
  audio: string[]; // decodable audio codec ids: "aac", "ac3", "eac3", "opus", "flac", "mp3", "dts", "truehd", …
  maxWidth: number;
  maxHeight: number;
  hdr: boolean; // display + decoder can present HDR10/HLG/DV without a tonemap
}

/** A maximally conservative fallback — used whenever a posted caps object is
 *  missing/malformed, so a bad client payload degrades to "transcode for
 *  everything" (safe, if wasteful) rather than crashing or, worse, being
 *  treated as "supports everything" (which would serve possibly-undecodable
 *  direct URLs). */
export const MINIMAL_CAPS: ClientCaps = {
  containers: [],
  video: [],
  audio: [],
  maxWidth: 1280,
  maxHeight: 720,
  hdr: false,
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validate/narrow an untrusted JSON payload (a POST body) into a ClientCaps,
 *  or null if the shape is unusable. Never throws. */
export function parseClientCaps(input: unknown): ClientCaps | null {
  if (!input || typeof input !== "object") return null;
  const c = input as Record<string, unknown>;
  if (!isStringArray(c.containers) || !isStringArray(c.audio)) return null;
  if (!Array.isArray(c.video)) return null;
  const video: VideoCap[] = [];
  for (const entry of c.video) {
    if (!entry || typeof entry !== "object") return null;
    const v = entry as Record<string, unknown>;
    if (typeof v.codec !== "string") return null;
    const cap: VideoCap = { codec: v.codec };
    if (v.profiles !== undefined) {
      if (!isStringArray(v.profiles)) return null;
      cap.profiles = v.profiles;
    }
    if (v.maxLevel !== undefined) {
      if (typeof v.maxLevel !== "number") return null;
      cap.maxLevel = v.maxLevel;
    }
    if (v.bitDepth !== undefined) {
      if (typeof v.bitDepth !== "number") return null;
      cap.bitDepth = v.bitDepth;
    }
    video.push(cap);
  }
  const maxWidth = typeof c.maxWidth === "number" && c.maxWidth > 0 ? c.maxWidth : MINIMAL_CAPS.maxWidth;
  const maxHeight = typeof c.maxHeight === "number" && c.maxHeight > 0 ? c.maxHeight : MINIMAL_CAPS.maxHeight;
  const hdr = c.hdr === true;
  return { containers: c.containers, video, audio: c.audio, maxWidth, maxHeight, hdr };
}

// --- browser capability probe (client-only; guarded so importing this module
// server-side or under SSR never throws) ------------------------------------

interface MediaSourceLike {
  isTypeSupported(mime: string): boolean;
}

function mse(): MediaSourceLike | null {
  const ms = (globalThis as { MediaSource?: MediaSourceLike }).MediaSource;
  return ms && typeof ms.isTypeSupported === "function" ? ms : null;
}

// Fixed probe list: every container/codec combination we would ever consider
// producing (direct, remux target, or transcode target), so a single pass over
// MediaSource.isTypeSupported (the API that actually governs what hls.js can
// append into a SourceBuffer — the thing every one of our non-direct paths
// depends on) tells us everything decide() needs about this browser.
const VIDEO_PROBES: { codec: string; mime: string; profiles?: string[]; bitDepth?: number }[] = [
  { codec: "h264", mime: 'video/mp4; codecs="avc1.640028"', profiles: ["high", "main", "baseline", "constrained baseline"] },
  { codec: "hevc", mime: 'video/mp4; codecs="hvc1.1.6.L153.B0"', profiles: ["main", "main 10"], bitDepth: 10 },
  { codec: "av1", mime: 'video/mp4; codecs="av01.0.08M.08"' },
  { codec: "vp9", mime: 'video/webm; codecs="vp09.00.10.08"' },
  { codec: "vp8", mime: 'video/webm; codecs="vp8"' },
];

const AUDIO_PROBES: { codec: string; mime: string }[] = [
  { codec: "aac", mime: 'audio/mp4; codecs="mp4a.40.2"' },
  { codec: "ac3", mime: 'audio/mp4; codecs="ac-3"' },
  { codec: "eac3", mime: 'audio/mp4; codecs="ec-3"' },
  { codec: "opus", mime: 'audio/mp4; codecs="opus"' },
  { codec: "flac", mime: 'audio/mp4; codecs="fLaC"' },
  { codec: "mp3", mime: "audio/mpeg" },
];

/** Build this browser's real playback capabilities. Every check degrades to
 *  "unsupported" rather than throwing when an API is missing (older browser,
 *  non-browser test runner, SSR). */
export function buildBrowserCaps(): ClientCaps {
  const source = mse();
  const supports = (mime: string): boolean => {
    if (!source) return false;
    try {
      return source.isTypeSupported(mime);
    } catch {
      return false;
    }
  };

  const video: VideoCap[] = [];
  for (const probe of VIDEO_PROBES) {
    if (!supports(probe.mime)) continue;
    video.push({ codec: probe.codec, profiles: probe.profiles, bitDepth: probe.bitDepth });
  }

  const audio: string[] = [];
  for (const probe of AUDIO_PROBES) {
    if (supports(probe.mime)) audio.push(probe.codec);
  }

  // A plain <video src> (direct play) is far more permissive per-container than
  // MSE — canPlayType is the right API for it, MediaSource.isTypeSupported only
  // governs what hls.js/MSE can append. mp4 is near-universal; webm only when
  // the browser can actually decode a vp8/vp9 payload out of it.
  const containers = ["mp4"];
  const videoEl = typeof document !== "undefined" ? document.createElement("video") : null;
  const canPlay = (mime: string): boolean => !!videoEl && videoEl.canPlayType(mime) !== "";
  if (canPlay('video/webm; codecs="vp9"') || canPlay('video/webm; codecs="vp8, vorbis"')) containers.push("webm");

  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  const screenW = typeof screen !== "undefined" ? screen.width * dpr : 1920;
  const screenH = typeof screen !== "undefined" ? screen.height * dpr : 1080;
  // Decoders regularly handle more than the display panel's native resolution
  // (downscaled 4K playback on a 1080p screen is normal), so this is a floor,
  // not a tight fit — clamp to a sane 4K ceiling for the software-transcode cap.
  const maxWidth = Math.max(1920, Math.min(3840, Math.round(screenW)));
  const maxHeight = Math.max(1080, Math.min(2160, Math.round(screenH)));

  const hdr =
    typeof matchMedia !== "undefined" &&
    (matchMedia("(dynamic-range: high)").matches || matchMedia("(video-dynamic-range: high)").matches);

  return { containers, video, audio, maxWidth, maxHeight, hdr };
}
