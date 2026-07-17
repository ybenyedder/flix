// Pure Home-row building blocks: sorting, genre aggregation, "related items",
// plus the Browse toolbar (filters/sort) and the "Surprends-moi" weighted pick.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sortByAddedDesc,
  topGenres,
  itemsByGenre,
  buildGenreRows,
  relatedItems,
  decadeOf,
  availableDecades,
  buildSeenKeys,
  hasActiveBrowseFilters,
  applyBrowseFilters,
  sortBrowseItems,
  pickSurprise,
  EMPTY_BROWSE_FILTERS,
  type BrowseFilters,
} from "../src/lib/flix/rows";
import type { Movie, Show } from "../src/lib/flix/types";

function fakeMovie(overrides: Partial<Movie> & Pick<Movie, "id">): Movie {
  return {
    type: "movie",
    title: `Movie ${overrides.id}`,
    sortTitle: `movie ${overrides.id}`,
    originalTitle: null,
    year: 2020,
    duration: 5400,
    synopsis: null,
    tagline: null,
    genres: [],
    actors: [],
    directors: [],
    studio: null,
    contentRating: null,
    posterHash: null,
    backdropHash: null,
    thumbHash: null,
    logoHash: null,
    addedAt: 0,
    quality: { height: null, hdr: false },
    ...overrides,
  };
}

test("sortByAddedDesc orders newest first without mutating the input", () => {
  const items = [fakeMovie({ id: 1, addedAt: 1 }), fakeMovie({ id: 2, addedAt: 3 }), fakeMovie({ id: 3, addedAt: 2 })];
  const sorted = sortByAddedDesc(items);
  assert.deepEqual(sorted.map((i) => i.addedAt), [3, 2, 1]);
  assert.deepEqual(items.map((i) => i.addedAt), [1, 3, 2]);
});

test("topGenres ranks by frequency, ties keep encounter order", () => {
  const items = [{ genres: ["Action", "Drame"] }, { genres: ["Action"] }, { genres: ["Comédie"] }];
  assert.deepEqual(topGenres(items, 2), ["Action", "Drame"]);
});

test("itemsByGenre filters items containing the genre", () => {
  const items = [fakeMovie({ id: 1, genres: ["Action"] }), fakeMovie({ id: 2, genres: ["Drame"] })];
  assert.deepEqual(itemsByGenre(items, "Action").map((i) => i.id), [1]);
});

test("buildGenreRows picks the most common genres, each row newest-first and capped", () => {
  const items = [
    fakeMovie({ id: 1, genres: ["Action"], addedAt: 1 }),
    fakeMovie({ id: 2, genres: ["Action"], addedAt: 3 }),
    fakeMovie({ id: 3, genres: ["Drame"], addedAt: 2 }),
  ];
  const rows = buildGenreRows(items, 2, 1);
  assert.equal(rows[0].genre, "Action");
  assert.equal(rows[0].items.length, 1);
  assert.equal(rows[0].items[0].id, 2);
});

test("relatedItems ranks by shared genre count and excludes the target and unrelated items", () => {
  const target = fakeMovie({ id: 1, genres: ["Action", "Sci-Fi"] });
  const items = [
    target,
    fakeMovie({ id: 2, genres: ["Action", "Sci-Fi"], addedAt: 1 }),
    fakeMovie({ id: 3, genres: ["Action"], addedAt: 2 }),
    fakeMovie({ id: 4, genres: ["Comédie"] }),
  ];
  const related = relatedItems(target, items);
  assert.deepEqual(related.map((i) => i.id), [2, 3]);
});

test("relatedItems returns nothing for a target with no genres", () => {
  const target = fakeMovie({ id: 1, genres: [] });
  assert.deepEqual(relatedItems(target, [fakeMovie({ id: 2 })]), []);
});

// --- Browse toolbar: filters -----------------------------------------------

function fakeShow(overrides: Partial<Show> & Pick<Show, "id">): Show {
  return {
    type: "show",
    title: `Show ${overrides.id}`,
    sortTitle: `show ${overrides.id}`,
    year: 2020,
    synopsis: null,
    genres: [],
    actors: [],
    studio: null,
    contentRating: null,
    status: null,
    posterHash: null,
    backdropHash: null,
    logoHash: null,
    seasonCount: 1,
    episodeCount: 8,
    addedAt: 0,
    quality: { height: null, hdr: false },
    ...overrides,
  };
}

function filters(overrides: Partial<BrowseFilters>): BrowseFilters {
  return { ...EMPTY_BROWSE_FILTERS, ...overrides };
}

test("applyBrowseFilters with empty filters keeps everything and does not mutate", () => {
  const items = [fakeMovie({ id: 1 }), fakeShow({ id: 2 })];
  const out = applyBrowseFilters(items, EMPTY_BROWSE_FILTERS);
  assert.deepEqual(out.map((i) => i.id), [1, 2]);
  assert.notEqual(out, items);
});

