// Pure player logic: resume-offset math, watch/abandon classification, time
// formatting, season/episode order-walking, volume clamping/persistence and
// hls.js fatal-error recovery decisions. No DB, no DOM, no fetch.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeResumeStart,
  hasResumePoint,
  showHasResume,
  classifyWatchEvent,
  formatTime,
  findNextEpisode,
  pickNextUpEpisode,
  clampVolume,
  parseStoredVolume,
  serializeVolume,
  decideHlsRecovery,
  classifyChapter,
  chapterAt,
  skipTargetFor,
  nextUpTriggerTime,
  trickplayTileFor,
  HLS_NETWORK_ERROR,
  HLS_MEDIA_ERROR,
  NEXT_UP_LEAD_SECONDS,
} from "../src/lib/flix/playerLogic";
import type { SeasonDetail, EpisodeDetail, ProgressSummary, PlaybackChapter } from "../src/lib/flix/types";

// ============================================================================
// computeResumeStart
// ============================================================================

test("computeResumeStart: under the 30s floor never resumes", () => {
  assert.equal(computeResumeStart(0, 1000), 0);
  assert.equal(computeResumeStart(29, 1000), 0);
  assert.equal(computeResumeStart(30, 1000), 0); // strictly greater than, not >=
});

test("computeResumeStart: past 30s and below the watched threshold backs up 5s", () => {
  assert.equal(computeResumeStart(100, 1000), 95);
  assert.equal(computeResumeStart(31, 1000), 26);
});

test("computeResumeStart: never goes negative even just past the floor", () => {
  assert.equal(computeResumeStart(32, 1000), 27);
});

test("computeResumeStart: at/above the 92% watched threshold starts fresh (treated as finished)", () => {
  assert.equal(computeResumeStart(920, 1000), 0);
  assert.equal(computeResumeStart(999, 1000), 0);
});

test("computeResumeStart: an unknown (zero) duration doesn't block a resume — ratio defaults to 0, never looks 'finished'", () => {
  assert.equal(computeResumeStart(100, 0), 95);
});

// ============================================================================
// classifyWatchEvent
// ============================================================================

test("classifyWatchEvent: >=92% is a complete signal", () => {
  assert.deepEqual(classifyWatchEvent(920, 1000), { kind: "complete", ratio: 0.92 });
  assert.deepEqual(classifyWatchEvent(1000, 1000), { kind: "complete", ratio: 1 });
});

test("classifyWatchEvent: under 15% after at least 2 minutes is an abandon signal", () => {
  const { kind, ratio } = classifyWatchEvent(130, 10_000);
  assert.equal(kind, "abandon");
  assert.ok(ratio < 0.15);
});

test("classifyWatchEvent: under 15% but less than 2 minutes watched is not a signal", () => {
  assert.deepEqual(classifyWatchEvent(60, 10_000), { kind: null, ratio: 0.006 });
});

test("classifyWatchEvent: a normal mid-way stop (neither extreme) is not a signal", () => {
  assert.deepEqual(classifyWatchEvent(500, 1000), { kind: null, ratio: 0.5 });
});

test("classifyWatchEvent: zero duration never classifies as complete or abandon", () => {
  assert.deepEqual(classifyWatchEvent(200, 0), { kind: null, ratio: 0 });
});

// ============================================================================
// formatTime
// ============================================================================

test("formatTime: minutes:seconds under an hour", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(5), "0:05");
  assert.equal(formatTime(65), "1:05");
  assert.equal(formatTime(599), "9:59");
});

test("formatTime: hours:minutes:seconds at/over an hour", () => {
  assert.equal(formatTime(3600), "1:00:00");
  assert.equal(formatTime(3665), "1:01:05");
  assert.equal(formatTime(7325), "2:02:05");
});

test("formatTime: never negative or NaN", () => {
  assert.equal(formatTime(-5), "0:00");
  assert.equal(formatTime(NaN), "0:00");
});

// ============================================================================
// findNextEpisode / pickNextUpEpisode
// ============================================================================

function ep(id: number, seasonId: number, episodeNumber: number, overrides: Partial<EpisodeDetail> = {}): EpisodeDetail {
  return { id, seasonId, episodeNumber, episodeEnd: null, title: null, synopsis: null, airDate: null, duration: 1200, thumbHash: null, files: [], ...overrides };
}
function season(id: number, seasonNumber: number, episodes: EpisodeDetail[]): SeasonDetail {
  return { id, seasonNumber, title: null, posterHash: null, episodes };
}

