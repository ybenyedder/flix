// Pure quality-profile fallback transform (src/server/arr/quality.ts): the
// balanced retune the stall watchdog applies. No DB / network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { toBalancedProfile, isBalancedBadQuality, BALANCED_PROFILE_NAME } from "../src/server/arr/quality";
import type { QualityProfileFull } from "../src/server/arr/client";

test("isBalancedBadQuality: Remux/4K/cam disallowed, WEB/Bluray-1080p kept", () => {
  for (const bad of ["Remux-1080p", "Bluray-2160p", "WEBDL-2160p", "CAM", "TELESYNC", "BR-DISK", "Raw-HD"]) {
    assert.equal(isBalancedBadQuality(bad), true, `${bad} should be disallowed`);
  }
  for (const good of ["WEBDL-1080p", "Bluray-1080p", "WEBRip-720p", "HDTV-1080p"]) {
    assert.equal(isBalancedBadQuality(good), false, `${good} should be allowed`);
  }
});

function sample(): QualityProfileFull {
  return {
    id: 1,
    name: "Any",
    cutoff: 999,
    items: [
      { name: "WEB 1080p", id: 100, allowed: false, items: [] },
      { quality: { id: 3, name: "WEBDL-1080p" }, allowed: false },
      { quality: { id: 7, name: "Bluray-1080p" }, allowed: false },
      { quality: { id: 30, name: "Remux-1080p" }, allowed: true },
      { quality: { id: 31, name: "Bluray-2160p" }, allowed: true },
    ],
  };
}

test("toBalancedProfile: disallows Remux/4K, keeps 1080p, pins cutoff + renames", () => {
  const out = toBalancedProfile(sample());
  assert.ok(out);
  const o = out;
  assert.equal(o.name, BALANCED_PROFILE_NAME);
  assert.equal(o.upgradeAllowed, true);
  // Cutoff pinned to the WEB-1080p group id (preferred over Bluray-1080p).
  assert.equal(o.cutoff, 100);
  const byName = (n: string) => o.items.find((i) => i.quality?.name === n);
  assert.equal(byName("Remux-1080p")?.allowed, false);
  assert.equal(byName("Bluray-2160p")?.allowed, false);
  assert.equal(byName("WEBDL-1080p")?.allowed, true);
  assert.equal(byName("Bluray-1080p")?.allowed, true);
});

test("toBalancedProfile: falls back to Bluray-1080p cutoff when no WEB-1080p group", () => {
  const p = sample();
  p.items = p.items.filter((i) => i.name !== "WEB 1080p");
  const out = toBalancedProfile(p);
  assert.ok(out);
  assert.equal(out.cutoff, 7); // Bluray-1080p quality id
});

test("toBalancedProfile: already-balanced profile is a no-op (null)", () => {
  const p = sample();
  p.name = BALANCED_PROFILE_NAME;
  assert.equal(toBalancedProfile(p), null);
});

test("toBalancedProfile: does not mutate the input", () => {
  const p = sample();
  toBalancedProfile(p);
  assert.equal(p.name, "Any");
  assert.equal(
    p.items.find((i) => i.quality?.name === "Remux-1080p")?.allowed,
    true,
  );
});