test("applyBrowseFilters multi-genre requires ALL selected genres", () => {
  const items = [
    fakeMovie({ id: 1, genres: ["Action", "Comédie"] }),
    fakeMovie({ id: 2, genres: ["Action"] }),
    fakeMovie({ id: 3, genres: ["Comédie"] }),
  ];
  assert.deepEqual(applyBrowseFilters(items, filters({ genres: ["Action", "Comédie"] })).map((i) => i.id), [1]);
});

test("applyBrowseFilters decade keeps the whole decade and drops missing years", () => {
  const items = [
    fakeMovie({ id: 1, year: 1990 }),
    fakeMovie({ id: 2, year: 1999 }),
    fakeMovie({ id: 3, year: 2000 }),
    fakeMovie({ id: 4, year: null }),
  ];
  assert.deepEqual(applyBrowseFilters(items, filters({ decade: 1990 })).map((i) => i.id), [1, 2]);
});

test("applyBrowseFilters 4K uses the same threshold as the card badge (>=1800)", () => {
  const items = [
    fakeMovie({ id: 1, quality: { height: 2160, hdr: false } }),
    fakeMovie({ id: 2, quality: { height: 1800, hdr: false } }),
    fakeMovie({ id: 3, quality: { height: 1080, hdr: false } }),
    fakeMovie({ id: 4, quality: { height: null, hdr: false } }),
  ];
  assert.deepEqual(applyBrowseFilters(items, filters({ fourK: true })).map((i) => i.id), [1, 2]);
});

test("applyBrowseFilters hdr keeps only HDR titles", () => {
  const items = [fakeMovie({ id: 1, quality: { height: 2160, hdr: true } }), fakeMovie({ id: 2, quality: { height: 2160, hdr: false } })];
  assert.deepEqual(applyBrowseFilters(items, filters({ hdr: true })).map((i) => i.id), [1]);
});

test("applyBrowseFilters unseenOnly drops titles present in the seen set", () => {
  const items = [fakeMovie({ id: 1 }), fakeMovie({ id: 2 }), fakeShow({ id: 2 })];
  const seen = new Set(["movie:1", "show:2"]);
  const out = applyBrowseFilters(items, filters({ unseenOnly: true }), seen);
  assert.deepEqual(out.map((i) => `${i.type}:${i.id}`), ["movie:2"]);
});

test("applyBrowseFilters combines all criteria with AND", () => {
  const items = [
    fakeMovie({ id: 1, genres: ["Action"], year: 1994, quality: { height: 2160, hdr: true } }),
    fakeMovie({ id: 2, genres: ["Action"], year: 1994, quality: { height: 1080, hdr: true } }), // pas 4K
    fakeMovie({ id: 3, genres: ["Action"], year: 2004, quality: { height: 2160, hdr: true } }), // mauvaise décennie
    fakeMovie({ id: 4, genres: ["Drame"], year: 1994, quality: { height: 2160, hdr: true } }), // mauvais genre
    fakeMovie({ id: 5, genres: ["Action"], year: 1994, quality: { height: 2160, hdr: true } }), // vu
  ];
  const out = applyBrowseFilters(items, filters({ genres: ["Action"], decade: 1990, fourK: true, hdr: true, unseenOnly: true }), new Set(["movie:5"]));
  assert.deepEqual(out.map((i) => i.id), [1]);
});

test("hasActiveBrowseFilters is false for the empty filters, true for each criterion", () => {
  assert.equal(hasActiveBrowseFilters(EMPTY_BROWSE_FILTERS), false);
  assert.equal(hasActiveBrowseFilters(filters({ genres: ["Action"] })), true);
  assert.equal(hasActiveBrowseFilters(filters({ decade: 1990 })), true);
  assert.equal(hasActiveBrowseFilters(filters({ unseenOnly: true })), true);
  assert.equal(hasActiveBrowseFilters(filters({ fourK: true })), true);
  assert.equal(hasActiveBrowseFilters(filters({ hdr: true })), true);
});

test("buildSeenKeys keeps only watched entries, keyed by top-level title", () => {
  const seen = buildSeenKeys([
    { topType: "movie", topId: 1, watched: true },
    { topType: "show", topId: 2, watched: true },
    { topType: "movie", topId: 3, watched: false }, // en cours -> toujours « non vu »
  ]);
  assert.deepEqual([...seen].sort(), ["movie:1", "show:2"]);
});

test("decadeOf and availableDecades: dedup, newest first, missing years skipped", () => {
  assert.equal(decadeOf(1994), 1990);
  assert.equal(decadeOf(2000), 2000);
  const items = [{ year: 1994 }, { year: 1999 }, { year: 2023 }, { year: null }, { year: 2005 }];
  assert.deepEqual(availableDecades(items), [2020, 2000, 1990]);
});

