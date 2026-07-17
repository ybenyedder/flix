// Kodi NFO parsing tests, against real fixture files. Confirms field mapping,
// that remote-looking fields (<thumb> URLs, <uniqueid>) are never surfaced,
// and that malformed XML degrades to null instead of throwing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { parseMovieNfo, parseTvShowNfo, parseEpisodeNfo, readNfoFile } from "../src/server/library/nfo";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

test("parseMovieNfo: maps title/year/plot/genres/actors/director/studio/mpaa", () => {
  const movie = parseMovieNfo(fixture("movie.nfo"));
  assert.ok(movie);
  assert.equal(movie?.title, "Inception");
  assert.equal(movie?.originalTitle, "Inception");
  assert.equal(movie?.year, 2010);
  assert.match(movie?.plot ?? "", /thief who steals corporate secrets/);
  assert.equal(movie?.tagline, "Your mind is the scene of the crime.");
  assert.equal(movie?.runtime, 148);
  assert.equal(movie?.contentRating, "PG-13");
  assert.equal(movie?.studio, "Warner Bros. Pictures");
  assert.deepEqual(movie?.genres, ["Action", "Science Fiction", "Thriller"]);
  assert.deepEqual(movie?.directors, ["Christopher Nolan"]);
  assert.equal(movie?.actors.length, 2);
  assert.deepEqual(movie?.actors[0], { name: "Leonardo DiCaprio", role: "Cobb" });
});

test("parseMovieNfo: never surfaces <thumb>/<uniqueid> URLs or ids", () => {
  const movie = parseMovieNfo(fixture("movie.nfo"));
  const serialized = JSON.stringify(movie);
  assert.doesNotMatch(serialized, /example\.com/);
  assert.doesNotMatch(serialized, /tt1375666/);
});

test("parseMovieNfo: a single (non-repeated) genre/actor is still an array", () => {
  const movie = parseMovieNfo(fixture("movie-single-genre.nfo"));
  assert.deepEqual(movie?.genres, ["Romance"]);
  assert.equal(movie?.actors.length, 1);
  assert.equal(movie?.actors[0].name, "Audrey Tautou");
});

test("parseMovieNfo: truncates absurdly long titles/plots", () => {
  const longTitle = "A".repeat(600);
  const longPlot = "B".repeat(6000);
  const xml = `<movie><title>${longTitle}</title><plot>${longPlot}</plot></movie>`;
  const movie = parseMovieNfo(xml);
  assert.equal(movie?.title?.length, 500);
  assert.equal(movie?.plot?.length, 5000);
});

test("parseMovieNfo: returns null when the root tag isn't <movie>", () => {
  assert.equal(parseMovieNfo(fixture("tvshow.nfo")), null);
});

test("parseMovieNfo: garbage input with no <movie> root degrades to null instead of throwing", () => {
  assert.doesNotThrow(() => parseMovieNfo(fixture("malformed.nfo")));
  assert.equal(parseMovieNfo(fixture("malformed.nfo")), null);
});

test("parseMovieNfo: a parser-level throw (pathologically deep nesting) is caught and returns null", () => {
  const bomb = `<movie>${"<a>".repeat(5000)}${"</a>".repeat(5000)}</movie>`;
  assert.doesNotThrow(() => parseMovieNfo(bomb));
  assert.equal(parseMovieNfo(bomb), null);
});

test("parseMovieNfo: an unclosed inner tag degrades individual fields to null rather than losing the whole file", () => {
  const xml = "<movie><title>Broken\n  <year>2020</year>\n</movie>";
  const movie = parseMovieNfo(xml);
  // fast-xml-parser is a lenient, non-validating parser: the unclosed <title>
  // swallows <year> as a child instead of a sibling, so title/year end up
  // unreadable as plain strings — but parsing still succeeds without throwing,
  // and every OTHER (well-formed) field on a real file is unaffected.
  assert.ok(movie);
  assert.equal(movie?.title, null);
  assert.equal(movie?.year, null);
});

test("parseTvShowNfo: maps show-level fields", () => {
  const show = parseTvShowNfo(fixture("tvshow.nfo"));
  assert.ok(show);
  assert.equal(show?.title, "Dark");
  assert.equal(show?.year, 2017);
  assert.equal(show?.status, "Ended");
  assert.equal(show?.contentRating, "TV-MA");
  assert.deepEqual(show?.genres, ["Crime", "Drama", "Mystery"]);
  assert.equal(show?.actors[0]?.name, "Louis Hofmann");
});

test("parseTvShowNfo: returns null when the root tag isn't <tvshow>", () => {
  assert.equal(parseTvShowNfo(fixture("movie.nfo")), null);
});

test("parseEpisodeNfo: maps episode-level fields", () => {
  const ep = parseEpisodeNfo(fixture("episode.nfo"));
  assert.ok(ep);
  assert.equal(ep?.title, "Secrets");
  assert.equal(ep?.season, 1);
  assert.equal(ep?.episode, 1);
  assert.equal(ep?.aired, "2017-12-01");
  assert.match(ep?.plot ?? "", /Jonas returns to school/);
});

test("readNfoFile: returns null for a missing file instead of throwing", () => {
  assert.equal(readNfoFile("/nonexistent/path/movie.nfo"), null);
});

test("readNfoFile: reads a real fixture back verbatim", () => {
  const content = readNfoFile(path.join(__dirname, "fixtures", "movie.nfo"));
  assert.ok(content?.includes("<title>Inception</title>"));
});