const seasons: SeasonDetail[] = [
  season(1, 1, [ep(101, 1, 1), ep(102, 1, 2), ep(103, 1, 3)]),
  season(2, 2, [ep(201, 2, 1), ep(202, 2, 2)]),
];

test("findNextEpisode: next episode within the same season", () => {
  assert.equal(findNextEpisode(seasons, 101)?.id, 102);
  assert.equal(findNextEpisode(seasons, 102)?.id, 103);
});

test("findNextEpisode: end of season rolls over to episode 1 of the next season", () => {
  assert.equal(findNextEpisode(seasons, 103)?.id, 201);
});

test("findNextEpisode: series finale returns null", () => {
  assert.equal(findNextEpisode(seasons, 202), null);
});

test("findNextEpisode: skips an empty season on the way to the next non-empty one", () => {
  const withEmptySeason = [season(1, 1, [ep(101, 1, 1)]), season(2, 2, []), season(3, 3, [ep(301, 3, 1)])];
  assert.equal(findNextEpisode(withEmptySeason, 101)?.id, 301);
});

test("findNextEpisode: unknown episode id returns null", () => {
  assert.equal(findNextEpisode(seasons, 999), null);
});

function progressRow(itemId: number, position: number, duration: number, watched: boolean): ProgressSummary {
  return { itemType: "episode", itemId, mediaFileId: null, position, duration, watched, updatedAt: 0, topType: "show", topId: 1, title: "Show", subtitle: null, posterHash: null, backdropHash: null, thumbHash: null };
}

test("pickNextUpEpisode: resumes a genuinely in-progress episode over anything else", () => {
  const progress = [progressRow(101, 1200, 1200, true), progressRow(102, 300, 1200, false)];
  assert.equal(pickNextUpEpisode(seasons, progress)?.id, 102);
});

test("pickNextUpEpisode: no in-progress episode -> first never-watched episode in order", () => {
  const progress = [progressRow(101, 1200, 1200, true)];
  assert.equal(pickNextUpEpisode(seasons, progress)?.id, 102);
});

test("pickNextUpEpisode: everything watched -> restart from episode 1", () => {
  const progress = seasons.flatMap((s) => s.episodes).map((e) => progressRow(e.id, 1200, 1200, true));
  assert.equal(pickNextUpEpisode(seasons, progress)?.id, 101);
});

test("pickNextUpEpisode: no episodes at all -> null", () => {
  assert.equal(pickNextUpEpisode([season(1, 1, [])], []), null);
});

test("pickNextUpEpisode: no progress at all -> starts from episode 1", () => {
  assert.equal(pickNextUpEpisode(seasons, [])?.id, 101);
});

// ============================================================================
// hasResumePoint / showHasResume ("Reprendre" vs "Lecture" button label)
// ============================================================================

test("hasResumePoint: true only when computeResumeStart would resume (past 30s, under 92%)", () => {
  assert.equal(hasResumePoint(100, 1000), true); // mid-way
  assert.equal(hasResumePoint(20, 1000), false); // under the 30s floor -> plays from 0
  assert.equal(hasResumePoint(950, 1000), false); // past 92% -> finished, plays from 0
});

test("showHasResume: a fresh, never-watched series reads Lecture (no history)", () => {
  assert.equal(showHasResume(seasons, []), false);
});

test("showHasResume: a series with a watched or in-progress episode reads Reprendre", () => {
  assert.equal(showHasResume(seasons, [progressRow(101, 1200, 1200, true)]), true); // ep1 watched, more remain
  assert.equal(showHasResume(seasons, [progressRow(102, 300, 1200, false)]), true); // ep2 in progress
});

test("showHasResume: a barely-touched episode (<=5s) doesn't count as started", () => {
  assert.equal(showHasResume(seasons, [progressRow(101, 3, 1200, false)]), false);
});

test("showHasResume: a fully-watched series reads Lecture (a rewatch from #1, not a resume)", () => {
  const all = seasons.flatMap((s) => s.episodes).map((e) => progressRow(e.id, 1200, 1200, true));
  assert.equal(showHasResume(seasons, all), false);
});

