// Mullvad WireGuard helpers for the opt-in VPN feature. Given only an account
// number, this generates a WireGuard keypair, registers the public key with
// Mullvad (which returns the tunnel address), fetches the relay list, and picks
// the geographically nearest relay (a good proxy for lowest latency without
// needing ICMP, which a non-root container can't do). No secrets are logged.
//
// Server-only. These are the ONLY outbound calls this module makes, all to
// Mullvad's own API, and only while the VPN feature is being configured.

import crypto from "crypto";
import { createLogger } from "../logger";

const log = createLogger("vpn");

const RELAYS_URL = "https://api.mullvad.net/app/v1/relays";
const REGISTER_URL = "https://api.mullvad.net/wg";
const LOCATION_URL = "https://am.i.mullvad.net/json";
const WG_ENDPOINT_PORT = 51820;

// --- WireGuard keys ----------------------------------------------------------

// X25519 raw keys are the last 32 bytes of the DER encodings (fixed-length
// prefixes: 16 bytes for PKCS8 private, 12 for SPKI public). base64 of those 32
// bytes is exactly the WireGuard key format. Verified round-trip: re-deriving
// the public key from the extracted private matches.
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export interface WireguardKeypair {
  privateKey: string; // base64, WireGuard format
  publicKey: string; // base64, WireGuard format
}

export function generateWireguardKeypair(): WireguardKeypair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  return {
    privateKey: privDer.subarray(privDer.length - 32).toString("base64"),
    publicKey: pubDer.subarray(pubDer.length - 32).toString("base64"),
  };
}

/** Re-derive the WireGuard public key from a raw base64 private key (used to
 *  reuse a stored key without persisting the public half). */
export function publicKeyFromPrivate(privateKeyB64: string): string {
  const raw = Buffer.from(privateKeyB64, "base64");
  if (raw.length !== 32) throw new Error("clé privée WireGuard invalide");
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, raw]), format: "der", type: "pkcs8" });
  const pubDer = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
  return pubDer.subarray(pubDer.length - 32).toString("base64");
}

// --- Mullvad account / key registration --------------------------------------

/** Mullvad account numbers are 16 digits (often shown space-grouped). */
export function normalizeAccount(raw: string): string {
  return raw.replace(/\s+/g, "");
}

export function isValidAccountFormat(account: string): boolean {
  return /^\d{16}$/.test(normalizeAccount(account));
}

/** Register a WireGuard public key against an account. Returns the assigned
 *  tunnel address(es) (e.g. "10.64.1.2/32,fc00:.../128"). Also serves as account
 *  validation: an invalid/expired account is rejected by the API. */
export async function registerKey(account: string, publicKey: string): Promise<string> {
  const body = new URLSearchParams({ account: normalizeAccount(account), pubkey: publicKey });
  let res: Response;
  try {
    res = await fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Mullvad injoignable (réseau)");
  }
  const text = (await res.text()).trim();
  if (!res.ok) {
    if (res.status === 400 || res.status === 404) throw new Error("Numéro de compte Mullvad invalide ou expiré");
    throw new Error(`Mullvad a répondu ${res.status}`);
  }
  // Success body is the address list. Keep only the IPv4 /32 for gluetun (IPv6
  // optional and often unwanted on a home LAN).
  const addresses = text.split(",").map((s) => s.trim()).filter(Boolean);
  const ipv4 = addresses.find((a) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(a));
  if (!ipv4) throw new Error("Adresse de tunnel Mullvad introuvable dans la réponse");
  return ipv4;
}

// --- relay list + nearest selection ------------------------------------------

interface MullvadLocation {
  country: string;
  city: string;
  latitude: number;
  longitude: number;
}
interface MullvadRelay {
  hostname: string;
  location: string; // location code, e.g. "al-tia"
  active: boolean;
  owned: boolean;
  ipv4_addr_in: string;
  public_key: string;
}

export interface Relay {
  hostname: string;
  city: string;
  country: string;
  /** ISO-ish Mullvad country code (the part before the dash in the location
   *  code, e.g. "ch" for "ch-zrh"). Used to select relays by country. */
  countryCode: string;
  endpointIp: string;
  publicKey: string;
  endpointPort: number;
  distanceKm: number;
}

export interface Country {
  code: string;
  name: string;
}

