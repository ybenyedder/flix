// Pure *arr helpers (src/server/arr/statusMap.ts): the request status machine,
// download-progress math, title normalisation, and the poster-proxy allowlist.
// No DB / network — the part most likely to be wrong, exhaustively covered.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  queueProgress,
  mapMovieStatus,
  mapShowStatus,
  isActiveStatus,
  normalizeTitle,
  titlesMatch,
  isAllowedPosterUrl,
  isStalledDownload,
  stallDecision,
} from "../src/server/arr/statusMap";

test("queueProgress: percentage from size/sizeleft, guarding zero/edge inputs", () => {
  assert.equal(queueProgress(100, 0), 100);
  assert.equal(queueProgress(100, 40), 60);
  assert.equal(queueProgress(100, 100), 0);
  assert.equal(queueProgress(0, 0), 0); // size 0 → no division
  assert.equal(queueProgress(null, null), 0);
  assert.equal(queueProgress(undefined, undefined), 0);
  assert.equal(queueProgress(100, 200), 0); // sizeleft > size clamps at 0
  assert.equal(queueProgress(100, -5), 100); // negative sizeleft treated as 0 left
  assert.equal(queueProgress(3, 1), 67); // rounds
});

test("isStalledDownload: frozen low-progress download is stalled; advancing/importing/failed are not", () => {
  // Frozen at 0% (no advance since last pass) → stalled.
  assert.equal(isStalledDownload({ status: "downloading", size: 1000, sizeleft: 999 }, 0, 0), true);
  assert.equal(isStalledDownload({ status: "warning", size: 1000, sizeleft: 980 }, 2, 2), true);
  // Crawling forward slowly (0% → 1%, still under the ceiling) → NOT stalled: it's alive.
  assert.equal(isStalledDownload({ status: "downloading", size: 1000, sizeleft: 990 }, 1, 0), false);
  // Making real progress (past the ceiling) → not stalled.
  assert.equal(isStalledDownload({ status: "downloading", size: 1000, sizeleft: 500 }, 50, 20), false);
  // Importing / completed → not a stall.
  assert.equal(isStalledDownload({ status: "completed" }, 0, 0), false);
  assert.equal(isStalledDownload({ trackedDownloadState: "importing" }, 0, 0), false);
  // Hard failure is handled by the status machine, not the stall watchdog.
  assert.equal(isStalledDownload({ trackedDownloadStatus: "error", errorMessage: "boom" }, 0, 0), false);
  // No queue item → nothing to stall on.
  assert.equal(isStalledDownload(null, 0, 0), false);
});

test("stallDecision: sets the clock, clears on progress, fires once past threshold", () => {
  const TEN = 10 * 60_000;
  // First stalled pass: clock starts now, no fallback yet.
  assert.deepEqual(stallDecision({ stalled: true, prevSince: null, alreadyFellBack: false, now: 1_000, thresholdMs: TEN }), {
    stalledSince: 1_000,
    fallback: false,
  });
  // Still stalled but within the window: keep the original timestamp, no fallback.
  assert.deepEqual(stallDecision({ stalled: true, prevSince: 1_000, alreadyFellBack: false, now: 1_000 + TEN - 1, thresholdMs: TEN }), {
    stalledSince: 1_000,
    fallback: false,
  });
  // Stall outlasts the window → fallback fires.
  assert.deepEqual(stallDecision({ stalled: true, prevSince: 1_000, alreadyFellBack: false, now: 1_000 + TEN, thresholdMs: TEN }), {
    stalledSince: 1_000,
    fallback: true,
  });
  // Already fell back once → never fires again.
  assert.equal(stallDecision({ stalled: true, prevSince: 1_000, alreadyFellBack: true, now: 1_000 + TEN * 5, thresholdMs: TEN }).fallback, false);
  // Download advanced (not stalled) → clock clears.
  assert.deepEqual(stallDecision({ stalled: false, prevSince: 1_000, alreadyFellBack: false, now: 9_999, thresholdMs: TEN }), {
    stalledSince: null,
    fallback: false,
  });
});

test("isActiveStatus: terminal statuses are inactive", () => {
  for (const s of ["requested", "searching", "downloading", "importing"] as const) assert.equal(isActiveStatus(s), true);
  assert.equal(isActiveStatus("available"), false);
  assert.equal(isActiveStatus("failed"), false);
});

