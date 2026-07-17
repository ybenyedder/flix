// Pure playback logic: resume-offset math, watch/abandon classification, time
// formatting, season/episode order-walking for auto-advance, volume
// clamping/persistence parsing, hls.js fatal-error recovery decisions,
// chapter classification (skip intro / next-up triggering) and trickplay
// time→sprite-tile mapping. Kept free of the DOM/fetch/zustand so
// PlayerView's core decisions are unit-testable without a browser or a
// running server.

import type { SeasonDetail, EpisodeDetail, ProgressSummary, PlaybackChapter, TrickplayMeta } from "./types";

export const WATCHED_RATIO = 0.92;
export const ABANDON_RATIO = 0.15;
export const ABANDON_MIN_SECONDS = 120;
export const RESUME_MIN_POSITION = 30;
export const RESUME_BACK_SECONDS = 5;
export const NEXT_UP_LEAD_SECONDS = 30;

/** Where to actually resume playback from: a few seconds of context before
 *  the stored position — but only when there IS a meaningful stored position
 *  and the item isn't already effectively finished. Under 30s in, or already
 *  past the watched threshold, starts from zero (a fresh play, not a resume). */
export function computeResumeStart(position: number, duration: number): number {
  if (!(position > RESUME_MIN_POSITION)) return 0;
  const ratio = duration > 0 ? position / duration : 0;
  if (ratio >= WATCHED_RATIO) return 0;
  return Math.max(0, position - RESUME_BACK_SECONDS);
}

export type WatchEventKind = "complete" | "abandon";

/** Classify the final position of a viewing session: finished (>=92%) is a
 *  "complete" signal; giving up early (<15% in, after watching at least two
 *  minutes) is an "abandon" signal. Everything else — a mid-way stop, a plain
 *  pause, or a duration we don't actually know yet — isn't a signal worth
 *  persisting (kind: null). An unknown/zero duration deliberately never
 *  classifies as anything: a ratio of 0 would otherwise look identical to a
 *  genuine early-abandon of a known-length video. */
export function classifyWatchEvent(position: number, duration: number): { kind: WatchEventKind | null; ratio: number } {
  if (!(duration > 0)) return { kind: null, ratio: 0 };
  const ratio = position / duration;
  if (ratio >= WATCHED_RATIO) return { kind: "complete", ratio };
  if (ratio < ABANDON_RATIO && position >= ABANDON_MIN_SECONDS) return { kind: "abandon", ratio };
  return { kind: null, ratio };
}

/** "1:23:45" (hours segment only when non-zero) / "12:34" — never negative,
 *  never NaN. */