interface RelaysResponse {
  locations: Record<string, MullvadLocation>;
  wireguard: { relays: MullvadRelay[] };
}

async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} a répondu ${res.status}`);
  return (await res.json()) as T;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Rank active WireGuard relays by distance from a reference point. Pure — the
 *  network fetch is done by the caller so this is unit-testable. */
export function rankRelays(data: RelaysResponse, ref: { latitude: number; longitude: number }): Relay[] {
  const out: Relay[] = [];
  for (const r of data.wireguard.relays) {
    if (!r.active || !r.public_key || !r.ipv4_addr_in) continue;
    const loc = data.locations[r.location];
    if (!loc) continue;
    out.push({
      hostname: r.hostname,
      city: loc.city,
      country: loc.country,
      countryCode: String(r.location).split("-")[0],
      endpointIp: r.ipv4_addr_in,
      publicKey: r.public_key,
      endpointPort: WG_ENDPOINT_PORT,
      distanceKm: haversineKm(ref.latitude, ref.longitude, loc.latitude, loc.longitude),
    });
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Distinct countries that have at least one active WireGuard relay, sorted by
 *  name — feeds the country picker in the UI. Pure. */
export function listCountries(data: RelaysResponse): Country[] {
  const byCode = new Map<string, string>();
  for (const r of data.wireguard.relays) {
    if (!r.active || !r.public_key || !r.ipv4_addr_in) continue;
    const loc = data.locations[r.location];
    if (!loc) continue;
    const code = String(r.location).split("-")[0];
    if (!byCode.has(code)) byCode.set(code, loc.country);
  }
  return [...byCode.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Match a user-supplied country against a relay: accepts the Mullvad country
 *  code ("ch") or the full name ("Switzerland"), case-insensitive. */
function relayMatchesCountry(relay: Relay, country: string): boolean {
  const q = country.trim().toLowerCase();
  return relay.countryCode.toLowerCase() === q || relay.country.toLowerCase() === q;
}

/** Pick a relay honouring an optional country preference: the nearest relay IN
 *  that country, or — when the country is unset or has no active relay — the
 *  nearest relay overall. `countryMatched` tells the caller which happened. Pure. */
export function selectRelay(
  data: RelaysResponse,
  ref: { latitude: number; longitude: number },
  country?: string | null,
): { relay: Relay; countryMatched: boolean } | null {
  const ranked = rankRelays(data, ref);
  if (!ranked.length) return null;
  if (country && country.trim()) {
    const inCountry = ranked.find((r) => relayMatchesCountry(r, country));
    if (inCountry) return { relay: inCountry, countryMatched: true };
  }
  return { relay: ranked[0], countryMatched: false };
}

/** Best-effort reference location (this host's geo per Mullvad). Falls back to
 *  Frankfurt (a central, well-connected default) when unavailable. */
export async function referenceLocation(): Promise<{ latitude: number; longitude: number }> {
  try {
    const loc = await fetchJson<{ latitude?: number; longitude?: number }>(LOCATION_URL, 8_000);
    if (typeof loc.latitude === "number" && typeof loc.longitude === "number") return { latitude: loc.latitude, longitude: loc.longitude };
  } catch {
    /* fall through */
  }
  return { latitude: 50.11, longitude: 8.68 }; // Frankfurt
}

/** Fetch relays and pick one, honouring an optional country preference (the
 *  nearest relay in that country, else the nearest overall). `countryMatched`
 *  is false when a requested country had no active relay (caller can warn). */
export async function pickRelay(country?: string | null): Promise<{ relay: Relay; countryMatched: boolean }> {
  const [data, ref] = await Promise.all([fetchJson<RelaysResponse>(RELAYS_URL), referenceLocation()]);
  const picked = selectRelay(data, ref, country);
  if (!picked) throw new Error("Aucun relais WireGuard Mullvad disponible");
  log.info("Mullvad relay selected", {
    hostname: picked.relay.hostname,
    city: picked.relay.city,
    country: picked.relay.country,
    km: Math.round(picked.relay.distanceKm),
    requestedCountry: country ?? null,
    countryMatched: picked.countryMatched,
  });
  return picked;
}

/** Fetch the list of countries that currently have an active WireGuard relay. */
export async function fetchCountries(): Promise<Country[]> {
  const data = await fetchJson<RelaysResponse>(RELAYS_URL);
  return listCountries(data);
}
