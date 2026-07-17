// Real-availability picker classification (src/server/arr/releaseOptions.ts):
// raw interactive-search results → which languages exist, and per language which
// quality tiers, each with the best release to grab.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReleaseOptions, providesLanguage } from "../src/server/arr/releaseOptions";
import type { RadarrRelease } from "../src/server/arr/client";

function rel(partial: Partial<RadarrRelease> & { title: string; res: number }): RadarrRelease {
  const { res, ...rest } = partial;
  return {
    guid: partial.title,
    indexerId: 3,
    seeders: 10,
    size: 5_000_000_000,
    languages: [{ name: "English" }],
    quality: { quality: { name: `q-${res}`, resolution: res } },
    ...rest,
  };
}

test("providesLanguage: MULTi provides both FR and VO", () => {
  const multi = rel({ title: "Movie.Multi.2160p.x265", res: 2160 });
  assert.equal(providesLanguage(multi, "fr"), true);
  assert.equal(providesLanguage(multi, "vo"), true);
  const vo = rel({ title: "Movie.2160p.BluRay.x264", res: 2160 });
  assert.equal(providesLanguage(vo, "fr"), false);
  assert.equal(providesLanguage(vo, "vo"), true);
});

test("buildReleaseOptions: groups by language then available quality tier", () => {
  const releases = [
    rel({ title: "Movie.Multi.2160p.BluRay.x265-DDR", res: 2160, seeders: 30 }),
    rel({ title: "Movie.1080p.BluRay.x264-VO", res: 1080, seeders: 50 }),
    rel({ title: "Movie.TRUEFRENCH.720p.WEB-FR", res: 720, seeders: 5 }),
    rel({ title: "Movie.2160p.rejected", res: 2160, rejected: true, seeders: 999 }),
  ];
  const langs = buildReleaseOptions(releases);

  const fr = langs.find((l) => l.language === "fr");
  const vo = langs.find((l) => l.language === "vo");
  assert.ok(fr, "French should be available (Multi + TRUEFRENCH)");
  assert.ok(vo, "VO should be available (Multi + VO)");

  // FR tiers: 2160p (Multi) and 720p (TRUEFRENCH), best-first.
  assert.deepEqual(
    fr.qualities.map((q) => q.quality),
    ["2160p", "720p"],
  );
  // VO tiers: 2160p (Multi) and 1080p (VO).
  assert.deepEqual(
    vo.qualities.map((q) => q.quality),
    ["2160p", "1080p"],
  );
  // The rejected 2160p (999 seeders) must not become the "best" of any tier.
  const fr2160 = fr.qualities.find((q) => q.quality === "2160p");
  assert.equal(fr2160?.seeders, 30);
  assert.match(fr2160?.guid ?? "", /DDR/);
});

test("buildReleaseOptions: nothing usable → no languages", () => {
  assert.deepEqual(buildReleaseOptions([]), []);
  assert.deepEqual(buildReleaseOptions([rel({ title: "x", res: 1080, rejected: true })]), []);
});
