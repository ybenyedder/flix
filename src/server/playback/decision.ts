// Playback decision engine: for a given media file and a client's declared
// capabilities, picks the ZERO-QUALITY-LOSS path first, and only degrades when
// that's genuinely impossible. Priority is strict and never reordered:
//
//   1. direct  — the file is served byte-for-byte (/api/stream/<id>). No loss,
//                no server CPU. Chosen whenever container + video codec + the
//                selected audio track are all natively playable AND no bitmap
//                subtitle burn-in was requested.
//   2. remux   — ffmpeg repackages into HLS fMP4 with `-c:v copy` (still zero
//                video quality loss — only the container changes, or a
//                non-default audio track is selected via `-map`). The audio
//                track itself may be re-encoded (AAC) if ITS codec alone isn't
//                supported, but the video stream is never touched.
//   3. transcode — genuinely last resort: only when the video codec/profile/
//                level/resolution/HDR isn't decodable at all by the client, or
//                a bitmap subtitle must be burned into the picture (which
//                requires re-encoding no matter what).
//
// `decide()` never picks transcode when remux or direct would do — every
// branch below checks "is video re-encode avoidable" before falling through.
// Per-profile language preferences (PlaybackLangPrefs) obey the same law:
// they only preselect a track when no explicit one was requested, and are
// never allowed to buy a burn-in/transcode the user didn't explicitly ask for.

import { getDb } from "../db";
import { videoContainerId } from "../paths";
import type { ClientCaps, VideoCap } from "@/lib/flix/caps";

export type PlaybackMode = "direct" | "remux" | "transcode";

interface StreamRow {
  id: number;
  stream_index: number;
  type: string;
  codec: string | null;
  profile: string | null;
  level: number | null;
  width: number | null;
  height: number | null;
  bit_depth: number | null;
  hdr_format: string | null;
  channels: number | null;
  channel_layout: string | null;
  language: string | null;
  title: string | null;
  is_default: number;
  is_forced: number;
  attached_pic: number;
}

interface SubtitleRow {
  id: number;
  stream_index: number | null;
  source: string;
  language: string | null;
  title: string | null;
  is_forced: number;
  is_sdh: number;
  format: string | null;
  is_text: number;
}

interface MediaFileRow {
  id: number;
  filepath: string;
  duration: number;
  chapters: string | null;
}

export interface DecisionAudioTrack {
  id: number;
  streamIndex: number;
  language: string | null;
  title: string | null;
  codec: string | null;
  channels: number | null;
  channelLayout: string | null;
  isDefault: boolean;
  supported: boolean;
}

export interface DecisionSubtitle {
  id: number;
  streamIndex: number | null;
  source: "embedded" | "external";
  language: string | null;
  title: string | null;
  isForced: boolean;
  isSdh: boolean;
  format: string | null;
  requiresBurnIn: boolean;
}

/** Chapter exposed to the player. `media_files.chapters` stores the raw
 *  ffprobe rows ({start, title} only — see scanner.ts's applyProbeResult and
 *  ffprobe.ts's ProbedChapter), so `end` is derived here: the next chapter's
 *  start, or the file duration for the last one. */
export interface DecisionChapter {
  start: number;
  end: number;
  title: string | null;
}

export interface Decision {
  mode: PlaybackMode;
  fileId: number;
  reason: string;
  url?: string;
  duration: number;
  container: string;
  videoCodec: string | null;
  videoStreamIndex: number | null;
  audioStreamIndex: number | null;
  subtitleId: number | null;
  requiresBurnIn: boolean;
  audioTracks: DecisionAudioTrack[];
  subtitles: DecisionSubtitle[];
  chapters: DecisionChapter[];
}

/** Per-profile language preferences (see src/server/state/settings.ts),
 *  passed in by the route that has the user — decide() itself never reads
 *  them from the DB, so it stays pure/testable. Only consulted when the
 *  corresponding EXPLICIT selection is absent, and only ever to pick a track
 *  the user could have picked by hand — never to change what that pick costs.
 *  In particular a preference alone must never buy a transcode: bitmap
 *  subtitles (burn-in ⇒ full video re-encode) are skipped outright, and an
 *  audio pick can at worst cost the same remux an explicit TrackMenu
 *  selection of that track would. */
