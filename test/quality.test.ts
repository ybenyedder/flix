import { test } from "node:test";
import assert from "node:assert/strict";
import { qualityLabel } from "../src/lib/flix/quality";

test("qualityLabel maps a raw video height to the coarse Card/DetailModal badge", () => {
  assert.equal(qualityLabel(null), null);
  assert.equal(qualityLabel(undefined), null);
  assert.equal(qualityLabel(0), null);
  assert.equal(qualityLabel(480), "SD");
  assert.equal(qualityLabel(720), "HD");
  assert.equal(qualityLabel(1080), "HD");
  assert.equal(qualityLabel(2160), "4K");
});
