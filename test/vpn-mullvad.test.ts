// Pure Mullvad/WireGuard helpers (src/server/vpn/mullvad.ts): key generation &
// round-trip, account-number validation, great-circle distance, and nearest-relay
// ranking. No network / DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateWireguardKeypair,
  publicKeyFromPrivate,
  normalizeAccount,
  isValidAccountFormat,
  haversineKm,
  rankRelays,
  listCountries,
  selectRelay,
} from "../src/server/vpn/mullvad";

const SAMPLE = {
  locations: {
    "ch-zrh": { country: "Switzerland", city: "Zurich", latitude: 47.37, longitude: 8.54 },
    "fr-par": { country: "France", city: "Paris", latitude: 48.85, longitude: 2.35 },
    "nl-ams": { country: "Netherlands", city: "Amsterdam", latitude: 52.37, longitude: 4.9 },
  },
  wireguard: {
    relays: [
      { hostname: "fr-par-wg-001", location: "fr-par", active: true, owned: true, ipv4_addr_in: "1.1.1.1", public_key: "FR" },
      { hostname: "ch-zrh-wg-001", location: "ch-zrh", active: true, owned: true, ipv4_addr_in: "2.2.2.2", public_key: "CH1" },
      { hostname: "ch-zrh-wg-002", location: "ch-zrh", active: true, owned: true, ipv4_addr_in: "3.3.3.3", public_key: "CH2" },
      { hostname: "nl-ams-wg-dead", location: "nl-ams", active: false, owned: true, ipv4_addr_in: "4.4.4.4", public_key: "NL" }, // inactive
    ],
  },
};
const PARIS = { latitude: 48.85, longitude: 2.35 };

test("generateWireguardKeypair: 32-byte base64 keys, public re-derives from private", () => {
  const kp = generateWireguardKeypair();
  assert.equal(Buffer.from(kp.privateKey, "base64").length, 32);
  assert.equal(Buffer.from(kp.publicKey, "base64").length, 32);
  assert.equal(kp.privateKey.length, 44); // 32 bytes → 44 base64 chars
  // The stored private key alone must reproduce the same public key.
  assert.equal(publicKeyFromPrivate(kp.privateKey), kp.publicKey);
});

test("publicKeyFromPrivate: rejects a malformed private key", () => {
  assert.throws(() => publicKeyFromPrivate("not-32-bytes"));
});

test("account number: normalise + strict 16-digit validation", () => {
  assert.equal(normalizeAccount("1234 5678 9012 3456"), "1234567890123456");
  assert.equal(isValidAccountFormat("1234 5678 9012 3456"), true);
  assert.equal(isValidAccountFormat("1234567890123456"), true);
  for (const bad of ["1234", "12345678901234567", "abcd567890123456", "", "1234-5678-9012-3456x"]) {
    assert.equal(isValidAccountFormat(bad), false, `${JSON.stringify(bad)} doit être invalide`);
  }
});

test("haversineKm: known distances within tolerance", () => {
  // Paris → London ≈ 344 km.
  const parisLondon = haversineKm(48.8566, 2.3522, 51.5074, -0.1278);
  assert.ok(Math.abs(parisLondon - 344) < 15, `Paris-London ~344km, got ${parisLondon}`);
  // Same point → 0.
  assert.ok(haversineKm(41.32, 19.81, 41.32, 19.81) < 0.001);
});

test("rankRelays: nearest active relay first, inactive/keyless skipped", () => {
  const data = {
    locations: {
      "al-tia": { country: "Albania", city: "Tirana", latitude: 41.32, longitude: 19.81 },
      "de-fra": { country: "Germany", city: "Frankfurt", latitude: 50.11, longitude: 8.68 },
      "au-syd": { country: "Australia", city: "Sydney", latitude: -33.86, longitude: 151.2 },
    },
    wireguard: {
      relays: [
        { hostname: "au-syd-wg-001", location: "au-syd", active: true, owned: true, ipv4_addr_in: "1.1.1.1", public_key: "AAA" },
        { hostname: "al-tia-wg-001", location: "al-tia", active: true, owned: false, ipv4_addr_in: "2.2.2.2", public_key: "BBB" },
        { hostname: "de-fra-wg-001", location: "de-fra", active: true, owned: true, ipv4_addr_in: "3.3.3.3", public_key: "CCC" },
        { hostname: "de-fra-wg-dead", location: "de-fra", active: false, owned: true, ipv4_addr_in: "4.4.4.4", public_key: "DDD" }, // inactive
        { hostname: "de-fra-wg-nokey", location: "de-fra", active: true, owned: true, ipv4_addr_in: "5.5.5.5", public_key: "" }, // no key
      ],
    },
  };
  // Reference near Tirana → nearest should be the Tirana relay.
  const ranked = rankRelays(data, { latitude: 41.33, longitude: 19.82 });
  assert.equal(ranked[0].hostname, "al-tia-wg-001");
  assert.equal(ranked[0].endpointPort, 51820);
  assert.equal(ranked[0].publicKey, "BBB");
  // Frankfurt is closer to Tirana than Sydney.
  assert.ok(ranked.findIndex((r) => r.city === "Frankfurt") < ranked.findIndex((r) => r.city === "Sydney"));
  // Inactive + keyless relays are dropped.
  assert.equal(ranked.length, 3);
  assert.ok(!ranked.some((r) => r.hostname.includes("dead") || r.hostname.includes("nokey")));
  // Country code is derived from the location prefix.
  assert.equal(ranked.find((r) => r.city === "Frankfurt")?.countryCode, "de");
});

test("listCountries: distinct active countries, sorted by name, inactive excluded", () => {
  const countries = listCountries(SAMPLE);
  // nl-ams is inactive → Netherlands excluded; France + Switzerland remain.
  assert.deepEqual(countries, [
    { code: "fr", name: "France" },
    { code: "ch", name: "Switzerland" },
  ]);
});

test("selectRelay: country preference picks the nearest relay IN that country", () => {
  // From Paris, France is nearest overall, but requesting Switzerland must return a CH relay.
  const picked = selectRelay(SAMPLE, PARIS, "ch");
  assert.ok(picked);
  assert.equal(picked.countryMatched, true);
  assert.equal(picked.relay.countryCode, "ch");
});

test("selectRelay: accepts the full country name too", () => {
  const picked = selectRelay(SAMPLE, PARIS, "Switzerland");
  assert.ok(picked);
  assert.equal(picked.relay.countryCode, "ch");
  assert.equal(picked.countryMatched, true);
});

test("selectRelay: unknown/absent country falls back to nearest overall", () => {
  const picked = selectRelay(SAMPLE, PARIS, "Japan");
  assert.ok(picked);
  assert.equal(picked.countryMatched, false);
  assert.equal(picked.relay.countryCode, "fr"); // nearest to Paris
});

test("selectRelay: no country → nearest overall, countryMatched false", () => {
  const picked = selectRelay(SAMPLE, PARIS, null);
  assert.ok(picked);
  assert.equal(picked.countryMatched, false);
  assert.equal(picked.relay.city, "Paris");
});