// ============================================================================
// clampVolume
// ============================================================================

test("clampVolume: in-range values pass through untouched", () => {
  assert.equal(clampVolume(0), 0);
  assert.equal(clampVolume(0.5), 0.5);
  assert.equal(clampVolume(1), 1);
});

test("clampVolume: out-of-range values clamp to [0, 1]", () => {
  assert.equal(clampVolume(-0.3), 0);
  assert.equal(clampVolume(1.1), 1);
  assert.equal(clampVolume(42), 1);
});

test("clampVolume: non-finite input falls back to full volume, never a silent mute", () => {
  assert.equal(clampVolume(NaN), 1);
  assert.equal(clampVolume(Infinity), 1);
  assert.equal(clampVolume(-Infinity), 1);
});

// ============================================================================
// parseStoredVolume / serializeVolume
// ============================================================================

test("parseStoredVolume: round-trips what serializeVolume wrote", () => {
  assert.deepEqual(parseStoredVolume(serializeVolume(0.7, false)), { volume: 0.7, muted: false });
  assert.deepEqual(parseStoredVolume(serializeVolume(0, true)), { volume: 0, muted: true });
});

test("serializeVolume: clamps before persisting", () => {
  assert.deepEqual(parseStoredVolume(serializeVolume(3, false)), { volume: 1, muted: false });
});

test("parseStoredVolume: null/empty input -> null", () => {
  assert.equal(parseStoredVolume(null), null);
  assert.equal(parseStoredVolume(""), null);
});

test("parseStoredVolume: malformed JSON or wrong shape -> null", () => {
  assert.equal(parseStoredVolume("{not json"), null);
  assert.equal(parseStoredVolume('"0.5"'), null);
  assert.equal(parseStoredVolume("0.5"), null);
  assert.equal(parseStoredVolume("null"), null);
  assert.equal(parseStoredVolume('{"muted":true}'), null); // volume missing
  assert.equal(parseStoredVolume('{"volume":"loud","muted":false}'), null); // volume not a number
  assert.equal(parseStoredVolume('{"volume":null}'), null);
});

test("parseStoredVolume: re-clamps a tampered out-of-range volume", () => {
  assert.deepEqual(parseStoredVolume('{"volume":9,"muted":false}'), { volume: 1, muted: false });
  assert.deepEqual(parseStoredVolume('{"volume":-1,"muted":true}'), { volume: 0, muted: true });
});

test("parseStoredVolume: muted must be exactly true — anything else reads as false", () => {
  assert.deepEqual(parseStoredVolume('{"volume":0.4,"muted":1}'), { volume: 0.4, muted: false });
  assert.deepEqual(parseStoredVolume('{"volume":0.4}'), { volume: 0.4, muted: false });
});

// ============================================================================
// decideHlsRecovery
// ============================================================================

test("decideHlsRecovery: first fatal network error -> startLoad", () => {
  assert.equal(decideHlsRecovery(HLS_NETWORK_ERROR, { networkTried: false, mediaTried: false }), "startLoad");
});

test("decideHlsRecovery: second fatal network error -> fail (one attempt only)", () => {
  assert.equal(decideHlsRecovery(HLS_NETWORK_ERROR, { networkTried: true, mediaTried: false }), "fail");
});

test("decideHlsRecovery: first fatal media error -> recoverMediaError", () => {
  assert.equal(decideHlsRecovery(HLS_MEDIA_ERROR, { networkTried: false, mediaTried: false }), "recoverMediaError");
});

test("decideHlsRecovery: second fatal media error -> fail (one attempt only)", () => {
  assert.equal(decideHlsRecovery(HLS_MEDIA_ERROR, { networkTried: false, mediaTried: true }), "fail");
});

test("decideHlsRecovery: the two error families are tracked independently", () => {
  assert.equal(decideHlsRecovery(HLS_MEDIA_ERROR, { networkTried: true, mediaTried: false }), "recoverMediaError");
  assert.equal(decideHlsRecovery(HLS_NETWORK_ERROR, { networkTried: false, mediaTried: true }), "startLoad");
});