// --- Browse toolbar: sorting ------------------------------------------------

test("sortBrowseItems recent orders newest-added first without mutating", () => {
  const items = [fakeMovie({ id: 1, addedAt: 1 }), fakeMovie({ id: 2, addedAt: 3 }), fakeMovie({ id: 3, addedAt: 2 })];
  assert.deepEqual(sortBrowseItems(items, "recent").map((i) => i.id), [2, 3, 1]);
  assert.deepEqual(items.map((i) => i.id), [1, 2, 3]);
});

test("sortBrowseItems alpha sorts sortTitle with French collation (accents)", () => {
  const items = [fakeMovie({ id: 1, sortTitle: "zèbre" }), fakeMovie({ id: 2, sortTitle: "éclair" }), fakeMovie({ id: 3, sortTitle: "avion" })];
  // Un tri par points de code mettrait « éclair » après « zèbre ».
  assert.deepEqual(sortBrowseItems(items, "alpha").map((i) => i.sortTitle), ["avion", "éclair", "zèbre"]);
});

test("sortBrowseItems year is newest first, missing years last, ties stable", () => {
  const items = [
    fakeMovie({ id: 1, year: null }),
    fakeMovie({ id: 2, year: 1999 }),
    fakeMovie({ id: 3, year: 2020 }),
    fakeMovie({ id: 4, year: 1999 }),
  ];
  assert.deepEqual(sortBrowseItems(items, "year").map((i) => i.id), [3, 2, 4, 1]);
});

test("sortBrowseItems duration is shortest first; unknown (0) and shows last, stable", () => {
  const items = [
    fakeShow({ id: 10 }), // pas de durée -> à la fin
    fakeMovie({ id: 1, duration: 7200 }),
    fakeMovie({ id: 2, duration: 0 }), // durée inconnue -> à la fin
    fakeMovie({ id: 3, duration: 5400 }),
    fakeMovie({ id: 4, duration: 7200 }),
  ];
  assert.deepEqual(sortBrowseItems(items, "duration").map((i) => i.id), [3, 1, 4, 10, 2]);
});

// --- "Surprends-moi" ---------------------------------------------------------

const refOf = (item: Movie | Show) => ({ type: item.type, id: item.id });

test("pickSurprise weights early ranks more (1/(rank+1)) with an injected random", () => {
  const a = fakeMovie({ id: 1 });
  const b = fakeMovie({ id: 2 });
  const rows = [{ items: [refOf(a), refOf(b)] }]; // poids : a=1, b=0.5
  assert.equal(pickSurprise(rows, [a, b], new Set(), () => 0)?.id, 1);
  // 0.9 * 1.5 = 1.35 > 1 -> tombe sur b.
  assert.equal(pickSurprise(rows, [a, b], new Set(), () => 0.9)?.id, 2);
});

test("pickSurprise accumulates weight for a title surfaced by several rows", () => {
  const a = fakeMovie({ id: 1 });
  const b = fakeMovie({ id: 2 });
  // a : 1 + 0.5 = 1.5 ; b : 0.5 + 1 = 1.5 — total 3, 0.6*3=1.8 > 1.5 -> b.
  const rows = [{ items: [refOf(a), refOf(b)] }, { items: [refOf(b), refOf(a)] }];
  assert.equal(pickSurprise(rows, [a, b], new Set(), () => 0.6)?.id, 2);
});

test("pickSurprise skips seen titles and refs missing from the catalogue", () => {
  const a = fakeMovie({ id: 1 });
  const b = fakeShow({ id: 2 });
  const rows = [{ items: [refOf(a), refOf(b), { type: "movie" as const, id: 99 }] }];
  // a est vu, 99 n'existe pas (profil enfant) -> même random()=0 donne b.
  const pick = pickSurprise(rows, [a, b], new Set(["movie:1"]), () => 0);
  assert.equal(pick?.type, "show");
  assert.equal(pick?.id, 2);
});

test("pickSurprise falls back to an unseen catalogue title when reco rows are empty", () => {
  const a = fakeMovie({ id: 1 });
  const b = fakeMovie({ id: 2 });
  const c = fakeMovie({ id: 3 });
  // a vu -> tirage uniforme sur [b, c] ; 0.5 * 2 = 1 -> index 1 -> c.
  assert.equal(pickSurprise([], [a, b, c], new Set(["movie:1"]), () => 0.5)?.id, 3);
});

test("pickSurprise still returns a title when everything has been seen", () => {
  const a = fakeMovie({ id: 1 });
  assert.equal(pickSurprise([], [a], new Set(["movie:1"]), () => 0)?.id, 1);
});

test("pickSurprise returns null only for an empty catalogue", () => {
  assert.equal(pickSurprise([{ items: [{ type: "movie", id: 1 }] }], [], new Set(), () => 0), null);
});