test("mapMovieStatus: full lifecycle transitions", () => {
  // Library match wins over everything.
  assert.deepEqual(mapMovieStatus({ libraryMatched: true, queueItem: { status: "downloading" } }), { status: "available", progress: 100 });

  // Active download → progress.
  assert.deepEqual(mapMovieStatus({ queueItem: { status: "downloading", size: 100, sizeleft: 25 } }), { status: "downloading", progress: 75 });

  // Importing states.
  assert.deepEqual(mapMovieStatus({ queueItem: { trackedDownloadState: "importing" } }), { status: "importing", progress: 100 });
  assert.deepEqual(mapMovieStatus({ queueItem: { status: "completed" } }), { status: "importing", progress: 100 });

  // Failures carry a message.
  const failed = mapMovieStatus({ queueItem: { status: "failed", errorMessage: "no seeders" } });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "no seeders");
  const warned = mapMovieStatus({ queueItem: { trackedDownloadStatus: "error", errorMessage: "stalled" } });
  assert.equal(warned.status, "failed");
  assert.equal(warned.error, "stalled");

  // No queue item: file present but not yet in library → importing; else searching.
  assert.deepEqual(mapMovieStatus({ hasFile: true }), { status: "importing", progress: 100 });
  assert.deepEqual(mapMovieStatus({ hasFile: false }), { status: "searching", progress: 0 });
  assert.deepEqual(mapMovieStatus({}), { status: "searching", progress: 0 });
});

test("mapShowStatus: episodeFileCount stands in for hasFile", () => {
  assert.deepEqual(mapShowStatus({ libraryMatched: true }), { status: "available", progress: 100 });
  assert.deepEqual(mapShowStatus({ queueItem: { status: "downloading", size: 200, sizeleft: 100 } }), { status: "downloading", progress: 50 });
  assert.deepEqual(mapShowStatus({ episodeFileCount: 3 }), { status: "importing", progress: 100 });
  assert.deepEqual(mapShowStatus({ episodeFileCount: 0 }), { status: "searching", progress: 0 });
  assert.deepEqual(mapShowStatus({}), { status: "searching", progress: 0 });
});

test("normalizeTitle: diacritics, case, punctuation collapse", () => {
  assert.equal(normalizeTitle("Amélie: Le Fabuleux Destin"), "amelie le fabuleux destin");
  assert.equal(normalizeTitle("amelie   le  fabuleux destin"), "amelie le fabuleux destin");
  assert.equal(normalizeTitle("WALL·E"), "wall e");
  assert.equal(normalizeTitle("Spider-Man: No Way Home"), "spider man no way home");
  assert.equal(normalizeTitle("Léon"), "leon");
});

test("titlesMatch: normalised title + year tolerance", () => {
  assert.equal(titlesMatch({ title: "Léon", year: 1994 }, { title: "leon", year: 1994 }), true);
  assert.equal(titlesMatch({ title: "Léon", year: 1994 }, { title: "leon", year: 1995 }), true); // ±1
  assert.equal(titlesMatch({ title: "Léon", year: 1994 }, { title: "leon", year: 2000 }), false);
  assert.equal(titlesMatch({ title: "Léon", year: null }, { title: "leon", year: 1994 }), true); // unknown year → title only
  assert.equal(titlesMatch({ title: "Dune", year: 2021 }, { title: "Dune", year: 1984 }), false);
});

test("isAllowedPosterUrl: https + exact-host allowlist, rejecting spoofs", () => {
  assert.equal(isAllowedPosterUrl("https://image.tmdb.org/t/p/w500/abc.jpg"), true);
  assert.equal(isAllowedPosterUrl("https://artworks.thetvdb.com/banners/x.jpg"), true);
  assert.equal(isAllowedPosterUrl("https://assets.fanart.tv/fanart/x.png"), true);

  assert.equal(isAllowedPosterUrl("http://image.tmdb.org/x.jpg"), false); // not https
  assert.equal(isAllowedPosterUrl("https://image.tmdb.org.evil.com/x.jpg"), false); // suffix spoof
  assert.equal(isAllowedPosterUrl("https://user@image.tmdb.org/x.jpg"), false); // userinfo
  assert.equal(isAllowedPosterUrl("https://evil.com/x.jpg"), false); // other host
  assert.equal(isAllowedPosterUrl("not a url"), false);
  assert.equal(isAllowedPosterUrl("https://sub.image.tmdb.org/x.jpg"), false); // subdomain not allowed
});
