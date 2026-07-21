// Pure helpers of the online artwork provider (server/library/onlineArtwork.ts):
// TMDB image election, TVmaze/Wikipedia payload extraction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTmdbImage, tmdbImageUrl, tvmazePosterUrl, wikipediaImageUrl, wikipediaFirstTitle } from "../src/server/library/onlineArtwork";

// ============================================================================
// pickTmdbImage — fr > language-neutral > en > first
// ============================================================================

test("pickTmdbImage: prefers the French variant", () => {
  const records = [
    { file_path: "/en.jpg", iso_639_1: "en" },
    { file_path: "/fr.jpg", iso_639_1: "fr" },
    { file_path: "/neutral.jpg", iso_639_1: null },
  ];
  assert.equal(pickTmdbImage(records), "/fr.jpg");
});

test("pickTmdbImage: falls back to language-neutral, then English", () => {
  assert.equal(
    pickTmdbImage([
      { file_path: "/en.jpg", iso_639_1: "en" },
      { file_path: "/neutral.jpg", iso_639_1: null },
    ]),
    "/neutral.jpg",
  );
  assert.equal(
    pickTmdbImage([
      { file_path: "/de.jpg", iso_639_1: "de" },
      { file_path: "/en.jpg", iso_639_1: "en" },
    ]),
    "/en.jpg",
  );
});

test("pickTmdbImage: any language beats nothing; empty/absent -> null", () => {
  assert.equal(pickTmdbImage([{ file_path: "/de.jpg", iso_639_1: "de" }]), "/de.jpg");
  assert.equal(pickTmdbImage([]), null);
  assert.equal(pickTmdbImage(undefined), null);
});

test("tmdbImageUrl: joins the CDN base and size", () => {
  assert.equal(tmdbImageUrl("/abc.jpg", "w780"), "https://image.tmdb.org/t/p/w780/abc.jpg");
  assert.equal(tmdbImageUrl("/abc.jpg"), "https://image.tmdb.org/t/p/w780/abc.jpg");
});

// ============================================================================
// tvmazePosterUrl
// ============================================================================

test("tvmazePosterUrl: original preferred over medium", () => {
  assert.equal(tvmazePosterUrl({ image: { original: "http://x/o.jpg", medium: "http://x/m.jpg" } }), "http://x/o.jpg");
  assert.equal(tvmazePosterUrl({ image: { medium: "http://x/m.jpg" } }), "http://x/m.jpg");
});

test("tvmazePosterUrl: malformed payloads -> null", () => {
  assert.equal(tvmazePosterUrl(null), null);
  assert.equal(tvmazePosterUrl({}), null);
  assert.equal(tvmazePosterUrl({ image: null }), null);
  assert.equal(tvmazePosterUrl({ image: { original: 42 } }), null);
});

// ============================================================================
// wikipediaImageUrl / wikipediaFirstTitle
// ============================================================================

test("wikipediaImageUrl: infobox image accepted, SVG rejected (logo, not a poster)", () => {
  assert.equal(wikipediaImageUrl({ originalimage: { source: "https://upload.wikimedia.org/x/poster.jpg" } }), "https://upload.wikimedia.org/x/poster.jpg");
  assert.equal(wikipediaImageUrl({ originalimage: { source: "https://upload.wikimedia.org/x/logo.svg" } }), null);
});

test("wikipediaImageUrl: missing/malformed -> null", () => {
  assert.equal(wikipediaImageUrl({}), null);
  assert.equal(wikipediaImageUrl(null), null);
  assert.equal(wikipediaImageUrl({ originalimage: { source: "not-a-url" } }), null);
});

test("wikipediaFirstTitle: first search hit, null when empty", () => {
  assert.equal(wikipediaFirstTitle({ query: { search: [{ title: "Inception" }, { title: "Inception (soundtrack)" }] } }), "Inception");
  assert.equal(wikipediaFirstTitle({ query: { search: [] } }), null);
  assert.equal(wikipediaFirstTitle({}), null);
});
