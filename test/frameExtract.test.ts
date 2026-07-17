// Pure-logic tests for frame extraction: the HDR tonemap filter-chain builder
// and the anti-black-frame scoring/selection — none of this spawns ffmpeg.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrameFilter, isBlackFrame, frameScore, pickBestFrame, type FrameStats } from "../src/server/library/frameExtract";

// --- buildFrameFilter --------------------------------------------------------

test("buildFrameFilter: SDR source never gets a tonemap chain", () => {
  const vf = buildFrameFilter({ width: 1280, hdrFormat: "SDR", zscaleAvailable: true, multiFrame: true });
  assert.equal(vf, "thumbnail=24,scale=1280:-2");
});

test("buildFrameFilter: null hdrFormat (unknown/no video stream) never gets a tonemap chain", () => {
  const vf = buildFrameFilter({ width: 640, hdrFormat: null, zscaleAvailable: true });
  assert.equal(vf, "scale=640:-2");
});

test("buildFrameFilter: HDR10 + zscale available inserts the tonemap chain before scale", () => {
  const vf = buildFrameFilter({ width: 1280, hdrFormat: "HDR10", zscaleAvailable: true, multiFrame: true });
  assert.equal(vf, "zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709,format=yuv420p,thumbnail=24,scale=1280:-2");
});

test("buildFrameFilter: HDR source but no local zscale support degrades to a plain scale", () => {
  const vf = buildFrameFilter({ width: 1280, hdrFormat: "HDR10", zscaleAvailable: false, multiFrame: true });
  assert.equal(vf, "thumbnail=24,scale=1280:-2");
});

test("buildFrameFilter: HLG and DV sources also trigger the tonemap chain", () => {
  assert.match(buildFrameFilter({ width: 640, hdrFormat: "HLG", zscaleAvailable: true }), /^zscale=t=linear/);
  assert.match(buildFrameFilter({ width: 640, hdrFormat: "DV", zscaleAvailable: true }), /^zscale=t=linear/);
});

test("buildFrameFilter: multiFrame omitted skips the thumbnail=24 best-of-N pick", () => {
  const vf = buildFrameFilter({ width: 640, hdrFormat: "SDR", zscaleAvailable: true });
  assert.equal(vf, "scale=640:-2");
});

// --- poster 2:3 centre-crop --------------------------------------------------

const POSTER_CROP = "crop=min(iw\\,ih*2/3):min(ih\\,iw*3/2)"; // 2:3, orientation-safe (see buildFrameFilter)

test("buildFrameFilter: poster inserts a 2:3 centre-crop between thumbnail pick and scale", () => {
  const vf = buildFrameFilter({ width: 720, hdrFormat: "SDR", zscaleAvailable: true, multiFrame: true, poster: true });
  assert.equal(vf, `thumbnail=24,${POSTER_CROP},scale=720:-2`);
});

test("buildFrameFilter: poster without multiFrame crops then scales", () => {
  const vf = buildFrameFilter({ width: 720, hdrFormat: null, zscaleAvailable: true, poster: true });
  assert.equal(vf, `${POSTER_CROP},scale=720:-2`);
});

test("buildFrameFilter: poster on an HDR source keeps the tonemap chain, crop stays just before scale", () => {
  const vf = buildFrameFilter({ width: 720, hdrFormat: "HDR10", zscaleAvailable: true, multiFrame: true, poster: true });
  assert.equal(vf, `zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709,format=yuv420p,thumbnail=24,${POSTER_CROP},scale=720:-2`);
});

test("buildFrameFilter: poster omitted never adds a crop (landscape backdrop stays full-width)", () => {
  const vf = buildFrameFilter({ width: 1280, hdrFormat: "SDR", zscaleAvailable: true, multiFrame: true });
  assert.ok(!vf.includes("crop"), `expected no crop in "${vf}"`);
});

// --- isBlackFrame / frameScore -----------------------------------------------

test("isBlackFrame: low mean luminance is black regardless of stdev", () => {
  assert.equal(isBlackFrame({ mean: 5, stdev: 40, entropy: 6 }), true);
});

test("isBlackFrame: low stdev (near-uniform frame) is black regardless of mean", () => {
  assert.equal(isBlackFrame({ mean: 120, stdev: 3, entropy: 6 }), true);
});

test("isBlackFrame: a normal, textured frame is not black", () => {
  assert.equal(isBlackFrame({ mean: 90, stdev: 45, entropy: 7 }), false);
});

test("frameScore: entropy times mean luminance", () => {
  assert.equal(frameScore({ mean: 100, stdev: 40, entropy: 5 }), 500);
});

// --- pickBestFrame ------------------------------------------------------------

test("pickBestFrame: empty candidate list returns null", () => {
  assert.equal(pickBestFrame<string>([]), null);
});

test("pickBestFrame: prefers a non-black candidate even if a black one scores higher raw", () => {
  const black: FrameStats = { mean: 10, stdev: 50, entropy: 8 }; // isBlack (mean<18), raw score 80
  const good: FrameStats = { mean: 100, stdev: 50, entropy: 0.5 }; // not black, raw score 50
  const winner = pickBestFrame([
    { item: "black", stats: black },
    { item: "good", stats: good },
  ]);
  assert.equal(winner, "good");
});

test("pickBestFrame: picks the highest-scoring among several accepted candidates", () => {
  const winner = pickBestFrame([
    { item: "low", stats: { mean: 80, stdev: 40, entropy: 3 } },
    { item: "high", stats: { mean: 120, stdev: 50, entropy: 6 } },
  ]);
  assert.equal(winner, "high");
});

test("pickBestFrame: every candidate black — falls back to the least-bad instead of failing", () => {
  const winner = pickBestFrame([
    { item: "black-a", stats: { mean: 5, stdev: 3, entropy: 1 } },
    { item: "black-b", stats: { mean: 12, stdev: 4, entropy: 2 } },
  ]);
  assert.equal(winner, "black-b");
});