test("decideHlsRecovery: any other fatal error type has no recovery recipe -> fail", () => {
  assert.equal(decideHlsRecovery("muxError", { networkTried: false, mediaTried: false }), "fail");
  assert.equal(decideHlsRecovery("otherError", { networkTried: false, mediaTried: false }), "fail");
  assert.equal(decideHlsRecovery("", { networkTried: false, mediaTried: false }), "fail");
});

// ============================================================================
// classifyChapter
// ============================================================================

test("classifyChapter: intro/opening variants, case- and accent-insensitive", () => {
  assert.equal(classifyChapter("Intro"), "intro");
  assert.equal(classifyChapter("INTRO"), "intro");
  assert.equal(classifyChapter("Introduction"), "intro");
  assert.equal(classifyChapter("Opening"), "intro");
  assert.equal(classifyChapter("Title Sequence"), "intro");
  assert.equal(classifyChapter("Main Title"), "intro");
});

test("classifyChapter: a bare « générique » is the OPENING titles (Netflix FR wording), with or without accents", () => {
  assert.equal(classifyChapter("Générique"), "intro");
  assert.equal(classifyChapter("generique"), "intro");
  assert.equal(classifyChapter("Générique de début"), "intro");
});

test("classifyChapter: qualified end credits win over the intro patterns they contain", () => {
  assert.equal(classifyChapter("Générique de fin"), "credits");
  assert.equal(classifyChapter("End Credits"), "credits");
  assert.equal(classifyChapter("Closing Credits"), "credits");
});

test("classifyChapter: opening credits are an intro, not end credits", () => {
  assert.equal(classifyChapter("Opening Credits"), "intro");
});

test("classifyChapter: unqualified credits/outro/ending variants", () => {
  assert.equal(classifyChapter("Credits"), "credits");
  assert.equal(classifyChapter("credit"), "credits");
  assert.equal(classifyChapter("Outro"), "credits");
  assert.equal(classifyChapter("Ending"), "credits");
});

test("classifyChapter: recap variants, French and English", () => {
  assert.equal(classifyChapter("Récap"), "recap");
  assert.equal(classifyChapter("Recap"), "recap");
  assert.equal(classifyChapter("Récapitulatif"), "recap");
  assert.equal(classifyChapter("Previously on Dark"), "recap");
  assert.equal(classifyChapter("Précédemment"), "recap");
});

test("classifyChapter: ordinary chapter titles and empty input -> null", () => {
  assert.equal(classifyChapter("Chapter 1"), null);
  assert.equal(classifyChapter("Chapitre 3"), null);
  assert.equal(classifyChapter("The Heist"), null);
  assert.equal(classifyChapter(""), null);
  assert.equal(classifyChapter(null), null);
  assert.equal(classifyChapter(undefined), null);
});

// ============================================================================
// chapterAt / skipTargetFor
// ============================================================================

function ch(start: number, end: number, title: string | null): PlaybackChapter {
  return { start, end, title };
}

const episodeChapters: PlaybackChapter[] = [
  ch(0, 30, "Récap"),
  ch(30, 90, "Intro"),
  ch(90, 1100, "Chapter 1"),
  ch(1100, 1200, "Générique de fin"),
];

test("chapterAt: [start, end) — a boundary instant belongs to the chapter it opens", () => {
  assert.equal(chapterAt(episodeChapters, 0)?.title, "Récap");
  assert.equal(chapterAt(episodeChapters, 29.9)?.title, "Récap");
  assert.equal(chapterAt(episodeChapters, 30)?.title, "Intro");
  assert.equal(chapterAt(episodeChapters, 500)?.title, "Chapter 1");
  assert.equal(chapterAt(episodeChapters, 1150)?.title, "Générique de fin");
});

test("chapterAt: outside every chapter (past the end, or a gap) -> null", () => {
  assert.equal(chapterAt(episodeChapters, 1200), null);
  assert.equal(chapterAt(episodeChapters, 5000), null);
  assert.equal(chapterAt([ch(10, 20, "A")], 5), null); // before the first chapter
  assert.equal(chapterAt([], 5), null);
});

test("skipTargetFor: inside an intro chapter -> its end", () => {
  assert.equal(skipTargetFor(episodeChapters, 35), 90);
  assert.equal(skipTargetFor(episodeChapters, 30), 90);
});

