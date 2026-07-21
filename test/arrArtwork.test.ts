// Pure helpers of the arr artwork enrichment pass (server/arr/artwork.ts):
// which slots want art, which cover URL is eligible, and how the instance
// base URL joins a cover path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNeeds, hasAnyNeed, localCoverPath, joinInstanceUrl, type ArtRow } from "../src/server/arr/artwork";

function row(overrides: Partial<ArtRow>): ArtRow {
  return {
    id: 1,
    poster_hash: null,
    poster_source: null,
    backdrop_hash: null,
    backdrop_source: null,
    logo_hash: null,
    ...overrides,
  };
}

// ============================================================================
// computeNeeds — sidecar/embedded/arr art is untouchable, generated/missing is fair game
// ============================================================================

test("computeNeeds: everything missing -> everything wanted", () => {
  assert.deepEqual(computeNeeds(row({})), { poster: true, backdrop: true, logo: true });
});

test("computeNeeds: frame-generated poster/backdrop are replaceable", () => {
  const needs = computeNeeds(row({ poster_hash: "aa", poster_source: "generated", backdrop_hash: "bb", backdrop_source: "generated" }));
  assert.equal(needs.poster, true);
  assert.equal(needs.backdrop, true);
});

test("computeNeeds: sidecar and embedded art always win over arr", () => {
  const needs = computeNeeds(row({ poster_hash: "aa", poster_source: "sidecar", backdrop_hash: "bb", backdrop_source: "embedded" }));
  assert.equal(needs.poster, false);
  assert.equal(needs.backdrop, false);
});

test("computeNeeds: arr art is not refetched on later passes", () => {
  const needs = computeNeeds(row({ poster_hash: "aa", poster_source: "arr" }));
  assert.equal(needs.poster, false);
});

test("computeNeeds: a logo is only ever filled, never replaced", () => {
  assert.equal(computeNeeds(row({ logo_hash: "cc" })).logo, false);
  assert.equal(computeNeeds(row({})).logo, true);
});

test("hasAnyNeed: false only when every slot is satisfied", () => {
  assert.equal(hasAnyNeed({ poster: false, backdrop: false, logo: false }), false);
  assert.equal(hasAnyNeed({ poster: false, backdrop: true, logo: false }), true);
});

// ============================================================================
// localCoverPath — instance-local only, never the TMDB remoteUrl
// ============================================================================

test("localCoverPath: picks the matching coverType's local url", () => {
  const images = [
    { coverType: "fanart", url: "/MediaCover/7/fanart.jpg" },
    { coverType: "poster", url: "/MediaCover/7/poster.jpg?lastWrite=1", remoteUrl: "https://image.tmdb.org/x.jpg" },
  ];
  assert.equal(localCoverPath(images, "poster"), "/MediaCover/7/poster.jpg?lastWrite=1");
});

test("localCoverPath: a remoteUrl-only record yields null (public internet is off-limits)", () => {
  assert.equal(localCoverPath([{ coverType: "poster", remoteUrl: "https://image.tmdb.org/x.jpg" }], "poster"), null);
});

test("localCoverPath: absolute http url in `url` is rejected too", () => {
  assert.equal(localCoverPath([{ coverType: "poster", url: "https://elsewhere.example/p.jpg" }], "poster"), null);
});

test("localCoverPath: absent images/coverType -> null", () => {
  assert.equal(localCoverPath(undefined, "poster"), null);
  assert.equal(localCoverPath([], "clearlogo"), null);
});

// ============================================================================
// joinInstanceUrl — sub-path url-base deduplication
// ============================================================================

test("joinInstanceUrl: plain base + cover path", () => {
  assert.equal(joinInstanceUrl("http://radarr:7878", "/MediaCover/1/poster.jpg"), "http://radarr:7878/MediaCover/1/poster.jpg");
});

test("joinInstanceUrl: trailing slash on the base is collapsed", () => {
  assert.equal(joinInstanceUrl("http://radarr:7878/", "/MediaCover/1/poster.jpg"), "http://radarr:7878/MediaCover/1/poster.jpg");
});

test("joinInstanceUrl: url-base prefix present in the cover path is not doubled", () => {
  assert.equal(joinInstanceUrl("http://host/radarr", "/radarr/MediaCover/1/poster.jpg"), "http://host/radarr/MediaCover/1/poster.jpg");
});

test("joinInstanceUrl: cover path without the url-base prefix still lands under it", () => {
  assert.equal(joinInstanceUrl("http://host/radarr", "/MediaCover/1/poster.jpg"), "http://host/radarr/MediaCover/1/poster.jpg");
});
