// Pure filename-parsing tests — no I/O, no DB — covering real-world movie and
// TV episode naming conventions the scanner has to make sense of.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMovieName, sortTitle } from "../src/server/library/namingMovies";
import { matchEpisodePath, parseShowFolderName, parseSeasonFolder } from "../src/server/library/namingShows";

// --- movies ---------------------------------------------------------------

test("movie: title + year with a folder-style resolution/codec tail", () => {
  const r = parseMovieName("Inception (2010) 1080p x265");
  assert.equal(r.title, "Inception");
  assert.equal(r.year, 2010);
});

test("movie: dotted scene release name", () => {
  const r = parseMovieName("The.Matrix.1999.BluRay.x264-GROUP.mkv");
  assert.equal(r.title, "The Matrix");
  assert.equal(r.year, 1999);
});

test("movie: underscored release name", () => {
  const r = parseMovieName("district_9_2009_bdrip.mkv");
  assert.equal(r.title, "district 9");
  assert.equal(r.year, 2009);
});

test("movie: KOREAN language tag doesn't break year extraction", () => {
  const r = parseMovieName("Parasite.2019.KOREAN.1080p.WEBRip.x264.mkv");
  assert.equal(r.title, "Parasite");
  assert.equal(r.year, 2019);
});

test("movie: bracketed quality/HDR/audio tags", () => {
  const r = parseMovieName("Interstellar (2014) [2160p] [HDR10] [DTS-HD MA].mkv");
  assert.equal(r.title, "Interstellar");
  assert.equal(r.year, 2014);
});

test("movie: multi-word title with a year", () => {
  const r = parseMovieName("Dune.Part.Two.2024.2160p.DoVi.x265-GROUP.mkv");
  assert.equal(r.title, "Dune Part Two");
  assert.equal(r.year, 2024);
});

test("movie: REMUX tag after the year", () => {
  const r = parseMovieName("The Godfather Part II (1974) REMUX.mkv");
  assert.equal(r.title, "The Godfather Part II");
  assert.equal(r.year, 1974);
});

test("movie: Director's Cut edition tag with a year", () => {
  const r = parseMovieName("Vertigo.1958.Directors.Cut.mkv");
  assert.equal(r.title, "Vertigo");
  assert.equal(r.year, 1958);
});

test("movie: no year, no tags at all — whole cleaned name is the title", () => {
  const r = parseMovieName("Amadeus.mkv");
  assert.equal(r.title, "Amadeus");
  assert.equal(r.year, null);
});

test("movie: no year, but a release tag to cut at", () => {
  const r = parseMovieName("Some.Movie.PROPER.REPACK.mkv");
  assert.equal(r.title, "Some Movie");
  assert.equal(r.year, null);
});

test("movie: French accented title with a year", () => {
  const r = parseMovieName("Le Fabuleux Destin d'Amélie Poulain (2001).mkv");
  assert.equal(r.title, "Le Fabuleux Destin d'Amélie Poulain");
  assert.equal(r.year, 2001);
});

test("movie: VOSTFR/TRUEFRENCH tags act as a release-tag cut point", () => {
  const r = parseMovieName("A.Movie.Name.VOSTFR.1080p.mkv");
  assert.equal(r.title, "A Movie Name");
  assert.equal(r.year, null);
});

test("movie: HLG HDR tag recognised", () => {
  const r = parseMovieName("Planet.Earth.2160p.HLG.mkv");
  assert.equal(r.title, "Planet Earth");
});

test("movie: EXTENDED/UNRATED edition tags", () => {
  const r = parseMovieName("Kingdom.of.Heaven.2005.EXTENDED.mkv");
  assert.equal(r.title, "Kingdom of Heaven");
  assert.equal(r.year, 2005);
});

test("movie: a bare year INSIDE the title doesn't truncate it when the real year is parenthesised", () => {
  const r = parseMovieName("Blade Runner 2049 (2017).mkv");
  assert.equal(r.title, "Blade Runner 2049");
  assert.equal(r.year, 2017);
});