export function formatTime(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** The next episode after `currentEpisodeId` in show order: next in the same
 *  season, else episode 1 of the next non-empty season. Null at the series
 *  finale, or if the current episode can't be located at all. */
export function findNextEpisode(seasons: SeasonDetail[], currentEpisodeId: number): EpisodeDetail | null {
  for (let si = 0; si < seasons.length; si++) {
    const idx = seasons[si].episodes.findIndex((e) => e.id === currentEpisodeId);
    if (idx === -1) continue;
    if (idx + 1 < seasons[si].episodes.length) return seasons[si].episodes[idx + 1];
    for (let sj = si + 1; sj < seasons.length; sj++) {
      if (seasons[sj].episodes.length > 0) return seasons[sj].episodes[0];
    }
    return null;
  }
  return null;
}

/** "Play" pressed on a show itself (no specific episode chosen yet): resume
 *  whichever episode is genuinely in progress, else the first never-finished
 *  episode in broadcast order, else start the whole series over from episode
 *  1 (everything already watched). */
export function pickNextUpEpisode(seasons: SeasonDetail[], progressForShow: ProgressSummary[]): EpisodeDetail | null {
  const flat = seasons.flatMap((s) => s.episodes);
  if (!flat.length) return null;
  const byEpisode = new Map(progressForShow.filter((p) => p.itemType === "episode").map((p) => [p.itemId, p]));
  const inProgress = flat.find((e) => {
    const p = byEpisode.get(e.id);
    return !!p && p.duration > 0 && p.position > 5 && p.position / p.duration < WATCHED_RATIO;
  });
  if (inProgress) return inProgress;
  const firstUnwatched = flat.find((e) => !byEpisode.get(e.id)?.watched);
  return firstUnwatched ?? flat[0];
}

// ============================================================================
// Chapters — skip intro/recap + next-up triggering
// ============================================================================

/** How long the « Passer l'intro » button stays up after entering a skippable
 *  chapter before it fades (it re-surfaces with the controls overlay). */
export const SKIP_BUTTON_SECONDS = 8;

export type ChapterKind = "intro" | "credits" | "recap";

/** Strip accents + lowercase so « Générique », « Récap »… match without their
 *  diacritics (chapter titles in the wild are wildly inconsistent). */
function foldChapterTitle(title: string): string {
  return title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Best-effort classification of a chapter title. Case- and accent-insensitive.
 * Ordering matters: recap first (never ambiguous), then explicitly-qualified
 * END credits (« générique de fin », "end credits" — must win over the intro
 * patterns since they contain « générique »/"credits" too), then intro/opening
 * (a bare « générique » is the OPENING titles, as in Netflix's own French
 * « Passer le générique » — and "opening credits" lands here, not in credits),
 * then everything else credits-like. Unrecognised titles → null.
 */
export function classifyChapter(title: string | null | undefined): ChapterKind | null {
  if (!title) return null;
  const t = foldChapterTitle(title);
  if (/\brecaps?\b|recapitulatif|previously|precedemment/.test(t)) return "recap";
  if (/(generique|credits?)[^]*\b(fin|end|ending|closing)\b|\b(end|ending|closing|final)\b[^]*(credits?|generique)/.test(t)) return "credits";
  if (/\bintro(duction)?\b|\bopening\b|\bgenerique\b|title sequence|\bmain titles?\b/.test(t)) return "intro";
  if (/\bcredits?\b|\boutro\b|\bending\b/.test(t)) return "credits";
  return null;
}

/** The chapter containing `time` ([start, end) — a boundary instant belongs to
 *  the chapter it opens), or null when between/outside chapters. */
export function chapterAt<T extends PlaybackChapter>(chapters: readonly T[], time: number): T | null {
  return chapters.find((c) => time >= c.start && time < c.end) ?? null;
}

/** Where « Passer l'intro » should jump: the END of the intro/recap chapter
 *  `time` currently sits in. Null when not inside a skippable chapter, or when
 *  under a second of it remains (nothing worth skipping — and it avoids a
 *  seek-to-now flicker right at the boundary). */
export function skipTargetFor(chapters: readonly PlaybackChapter[], time: number): number | null {
  const chapter = chapterAt(chapters, time);
  if (!chapter) return null;
  const kind = classifyChapter(chapter.title);
  if (kind !== "intro" && kind !== "recap") return null;
  if (chapter.end - time < 1) return null;
  return chapter.end;
}

/**
 * When the NextEpisodeCard should appear: at the start of the end-credits
 * chapter when the file has one (Netflix behaviour), else the historical
 * duration-30s fallback. Only a credits chapter in the SECOND half counts — a
 * misclassified "opening credits" at the top of the file must never pop the
 * card at minute one. Unknown duration → Infinity (never triggers).
 */
export function nextUpTriggerTime(chapters: readonly PlaybackChapter[], duration: number): number {
  if (!(duration > 0)) return Infinity;
  const credits = chapters.find((c) => c.start >= duration / 2 && c.start < duration && classifyChapter(c.title) === "credits");
  if (credits) return credits.start;
  return Math.max(0, duration - NEXT_UP_LEAD_SECONDS);
}

// ============================================================================
// Trickplay — time → sprite tile mapping
// ============================================================================

export interface TrickplayTile {
  /** Tile index within the sprite (row-major). */
  index: number;
  col: number;
  row: number;
  /** CSS background-position offsets (non-positive pixel values). */
  offsetX: number;
  offsetY: number;
}

/** Map a playback time to its sprite tile. Clamps into [0, count-1] so a
 *  hover past the end (or a stale duration) always lands on a real tile;
 *  defensive against degenerate metadata (interval/cols <= 0). */
export function trickplayTileFor(meta: Pick<TrickplayMeta, "interval" | "tileWidth" | "tileHeight" | "cols" | "count">, time: number): TrickplayTile {
  const interval = meta.interval > 0 ? meta.interval : 10;
  const count = Math.max(1, Math.floor(meta.count));
  const cols = Math.max(1, Math.floor(meta.cols));
  const index = Math.min(count - 1, Math.max(0, Math.floor((Number.isFinite(time) ? Math.max(0, time) : 0) / interval)));
  const col = index % cols;
  const row = Math.floor(index / cols);
  return { index, col, row, offsetX: -col * meta.tileWidth, offsetY: -row * meta.tileHeight };
}

// ============================================================================
// Volume
// ============================================================================

/** localStorage key for the persisted volume/mute pair — local-only, so it
 *  stays compatible with the zero-outbound-network rule. */
export const VOLUME_STORAGE_KEY = "flix.volume";

/** Clamp a volume into the valid [0, 1] range. Non-finite input (NaN, ±∞)
 *  falls back to full volume rather than silently muting the player. */
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export interface StoredVolume {
  volume: number;
  muted: boolean;
}

/** Parse the persisted volume payload (see VOLUME_STORAGE_KEY). Null on any
 *  malformed input — bad JSON, wrong shape, non-numeric volume — so a
 *  corrupted stored value can never crash the player or set an out-of-range
 *  volume; the stored volume itself is re-clamped defensively. */
export function parseStoredVolume(raw: string | null): StoredVolume | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { volume, muted } = parsed as { volume?: unknown; muted?: unknown };
  if (typeof volume !== "number" || !Number.isFinite(volume)) return null;
  return { volume: clampVolume(volume), muted: muted === true };
}

/** Serialize a volume/mute pair for VOLUME_STORAGE_KEY (round-trips through
 *  parseStoredVolume). */
export function serializeVolume(volume: number, muted: boolean): string {
  return JSON.stringify({ volume: clampVolume(volume), muted });
}

// ============================================================================
// hls.js fatal-error recovery
// ============================================================================

// String values of hls.js's public ErrorTypes enum — mirrored here so this
// module stays import-free of hls.js (they're stable public API).
export const HLS_NETWORK_ERROR = "networkError";
export const HLS_MEDIA_ERROR = "mediaError";

export type HlsRecoveryAction = "startLoad" | "recoverMediaError" | "fail";

/** Which one-shot recoveries have already been spent for the current media
 *  pipeline (reset whenever the pipeline is rebuilt). */
export interface HlsRecoveryAttempts {
  networkTried: boolean;
  mediaTried: boolean;
}

/** What to do about a FATAL hls.js error, following hls.js's documented
 *  recovery recipes but allowing each exactly once per pipeline: a first
 *  fatal network error gets an hls.startLoad(), a first fatal media error an
 *  hls.recoverMediaError(). A repeat of an already-attempted family — or any
 *  other fatal type (mux/other) — gives up ("fail" -> error UI). The caller
 *  marks the attempt as spent. */
export function decideHlsRecovery(errorType: string, attempts: HlsRecoveryAttempts): HlsRecoveryAction {
  if (errorType === HLS_NETWORK_ERROR && !attempts.networkTried) return "startLoad";
  if (errorType === HLS_MEDIA_ERROR && !attempts.mediaTried) return "recoverMediaError";
  return "fail";
}
