// Pure subtitle-conversion tests — no ffmpeg, no DB. Covers the fiddly bits the
// end-to-end getVttForSubtitle path can't isolate: charset detection (BOM /
// UTF-16 / mojibake→latin1), SRT cue-index stripping, and ASS Format-order
// parsing with comma-bearing text and style-tag stripping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSubtitleBuffer, srtToVtt, assToVtt } from "../src/server/playback/subtitles";

test("decodeSubtitleBuffer: UTF-8 BOM is stripped", () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("café", "utf8")]);
  assert.equal(decodeSubtitleBuffer(buf), "café");
});

test("decodeSubtitleBuffer: UTF-16 LE BOM", () => {
  // Buffer.from(..., "utf16le") emits the BOM (0xff 0xfe) followed by LE text.
  assert.equal(decodeSubtitleBuffer(Buffer.from("﻿Café", "utf16le")), "Café");
});

test("decodeSubtitleBuffer: UTF-16 BE BOM", () => {
  // 0xfe 0xff BOM, then "Hi" as big-endian UTF-16 (00 48, 00 69).
  assert.equal(decodeSubtitleBuffer(Buffer.from([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69])), "Hi");
});

test("decodeSubtitleBuffer: invalid UTF-8 falls back to latin1", () => {
  // 0xe9 is 'é' in CP1252/latin1 but an invalid lone UTF-8 byte → mojibake probe
  // trips → decoded as latin1 instead of yielding a replacement char.
  assert.equal(decodeSubtitleBuffer(Buffer.from([0x48, 0x69, 0xe9])), "Hié");
});

test("decodeSubtitleBuffer: plain UTF-8 passes through untouched", () => {
  assert.equal(decodeSubtitleBuffer(Buffer.from("Bonjour", "utf8")), "Bonjour");
});

test("srtToVtt: drops numeric cue indices and swaps ',' for '.' in timestamps", () => {
  const srt = "1\n00:00:01,000 --> 00:00:04,000\nHello\n\n2\n00:00:05,500 --> 00:00:06,000\nWorld";
  assert.equal(
    srtToVtt(srt),
    "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello\n\n00:00:05.500 --> 00:00:06.000\nWorld\n",
  );
});

test("assToVtt: reads the declared Format order, keeps comma text, strips {tags} and \\N", () => {
  const ass =
    "[Events]\n" +
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
    "Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\i1}Hello{\\i0}, world\\Nsecond line";
  assert.equal(assToVtt(ass), "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello, world\nsecond line\n");
});