test("skipTargetFor: inside a recap chapter -> its end (also skippable)", () => {
  assert.equal(skipTargetFor(episodeChapters, 5), 30);
});

test("skipTargetFor: a normal or credits chapter is never skip-intro material", () => {
  assert.equal(skipTargetFor(episodeChapters, 500), null);
  assert.equal(skipTargetFor(episodeChapters, 1150), null);
});

test("skipTargetFor: under a second left in the chapter -> null (nothing worth skipping)", () => {
  assert.equal(skipTargetFor(episodeChapters, 89.5), null);
});

test("skipTargetFor: no chapters at all -> null", () => {
  assert.equal(skipTargetFor([], 42), null);
});

// ============================================================================
// nextUpTriggerTime
// ============================================================================

test("nextUpTriggerTime: with an end-credits chapter, triggers at its start", () => {
  assert.equal(nextUpTriggerTime(episodeChapters, 1200), 1100);
});

test("nextUpTriggerTime: no chapters -> historical duration-30s fallback", () => {
  assert.equal(nextUpTriggerTime([], 1200), 1200 - NEXT_UP_LEAD_SECONDS);
});

test("nextUpTriggerTime: chapters but none credits-like -> same fallback", () => {
  assert.equal(nextUpTriggerTime([ch(0, 60, "Intro"), ch(60, 1200, "Chapter 1")], 1200), 1200 - NEXT_UP_LEAD_SECONDS);
});

test("nextUpTriggerTime: a credits chapter in the FIRST half (misclassified opening) never triggers the card early", () => {
  assert.equal(nextUpTriggerTime([ch(10, 60, "Credits"), ch(60, 1200, "Chapter 1")], 1200), 1200 - NEXT_UP_LEAD_SECONDS);
});

test("nextUpTriggerTime: a credits chapter later than duration-30s still wins (trigger follows the chapter, not the lead)", () => {
  assert.equal(nextUpTriggerTime([ch(1195, 1200, "End Credits")], 1200), 1195);
});

test("nextUpTriggerTime: unknown duration -> Infinity (never triggers)", () => {
  assert.equal(nextUpTriggerTime(episodeChapters, 0), Infinity);
  assert.equal(nextUpTriggerTime([], -5), Infinity);
});

test("nextUpTriggerTime: short file — the fallback never goes negative", () => {
  assert.equal(nextUpTriggerTime([], 10), 0);
});

// ============================================================================
// trickplayTileFor
// ============================================================================

const meta = { interval: 10, tileWidth: 320, tileHeight: 180, cols: 8, count: 20 };

test("trickplayTileFor: maps a time to its row-major tile and CSS offsets", () => {
  assert.deepEqual(trickplayTileFor(meta, 0), { index: 0, col: 0, row: 0, offsetX: -0, offsetY: -0 });
  assert.deepEqual(trickplayTileFor(meta, 9.99), { index: 0, col: 0, row: 0, offsetX: -0, offsetY: -0 });
  assert.deepEqual(trickplayTileFor(meta, 10), { index: 1, col: 1, row: 0, offsetX: -320, offsetY: -0 });
  assert.deepEqual(trickplayTileFor(meta, 85), { index: 8, col: 0, row: 1, offsetX: -0, offsetY: -180 });
  assert.deepEqual(trickplayTileFor(meta, 155), { index: 15, col: 7, row: 1, offsetX: -2240, offsetY: -180 });
});

test("trickplayTileFor: clamps past-the-end and negative times to real tiles", () => {
  assert.equal(trickplayTileFor(meta, 10_000).index, 19); // last valid tile
  assert.deepEqual(trickplayTileFor(meta, 10_000), { index: 19, col: 3, row: 2, offsetX: -960, offsetY: -360 });
  assert.equal(trickplayTileFor(meta, -5).index, 0);
});

test("trickplayTileFor: defensive against degenerate metadata (non-positive interval/cols/count, NaN time)", () => {
  assert.equal(trickplayTileFor({ ...meta, interval: 0 }, 25).index, 2); // falls back to a 10s interval
  assert.equal(trickplayTileFor({ ...meta, cols: 0 }, 25).col, 0); // cols floor-clamped to 1
  assert.equal(trickplayTileFor({ ...meta, count: 0 }, 25).index, 0);
  assert.equal(trickplayTileFor(meta, NaN).index, 0);
});