test("movie: 'Wonder Woman 1984 (2020)' keeps 1984 in the title", () => {
  const r = parseMovieName("Wonder Woman 1984 (2020).mkv");
  assert.equal(r.title, "Wonder Woman 1984");
  assert.equal(r.year, 2020);
});

test("movie: a title that IS a year — '1917 (2019)'", () => {
  const r = parseMovieName("1917 (2019).mkv");
  assert.equal(r.title, "1917");
  assert.equal(r.year, 2019);
});

test("movie: a title that IS a year — '2012 (2009)'", () => {
  const r = parseMovieName("2012 (2009).mkv");
  assert.equal(r.title, "2012");
  assert.equal(r.year, 2009);
});

test("movie: plain parenthesised year still parses", () => {
  const r = parseMovieName("Inception (2010).mkv");
  assert.equal(r.title, "Inception");
  assert.equal(r.year, 2010);
});

test("movie: non-parenthesised year keeps the historical non-greedy behaviour", () => {
  const r = parseMovieName("Inception 2010");
  assert.equal(r.title, "Inception");
  assert.equal(r.year, 2010);
});

test("movie: dotted name ending exactly at the year keeps the year (no extension to strip)", () => {
  const r = parseMovieName("The.Matrix.1999");
  assert.equal(r.title, "The Matrix");
  assert.equal(r.year, 1999);
});

test("sortTitle: strips a leading English article", () => {
  assert.equal(sortTitle("The Matrix"), "Matrix");
});

test("sortTitle: strips a leading French article", () => {
  assert.equal(sortTitle("Le Fabuleux Destin d'Amélie Poulain"), "Fabuleux Destin d'Amélie Poulain");
});

test("sortTitle: strips an elided L' with no following space", () => {
  assert.equal(sortTitle("L'Auberge Espagnole"), "Auberge Espagnole");
});

test("sortTitle: strips 'Un'/'Une'", () => {
  assert.equal(sortTitle("Un Prophète"), "Prophète");
  assert.equal(sortTitle("Une Femme est une Femme"), "Femme est une Femme");
});

test("sortTitle: leaves a title with no leading article untouched", () => {
  assert.equal(sortTitle("Interstellar"), "Interstellar");
});

test("sortTitle: 'An' is stripped, inner articles are not", () => {
  assert.equal(sortTitle("An American in Paris"), "American in Paris");
});

// --- TV episodes ------------------------------------------------------------

test("episode: SxxEyy inside a Season NN folder", () => {
  const r = matchEpisodePath(["Dark (2017)", "Season 01"], "Dark S01E01.mkv");
  assert.ok(r);
  assert.equal(r?.showFolder, "Dark (2017)");
  assert.equal(r?.season, 1);
  assert.equal(r?.episode, 1);
  assert.equal(r?.episodeEnd, null);
});

test("episode: second episode of the same season", () => {
  const r = matchEpisodePath(["Dark (2017)", "Season 01"], "Dark S01E02.mkv");
  assert.equal(r?.season, 1);
  assert.equal(r?.episode, 2);
});

test("episode: SxxEyy with an embedded episode title", () => {
  const r = matchEpisodePath(["Breaking Bad", "Season 05"], "Breaking.Bad.S05E14.Ozymandias.mkv");
  assert.equal(r?.season, 5);
  assert.equal(r?.episode, 14);
  assert.equal(r?.episodeTitle, "Ozymandias");
});

test("episode: 1x01 style numbering, no season subfolder", () => {
  const r = matchEpisodePath(["The Wire"], "the.wire.1x01.pilot.mkv");
  assert.ok(r);
  assert.equal(r?.showFolder, "The Wire");
  assert.equal(r?.season, 1);
  assert.equal(r?.episode, 1);
  assert.equal(r?.episodeTitle, "pilot");
});

test("episode: multi-episode file S01E01-E02", () => {
  const r = matchEpisodePath(["Friends (1994)", "Season 01"], "Friends S01E01-E02.mkv");
  assert.equal(r?.season, 1);
  assert.equal(r?.episode, 1);
  assert.equal(r?.episodeEnd, 2);
});