export interface PlaybackLangPrefs {
  /** Preferred audio language code ("fra", "fre", "fr", "eng"…). */
  audioLang?: string | null;
  /** Preferred subtitle language code, or "off" (explicitly none). */
  subtitleLang?: string | null;
}

export interface DecisionOptions {
  /** ffprobe stream_index of the desired audio track; omitted = default/first. */
  audioIdx?: number;
  /** subtitles.id of the desired subtitle track; omitted = none selected. */
  subtitleId?: number;
  /** Profile preferences applied to whichever selection above is omitted. */
  prefs?: PlaybackLangPrefs;
}

// ISO 639 tags aren't stored uniformly across a real library: embedded
// streams carry ffprobe's 3-letter codes — bibliographic OR terminological
// ("fre" vs "fra") — while external subtitle sidecars are tagged from their
// filename, often with a 2-letter code ("fr"). A preference must match all
// three spellings, so both sides are folded onto one canonical form before
// comparing. The table covers the ISO 639-2 B/T pairs plus the 2-letter codes
// of common languages; anything unknown compares verbatim (lowercased).
const LANG_ALIASES: Record<string, string> = {
  fr: "fra", fre: "fra",
  en: "eng",
  de: "deu", ger: "deu",
  es: "spa",
  it: "ita",
  pt: "por",
  nl: "nld", dut: "nld",
  ja: "jpn",
  zh: "zho", chi: "zho",
  ko: "kor",
  ru: "rus",
  ar: "ara",
  pl: "pol",
  sv: "swe",
  da: "dan",
  no: "nor",
  fi: "fin",
  cs: "ces", cze: "ces",
  el: "ell", gre: "ell",
  tr: "tur",
  he: "heb",
  hi: "hin",
  hu: "hun",
  ro: "ron", rum: "ron",
  sk: "slk", slo: "slk",
  uk: "ukr",
  vi: "vie",
  th: "tha",
};

export function normalizeLangCode(code: string): string {
  const lower = code.trim().toLowerCase();
  return LANG_ALIASES[lower] ?? lower;
}

function langMatches(trackLang: string | null, wanted: string): boolean {
  return trackLang !== null && normalizeLangCode(trackLang) === normalizeLangCode(wanted);
}

function findVideoCap(caps: ClientCaps, codec: string | null): VideoCap | undefined {
  if (!codec) return undefined;
  return caps.video.find((v) => v.codec.toLowerCase() === codec.toLowerCase());
}

/** Whether the client can decode this video stream natively — codec, profile,
 *  level, bit depth, resolution and HDR all have to clear the client's
 *  declared ceiling. Any single mismatch rules out BOTH direct and remux (a
 *  `-c copy` remux carries the same video bitstream, so it inherits the exact
 *  same decodability constraints as direct play). */
function isVideoSupported(caps: ClientCaps, stream: StreamRow): boolean {
  const cap = findVideoCap(caps, stream.codec);
  if (!cap) return false;
  const profile = stream.profile;
  if (cap.profiles && profile && !cap.profiles.some((p) => p.toLowerCase() === profile.toLowerCase())) return false;
  if (cap.maxLevel !== undefined && stream.level !== null && stream.level > cap.maxLevel) return false;
  if (cap.bitDepth !== undefined && stream.bit_depth !== null && stream.bit_depth > cap.bitDepth) return false;
  if (stream.width !== null && stream.width > caps.maxWidth) return false;
  if (stream.height !== null && stream.height > caps.maxHeight) return false;
  if (stream.hdr_format && stream.hdr_format !== "SDR" && !caps.hdr) return false;
  return true;
}

function isAudioSupported(caps: ClientCaps, stream: StreamRow): boolean {
  if (!stream.codec) return false;
  return caps.audio.includes(stream.codec.toLowerCase());
}

