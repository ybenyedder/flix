// Pure catalogue helpers (src/server/arr/indexers.ts): preset expansion, the
// selection resolver, and the Cloudflare routing set. No DB / network — this is
// the logic the admin "add indexer packs" endpoint and FLIX_ARR_INDEXERS share.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INDEXER_PRESETS,
  CF_INDEXER_KEYS,
  normIndexerName,
  resolveIndexerSelection,
  selectionWantsEverything,
  filterPublicSchemas,
  classifyAddFailure,
  looksCloudflareBlocked,
} from "../src/server/arr/indexers";

test("normIndexerName: strips case and non-alphanumerics", () => {
  assert.equal(normIndexerName("The Pirate Bay"), "thepiratebay");
  assert.equal(normIndexerName("kickasstorrents-to"), "kickasstorrentsto");
  assert.equal(normIndexerName("EZTV"), "eztv");
  assert.equal(normIndexerName(""), "");
});

test("resolveIndexerSelection: a preset key expands to its definitions", () => {
  assert.deepEqual(resolveIndexerSelection("public"), INDEXER_PRESETS.public.defs);
  assert.deepEqual(resolveIndexerSelection("anime"), INDEXER_PRESETS.anime.defs);
});

test("resolveIndexerSelection: 'all' is every preset, deduped", () => {
  const all = resolveIndexerSelection("all");
  const union = new Set<string>();
  for (const p of Object.values(INDEXER_PRESETS)) for (const d of p.defs) union.add(normIndexerName(d));
  assert.equal(all.length, union.size);
  // No duplicates once normalised.
  assert.equal(new Set(all.map(normIndexerName)).size, all.length);
});

test("resolveIndexerSelection: combines packs and literal names, deduped in order", () => {
  const out = resolveIndexerSelection("public,anime,1337x,yts");
  // 1337x and yts already come from the public pack, so no dupes are appended.
  assert.equal(new Set(out.map(normIndexerName)).size, out.length);
  assert.ok(out.includes("nyaasi")); // from the anime pack
  assert.equal(out[0], "thepiratebay"); // order preserved from the first pack
});

test("resolveIndexerSelection: unknown token passes through as a literal", () => {
  assert.deepEqual(resolveIndexerSelection("someprivatetracker"), ["someprivatetracker"]);
});

test("resolveIndexerSelection: empty / whitespace yields nothing", () => {
  assert.deepEqual(resolveIndexerSelection(""), []);
  assert.deepEqual(resolveIndexerSelection("  ,  , "), []);
});

test("selectionWantsEverything: detects the token anywhere, case-insensitively", () => {
  assert.equal(selectionWantsEverything("everything"), true);
  assert.equal(selectionWantsEverything("fr, Everything "), true);
  assert.equal(selectionWantsEverything("public,anime"), false);
  assert.equal(selectionWantsEverything(""), false);
});

test("resolveIndexerSelection: 'everything' is consumed, not passed as a literal", () => {
  assert.deepEqual(resolveIndexerSelection("everything"), []);
  assert.deepEqual(resolveIndexerSelection("everything,fr"), INDEXER_PRESETS.fr.defs);
});

test("filterPublicSchemas: keeps public definitions that carry a usable name", () => {
  const schemas: { name?: string; definitionName?: string; privacy?: string }[] = [
    { name: "A", privacy: "public" },
    { name: "B", privacy: "private" },
    { name: "C", privacy: "semiPrivate" },
    { definitionName: "d", privacy: "PUBLIC" }, // Prowlarr casing varies
    { privacy: "public" }, // unnamed → unusable, dropped
    { name: "E" }, // no privacy → not provably public, dropped
  ];
  assert.deepEqual(
    filterPublicSchemas(schemas).map((s) => s.name ?? s.definitionName),
    ["A", "d"],
  );
});

test("classifyAddFailure: maps raw errors to short human reasons", () => {
  assert.equal(classifyAddFailure("HTTP 403 Forbidden"), "bloqué par Cloudflare (403)");
  assert.equal(classifyAddFailure("Unauthorized: bad apikey"), "nécessite une clé API / un compte");
  assert.equal(classifyAddFailure("prowlarr n'a pas répondu à temps — réessayez dans quelques secondes"), "site injoignable (délai dépassé)");
  assert.equal(classifyAddFailure("Query unsuccessful"), "Query unsuccessful");
  assert.equal(classifyAddFailure("x".repeat(200)).length, 118); // 117 + « … »
});

test("looksCloudflareBlocked: only CF-ish failures trigger the FlareSolverr retry", () => {
  assert.equal(looksCloudflareBlocked("blocked by CloudFlare challenge"), true);
  assert.equal(looksCloudflareBlocked("403"), true);
  assert.equal(looksCloudflareBlocked("timed out"), false);
  assert.equal(looksCloudflareBlocked("404 not found"), false);
});

test("CF_INDEXER_KEYS holds normalised names actually present in the catalogue", () => {
  const known = new Set<string>();
  for (const p of Object.values(INDEXER_PRESETS)) for (const d of p.defs) known.add(normIndexerName(d));
  for (const cf of CF_INDEXER_KEYS) {
    assert.equal(normIndexerName(cf), cf, `CF key ${cf} must already be normalised`);
    assert.ok(known.has(cf), `CF key ${cf} must correspond to a catalogued indexer`);
  }
});