test("episode: multi-episode file S01E01-02 (no repeated E)", () => {
  const r = matchEpisodePath(["Friends (1994)", "Season 01"], "Friends S01E01-02.mkv");
  assert.equal(r?.episode, 1);
  assert.equal(r?.episodeEnd, 2);
});

test("episode: season-folder fallback, bare leading episode number", () => {
  const r = matchEpisodePath(["Chernobyl", "Season 01"], "01 - Vichnaya Pamyat.mkv");
  assert.ok(r);
  assert.equal(r?.showFolder, "Chernobyl");
  assert.equal(r?.season, 1);
  assert.equal(r?.episode, 1);
  assert.equal(r?.episodeTitle, "Vichnaya Pamyat");
});

test("episode: Specials folder maps to season 0", () => {
  const r = matchEpisodePath(["My Show", "Specials"], "01 - Behind the Scenes.mkv");
  assert.ok(r);
  assert.equal(r?.showFolder, "My Show");
  assert.equal(r?.season, 0);
  assert.equal(r?.episode, 1);
  assert.equal(r?.episodeTitle, "Behind the Scenes");
});

test("episode: 'Season 0' folder also maps to season 0", () => {
  const r = parseSeasonFolder("Season 0");
  assert.equal(r?.season, 0);
});

test("episode: case-insensitive SxxEyy", () => {
  const r = matchEpisodePath(["Dark (2017)", "Season 01"], "dark.s01e03.mkv");
  assert.equal(r?.season, 1);
  assert.equal(r?.episode, 3);
});

test("episode: French 'Saison' folder name", () => {
  const r = parseSeasonFolder("Saison 2");
  assert.equal(r?.season, 2);
});

test("not an episode: a resolution-like NxNN string is not mistaken for season/episode", () => {
  const r = matchEpisodePath(["Random Movie (2020)"], "Random Movie (2020) 1920x1080.mkv");
  assert.equal(r, null);
});

test("not an episode: a movie with no season pattern at all", () => {
  const r = matchEpisodePath([], "Amadeus (1984).mkv");
  assert.equal(r, null);
});

test("episode: loose root-level episodes of the same show group under ONE derived show folder", () => {
  const e1 = matchEpisodePath([], "Dark.S01E01.mkv");
  const e2 = matchEpisodePath([], "Dark.S01E02.mkv");
  assert.ok(e1);
  assert.ok(e2);
  assert.equal(e1?.showFolder, "Dark"); // cut at the SxxEyy tag, not the whole filename
  assert.equal(e1?.showFolder, e2?.showFolder);
  assert.equal(e1?.season, 1);
  assert.equal(e2?.episode, 2);
});

test("episode: loose root-level 1x01-style episode also derives the show name from the tag cut", () => {
  const r = matchEpisodePath([], "the.wire.1x01.pilot.mkv");
  assert.equal(r?.showFolder, "the wire");
  assert.equal(r?.season, 1);
  assert.equal(r?.episode, 1);
});

test("episode: a loose file whose name STARTS with the tag keeps a per-file folder", () => {
  const r = matchEpisodePath([], "S01E01.mkv");
  assert.equal(r?.showFolder, "S01E01");
});

test("show folder name: title + year", () => {
  const r = parseShowFolderName("Dark (2017)");
  assert.equal(r.title, "Dark");
  assert.equal(r.year, 2017);
});

test("show folder name: title only, no year", () => {
  const r = parseShowFolderName("Stranger Things");
  assert.equal(r.title, "Stranger Things");
  assert.equal(r.year, null);
});

test("show folder name: dotted name ending at the year keeps the year", () => {
  const r = parseShowFolderName("Dark.2017");
  assert.equal(r.title, "Dark");
  assert.equal(r.year, 2017);
});

test("parseSeasonFolder: plain 'S01' short form", () => {
  assert.equal(parseSeasonFolder("S01")?.season, 1);
});

test("parseSeasonFolder: not a season folder at all", () => {
  assert.equal(parseSeasonFolder("Extras"), null);
});
