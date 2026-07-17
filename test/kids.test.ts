// Pure content-rating gate tests — no I/O, no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedForKids, filterForProfile } from "../src/lib/flix/kids";

test("isAllowedForKids allows missing/unrecognised ratings (fail-open)", () => {
  assert.equal(isAllowedForKids(null), true);
  assert.equal(isAllowedForKids(undefined), true);
  assert.equal(isAllowedForKids(""), true);
  assert.equal(isAllowedForKids("PG-13"), true);
  assert.equal(isAllowedForKids("TV-14"), true);
  assert.equal(isAllowedForKids("G"), true);
  assert.equal(isAllowedForKids("TV-Y7-FV"), true);
});

test("isAllowedForKids blocks clearly-adult markers, case-insensitively", () => {
  assert.equal(isAllowedForKids("R"), false);
  assert.equal(isAllowedForKids("r"), false);
  assert.equal(isAllowedForKids("nc-17"), false);
  assert.equal(isAllowedForKids("TV-MA"), false);
  assert.equal(isAllowedForKids("18+"), false);
  assert.equal(isAllowedForKids("-18"), false);
  assert.equal(isAllowedForKids("Déconseillé -16 ans"), false);
});

test("filterForProfile is a no-op for non-kids profiles, filters adult ratings for kids", () => {
  const items = [{ contentRating: "PG" }, { contentRating: "R" }, { contentRating: null }];
  assert.equal(filterForProfile(items, false).length, 3);
  assert.deepEqual(
    filterForProfile(items, true).map((i) => i.contentRating),
    ["PG", null],
  );
});
