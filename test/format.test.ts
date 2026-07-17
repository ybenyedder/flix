import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, isNew, NEW_BADGE_WINDOW_MS } from "../src/lib/flix/format";

test("formatDuration renders hours only once they're non-zero, never negative", () => {
  assert.equal(formatDuration(0), "0 min");
  assert.equal(formatDuration(-5), "0 min");
  assert.equal(formatDuration(59), "1 min");
  assert.equal(formatDuration(2880), "48 min");
  assert.equal(formatDuration(6120), "1 h 42 min");
  assert.equal(formatDuration(3600), "1 h 00 min");
});

test("formatDuration carries a rounded-up remainder into the hour (never « 60 min »)", () => {
  assert.equal(formatDuration(3599), "1 h 00 min"); // 59min59s → a full hour, not « 60 min »
  assert.equal(formatDuration(7199), "2 h 00 min"); // 1h59min59s → 2h, not « 1 h 60 min »
});

test("isNew: strictly under 14 days, unknown addedAt never new, future timestamps tolerated", () => {
  const now = Date.UTC(2026, 6, 3, 12, 0, 0);
  const day = 24 * 3600 * 1000;

  assert.equal(NEW_BADGE_WINDOW_MS, 14 * day);

  assert.equal(isNew(now, now), true); // added right now
  assert.equal(isNew(now - 13 * day, now), true);
  assert.equal(isNew(now - (14 * day - 1), now), true); // 1ms inside the window
  assert.equal(isNew(now - 14 * day, now), false); // exactly 14 days -> no longer new
  assert.equal(isNew(now - 30 * day, now), false);
  assert.equal(isNew(0, now), false); // scanner default for "unknown"
  assert.equal(isNew(now + 60_000, now), true); // slight clock skew stays new
});
