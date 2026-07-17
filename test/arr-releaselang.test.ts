// Language-ranking for the per-request "Demander en français / VO" picker
// (src/server/arr/releaseLang.ts). Fixtures mirror the real Captain America
// interactive-search shape, incl. Radarr's mislabelled `languages` on MULTi rips.

import { test } from "node:test";
import assert from "node:assert/strict";
import { languageScore, pickReleaseForLanguage, pickRelease, qualityTierOf } from "../src/server/arr/releaseLang";
import type { RadarrRelease } from "../src/server/arr/client";

function rel(partial: Partial<RadarrRelease> & { title: string }): RadarrRelease {
  return {
    guid: partial.title,
    indexerId: 3,
    seeders: 10,
    size: 10_000_000_000,
    // Radarr routinely tags MULTi/French rips as English — the whole reason the
    // ranking leans on the title, so the default fixture mirrors that.
    languages: [{ name: "English" }],
    quality: { quality: { name: "Bluray-2160p", resolution: 2160 } },
    ...partial,
  };
}

test("languageScore: French title markers score strong for fr", () => {
  assert.equal(languageScore(rel({ title: "Captain.America.2011.Multi.2160p.x265-DDR" }), "fr"), 2);
  assert.equal(languageScore(rel({ title: "Captain.America.2011.TRUEFRENCH.1080p" }), "fr"), 2);
  assert.equal(languageScore(rel({ title: "Captain.America.2011.VFF.1080p.WEB" }), "fr"), 2);
  assert.equal(languageScore(rel({ title: "Captain.America.2011.1080p.BluRay.x264-AMIABLE" }), "fr"), 0);
});

test("pickReleaseForLanguage: fr prefers a MULTi/French release over higher-res VO", () => {
  const releases = [
    rel({ title: "Captain.America.2011.UHD.2160p.TrueHD.Atmos.REMUX-FraMeSToR", quality: { quality: { name: "Remux-2160p", resolution: 2160 } }, size: 54e9 }),
    rel({ title: "Captain.America.2011.Multi.2160p.BluRay.x265.Atmos-DDR", quality: { quality: { name: "Bluray-2160p", resolution: 2160 } }, size: 20e9 }),
  ];
  const pick = pickReleaseForLanguage(releases, "fr");
  assert.equal(pick.matched, true);
  assert.ok(pick.release);
  assert.match(pick.release.title, /Multi.*DDR/);
});

test("pickReleaseForLanguage: fr with no French release reports no match", () => {
  const releases = [
    rel({ title: "Captain.America.2011.1080p.BluRay.x264-SPARKS" }),
    rel({ title: "Captain.America.2011.2160p.BluRay.x265-TERMINAL" }),
  ];
  const pick = pickReleaseForLanguage(releases, "fr");
  assert.equal(pick.matched, false); // caller falls back to a normal search
});

test("pickReleaseForLanguage: vo skips rejected and Cyrillic-packaged releases", () => {
  const releases = [
    rel({ title: "Первый мститель / Captain America 2011 UHD BDRemux", quality: { quality: { name: "Remux-2160p", resolution: 2160 } }, size: 68e9, seeders: 77 }),
    rel({ title: "Captain.America.2011.2160p.HDR.DV.REMUX ESub", rejected: true, quality: { quality: { name: "Remux-2160p", resolution: 2160 } }, size: 57e9 }),
    rel({ title: "Captain.America.2011.UHD.2160p.TrueHD.Atmos.REMUX-FraMeSToR", quality: { quality: { name: "Remux-2160p", resolution: 2160 } }, size: 54e9, seeders: 19 }),
  ];
  const pick = pickReleaseForLanguage(releases, "vo");
  assert.equal(pick.matched, true);
  assert.ok(pick.release);
  assert.match(pick.release.title, /FraMeSToR/); // not the Russian one, not the rejected one
});

test("pickReleaseForLanguage: empty / all-rejected input yields no release", () => {
  assert.equal(pickReleaseForLanguage([], "fr").release, null);
  assert.equal(pickReleaseForLanguage([rel({ title: "x", rejected: true })], "vo").release, null);
});

test("qualityTierOf: maps resolutions to tiers", () => {
  assert.equal(qualityTierOf(2160), "2160p");
  assert.equal(qualityTierOf(1080), "1080p");
  assert.equal(qualityTierOf(720), "720p");
  assert.equal(qualityTierOf(480), "sd");
  assert.equal(qualityTierOf(0), "sd");
});

test("pickRelease: quality tier is a hard filter — picks 1080p over higher-res 4K", () => {
  const releases = [
    rel({ title: "Movie.2011.2160p.BluRay.x265", quality: { quality: { name: "Bluray-2160p", resolution: 2160 } }, seeders: 50 }),
    rel({ title: "Movie.2011.1080p.BluRay.x264", quality: { quality: { name: "Bluray-1080p", resolution: 1080 } }, seeders: 8 }),
    rel({ title: "Movie.2011.720p.BluRay.x264", quality: { quality: { name: "Bluray-720p", resolution: 720 } }, seeders: 99 }),
  ];
  const pick = pickRelease(releases, { language: "any", quality: "1080p" });
  assert.ok(pick.release);
  assert.match(pick.release.title, /1080p/);
  assert.equal(pick.matched, true);
});

test("pickRelease: language + quality together — best 1080p French", () => {
  const releases = [
    rel({ title: "Movie.2011.Multi.2160p.BluRay.x265-DDR", quality: { quality: { name: "Bluray-2160p", resolution: 2160 } } }),
    rel({ title: "Movie.2011.1080p.BluRay.x264-VO", quality: { quality: { name: "Bluray-1080p", resolution: 1080 } }, seeders: 40 }),
    rel({ title: "Movie.2011.MULTi.1080p.BluRay.x264-FR", quality: { quality: { name: "Bluray-1080p", resolution: 1080 } }, seeders: 5 }),
  ];
  const pick = pickRelease(releases, { language: "fr", quality: "1080p" });
  assert.ok(pick.release);
  assert.match(pick.release.title, /MULTi\.1080p/); // FR + 1080p, not the 4K FR nor the 1080p VO
  assert.equal(pick.matched, true);
});

test("pickRelease: no release at the requested tier → null (caller fails)", () => {
  const releases = [rel({ title: "Movie.2011.1080p.BluRay.x264", quality: { quality: { name: "Bluray-1080p", resolution: 1080 } } })];
  const pick = pickRelease(releases, { language: "any", quality: "2160p" });
  assert.equal(pick.release, null);
  assert.equal(pick.matched, false);
});