/** Parse the raw chapters JSON stored by the scanner into client-facing
 *  {start, end, title} triples. Defensive against a malformed/tampered column:
 *  anything that isn't an array of {start: finite number} rows is dropped, the
 *  list is re-sorted by start, and each `end` is the following chapter's start
 *  (file duration for the last — falling back to its own start when the
 *  duration itself is unknown, a zero-length tail rather than a lie). */
export function parseChapters(raw: string | null, duration: number): DecisionChapter[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const starts = parsed
    .flatMap((c) => {
      if (typeof c !== "object" || c === null) return [];
      const { start, title } = c as { start?: unknown; title?: unknown };
      if (typeof start !== "number" || !Number.isFinite(start) || start < 0) return [];
      return [{ start, title: typeof title === "string" ? title : null }];
    })
    .sort((a, b) => a.start - b.start);
  return starts.map((c, i) => {
    const next = starts[i + 1]?.start;
    const end = next !== undefined ? next : duration > c.start ? duration : c.start;
    return { start: c.start, end, title: c.title };
  });
}

export function decide(fileId: number, caps: ClientCaps, opts: DecisionOptions = {}): Decision | null {
  const db = getDb();
  const file = db.prepare("SELECT id, filepath, duration, chapters FROM media_files WHERE id = ?").get(fileId) as MediaFileRow | undefined;
  if (!file) return null;

  const streams = db.prepare("SELECT * FROM streams WHERE media_file_id = ? ORDER BY stream_index").all(fileId) as StreamRow[];
  const videoStream = streams.find((s) => s.type === "video" && !s.attached_pic) ?? null;
  const audioStreams = streams.filter((s) => s.type === "audio");
  const subtitleRows = db.prepare("SELECT * FROM subtitles WHERE media_file_id = ? ORDER BY id").all(fileId) as SubtitleRow[];

  const defaultAudio = audioStreams.find((s) => s.is_default) ?? audioStreams[0] ?? null;
  let targetAudio = opts.audioIdx !== undefined ? audioStreams.find((s) => s.stream_index === opts.audioIdx) ?? defaultAudio : defaultAudio;
  // Audio language preference: only when NO explicit track was requested, and
  // only when the default doesn't already speak the preferred language —
  // keeping the default preserves direct play, a free win. Picking a
  // non-default track costs exactly what the same pick from the TrackMenu
  // costs (a remux at worst — audio choice alone can never force a transcode
  // in the matrix below), never more.
  const prefAudioLang = opts.prefs?.audioLang;
  if (opts.audioIdx === undefined && prefAudioLang && !langMatches(targetAudio?.language ?? null, prefAudioLang)) {
    const preferred = audioStreams.find((s) => langMatches(s.language, prefAudioLang));
    if (preferred) targetAudio = preferred;
  }
  const nonDefaultAudioRequested = targetAudio !== null && defaultAudio !== null && targetAudio.id !== defaultAudio.id;

  let targetSubtitle = opts.subtitleId !== undefined ? subtitleRows.find((s) => s.id === opts.subtitleId) ?? null : null;
  // Subtitle language preference: TEXT tracks only — a bitmap track would
  // require burn-in, i.e. a full video transcode, which a mere preference
  // must never trigger (only an explicit user pick may). "off" (or no pref)
  // preselects nothing. Non-forced tracks win over forced ones (forced subs
  // only carry the foreign-language snippets, not the dialogue).
  const prefSubtitleLang = opts.prefs?.subtitleLang;
  if (opts.subtitleId === undefined && prefSubtitleLang && prefSubtitleLang !== "off") {
    const candidates = subtitleRows.filter((s) => s.is_text === 1 && langMatches(s.language, prefSubtitleLang));
    targetSubtitle = candidates.find((s) => !s.is_forced) ?? candidates[0] ?? null;
  }
  // Burn-in can only ever apply to an EMBEDDED bitmap track — ffmpeg overlays
  // it by stream index from the same input file. An external bitmap sidecar
  // (VobSub .sub) has no such index, so it must NOT force a full video
  // re-encode that couldn't include the subtitle anyway: selecting one falls
  // back to the normal direct/remux path with the subtitle simply not shown.
  const requiresBurnIn = targetSubtitle ? targetSubtitle.is_text === 0 && targetSubtitle.source === "embedded" : false;

  const containerId = videoContainerId(file.filepath);
  const containerOk = caps.containers.includes(containerId);
  const videoOk = !videoStream || isVideoSupported(caps, videoStream);
  const audioOk = !targetAudio || isAudioSupported(caps, targetAudio);

  let mode: PlaybackMode;
  let reason: string;
  if (requiresBurnIn) {
    mode = "transcode";
    reason = "subtitle-burn-in-required";
  } else if (containerOk && videoOk && audioOk && !nonDefaultAudioRequested) {
    mode = "direct";
    reason = "container-and-codecs-supported";
  } else if (videoOk) {
    mode = "remux";
    reason = !containerOk ? "container-unsupported-video-codec-ok" : !audioOk ? "audio-codec-unsupported-video-codec-ok" : "non-default-audio-track-requested";
  } else {
    mode = "transcode";
    reason = "video-codec-unsupported";
  }

  return {
    mode,
    fileId,
    reason,
    url: mode === "direct" ? `/api/stream/${fileId}` : undefined,
    duration: file.duration,
    container: containerId,
    videoCodec: videoStream?.codec ?? null,
    videoStreamIndex: videoStream?.stream_index ?? null,
    audioStreamIndex: targetAudio?.stream_index ?? null,
    subtitleId: targetSubtitle?.id ?? null,
    requiresBurnIn,
    audioTracks: audioStreams.map((s) => ({
      id: s.id,
      streamIndex: s.stream_index,
      language: s.language,
      title: s.title,
      codec: s.codec,
      channels: s.channels,
      channelLayout: s.channel_layout,
      isDefault: s.id === defaultAudio?.id,
      supported: isAudioSupported(caps, s),
    })),
    subtitles: subtitleRows.map((s) => ({
      id: s.id,
      streamIndex: s.stream_index,
      source: s.source === "external" ? "external" : "embedded",
      language: s.language,
      title: s.title,
      isForced: !!s.is_forced,
      isSdh: !!s.is_sdh,
      format: s.format,
      requiresBurnIn: s.is_text === 0 && s.source === "embedded",
    })),
    chapters: parseChapters(file.chapters, file.duration),
  };
}

