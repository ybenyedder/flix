// Pure tests for the upload path-target builders: segment sanitisation
// (traversal, separators, hidden/reserved/trailing-junk names, emptiness), and
// — the point of the whole module — that the movie/episode rel paths we hand to
// the scanner actually round-trip back through parseMovieName / matchEpisodePath
// to the title/year/season/episode we started from. renameOnConflict is
// exercised against a real temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { sanitizeSegment, movieTargetRel, episodeTargetRel, renameOnConflict } from "../src/server/upload/targets";
import { parseMovieName } from "../src/server/library/namingMovies";
import { matchEpisodePath, parseShowFolderName } from "../src/server/library/namingShows";

// --- sanitizeSegment --------------------------------------------------------

test("sanitizeSegment: neutralises a `..` traversal segment to empty", () => {
  assert.equal(sanitizeSegment(".."), "");
  assert.equal(sanitizeSegment("."), "");
  assert.equal(sanitizeSegment("../../etc"), "etc"); // slashes stripped, leading dots peeled
});

test("sanitizeSegment: strips path separators", () => {
  assert.equal(sanitizeSegment("a/b"), "ab");
  assert.equal(sanitizeSegment("a\\b"), "ab");
});

test("sanitizeSegment: strips a leading dot (no hidden-file segments)", () => {
  assert.equal(sanitizeSegment(".hidden"), "hidden");
});

test("sanitizeSegment: neutralises Windows reserved device names", () => {
  assert.equal(sanitizeSegment("con"), "_con");
  assert.equal(sanitizeSegment("CON"), "_CON");
  assert.equal(sanitizeSegment("nul.txt"), "_nul.txt");
});

test("sanitizeSegment: strips forbidden characters", () => {
  assert.equal(sanitizeSegment('a:b*c?"d<e>f|g'), "abcdefg");
});

test("sanitizeSegment: strips trailing dots and spaces (Windows-safe)", () => {
  assert.equal(sanitizeSegment("name.  "), "name");
  assert.equal(sanitizeSegment("name..."), "name");
});

test("sanitizeSegment: collapses internal whitespace", () => {
  assert.equal(sanitizeSegment("The   Matrix\t\tReloaded"), "The Matrix Reloaded");
});

test("sanitizeSegment: empty / whitespace-only input returns empty", () => {
  assert.equal(sanitizeSegment(""), "");
  assert.equal(sanitizeSegment("    "), "");
  // @ts-expect-error — defensive against non-string callers
  assert.equal(sanitizeSegment(null), "");
});

// --- movieTargetRel round-trips through parseMovieName -----------------------

test("movieTargetRel: title + year classifies back to the same title/year", () => {
  const rel = movieTargetRel("The Matrix", 1999, ".mkv");
  assert.equal(rel, "movies/The Matrix (1999)/The Matrix (1999).mkv");

  const dirParts = path.posix.dirname(rel).split("/");
  const filename = path.posix.basename(rel);
  // Not an episode.
  assert.equal(matchEpisodePath(dirParts, filename), null);
  // Movie folder base parses back.
  const parsed = parseMovieName(dirParts[dirParts.length - 1]);
  assert.equal(parsed.title, "The Matrix");
  assert.equal(parsed.year, 1999);
});

test("movieTargetRel: no year → title-only folder, still parses", () => {
  const rel = movieTargetRel("Amadeus", null, ".MKV");
  assert.equal(rel, "movies/Amadeus/Amadeus.mkv"); // extension lowercased
  const parsed = parseMovieName("Amadeus");
  assert.equal(parsed.title, "Amadeus");
  assert.equal(parsed.year, null);
});

test("movieTargetRel: ext without a leading dot is normalised", () => {
  assert.equal(movieTargetRel("Dune", 2021, "mp4"), "movies/Dune (2021)/Dune (2021).mp4");
});

// --- episodeTargetRel round-trips through matchEpisodePath -------------------

test("episodeTargetRel: keeps the SxxEyy filename and classifies correctly", () => {
  const rel = episodeTargetRel("Dark", 2017, 1, "Dark S01E01.mkv");
  assert.equal(rel, "shows/Dark (2017)/Season 01/Dark S01E01.mkv");

  const dirParts = path.posix.dirname(rel).split("/");
  const filename = path.posix.basename(rel);
  const match = matchEpisodePath(dirParts, filename);
  assert.ok(match, "should classify as an episode");
  assert.equal(match?.season, 1);
  assert.equal(match?.episode, 1);
  assert.equal(match?.showFolder, "shows/Dark (2017)");

  const show = parseShowFolderName(path.posix.basename(match?.showFolder ?? ""));
  assert.equal(show.title, "Dark");
  assert.equal(show.year, 2017);
});

test("episodeTargetRel: two-digit season zero-padding and no-year show", () => {
  const rel = episodeTargetRel("Breaking Bad", null, 12, "Breaking.Bad.S12E03.mkv");
  assert.equal(rel, "shows/Breaking Bad/Season 12/Breaking.Bad.S12E03.mkv");
  const dirParts = path.posix.dirname(rel).split("/");
  const match = matchEpisodePath(dirParts, path.posix.basename(rel));
  assert.equal(match?.season, 12);
  assert.equal(match?.episode, 3);
});

test("episodeTargetRel: season 0 (Specials-style) pads to 00", () => {
  const rel = episodeTargetRel("My Show", 2020, 0, "My Show S00E01.mkv");
  assert.equal(rel, "shows/My Show (2020)/Season 00/My Show S00E01.mkv");
});

// --- renameOnConflict -------------------------------------------------------

test("renameOnConflict: suffixes ` (2)`, ` (3)` before the extension until free", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flix-conflict-test-"));
  try {
    const target = path.join(dir, "Movie (2021).mkv");
    // Free target → returned unchanged.
    assert.equal(renameOnConflict(target), target);

    fs.writeFileSync(target, "");
    const second = renameOnConflict(target);
    assert.equal(second, path.join(dir, "Movie (2021) (2).mkv"));

    fs.writeFileSync(second, "");
    const third = renameOnConflict(target);
    assert.equal(third, path.join(dir, "Movie (2021) (3).mkv"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