/** Video stream metadata `sessions.ts` needs to build ffmpeg args — kept out of
 *  `Decision` (the client-facing shape) to avoid leaking raw ffprobe fields. */
export interface FileStreamsForPlayback {
  duration: number;
  filepath: string;
  keyframes: number[] | null;
  video: { streamIndex: number; codec: string | null; hdrFormat: string | null; width: number | null; height: number | null } | null;
}

export function getFileStreamsForPlayback(fileId: number): FileStreamsForPlayback | null {
  const db = getDb();
  const file = db.prepare("SELECT id, filepath, duration, keyframes FROM media_files WHERE id = ?").get(fileId) as
    | (MediaFileRow & { keyframes: string | null })
    | undefined;
  if (!file) return null;
  const videoStream = db
    .prepare("SELECT stream_index, codec, hdr_format, width, height FROM streams WHERE media_file_id = ? AND type = 'video' AND attached_pic = 0 ORDER BY stream_index LIMIT 1")
    .get(fileId) as { stream_index: number; codec: string | null; hdr_format: string | null; width: number | null; height: number | null } | undefined;
  let keyframes: number[] | null = null;
  if (file.keyframes) {
    try {
      const parsed = JSON.parse(file.keyframes) as unknown;
      if (Array.isArray(parsed)) keyframes = parsed.filter((n): n is number => typeof n === "number");
    } catch {
      keyframes = null;
    }
  }
  return {
    duration: file.duration,
    filepath: file.filepath,
    keyframes,
    video: videoStream ? { streamIndex: videoStream.stream_index, codec: videoStream.codec, hdrFormat: videoStream.hdr_format, width: videoStream.width, height: videoStream.height } : null,
  };
}
