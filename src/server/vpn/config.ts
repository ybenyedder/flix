// VPN (Mullvad) configuration orchestrator for the opt-in feature. Turns a bare
// account number into a complete, applied gluetun WireGuard config: generate key
// → register with Mullvad → pick nearest relay → persist → write the gluetun env
// file that the bundled gluetun container consumes. Secrets live in the SQLite
// settings table (inside the /data volume) and in the gluetun env file (0600).
//
// Server-only. Dormant unless the operator configures it.

import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import { getDb } from "../db";
import { createLogger } from "../logger";
import {
  generateWireguardKeypair,
  publicKeyFromPrivate,
  registerKey,
  pickRelay,
  fetchCountries,
  normalizeAccount,
  isValidAccountFormat,
  type Relay,
  type Country,
} from "./mullvad";

const log = createLogger("vpn");

// LAN/compose subnet allowed to reach qBittorrent's WebUI through gluetun's
// firewall, and reachable from inside the tunnel. Matches docker-compose.arr.yml.
const LAN_SUBNET = "172.31.247.0/24";
const GLUETUN_CONTROL = "http://gluetun:8000";

// --- settings KV (secrets) ---------------------------------------------------

function getS(key: string): string | null {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}
function setS(key: string, value: string): void {
  getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
function deleteS(key: string): void {
  try {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
  } catch {
    /* best effort */
  }
}

export function isVpnEnabled(): boolean {
  return getS("vpn.enabled") === "1";
}

// --- gluetun env file location ----------------------------------------------

/** Where the gluetun env file is written. The vpn compose overlay bind-mounts a
 *  host dir at /vpn into BOTH flix and gluetun; when absent, fall back to the
 *  data dir so the config is still produced (for manual use). Overridable. */
export function vpnDir(): string {
  const override = process.env.FLIX_VPN_DIR?.trim();
  if (override) return override;
  if (fs.existsSync("/vpn")) return "/vpn";
  return path.join(getConfig().dataDir, "vpn");
}

function gluetunEnvPath(): string {
  return path.join(vpnDir(), "gluetun.env");
}

function writeGluetunEnv(server: Relay, privateKey: string, address: string): void {
  const dir = vpnDir();
  fs.mkdirSync(dir, { recursive: true });
  const content =
    [
      "# Généré par Flix — ne pas éditer à la main.",
      "WIREGUARD_PRIVATE_KEY=" + privateKey,
      "WIREGUARD_ADDRESSES=" + address,
      "WIREGUARD_PUBLIC_KEY=" + server.publicKey,
      "WIREGUARD_ENDPOINT_IP=" + server.endpointIp,
      "WIREGUARD_ENDPOINT_PORT=" + server.endpointPort,
    ].join("\n") + "\n";
  const file = gluetunEnvPath();
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort on platforms without POSIX modes */
  }
}

// --- DTO ---------------------------------------------------------------------

export interface VpnServerView {
  hostname: string;
  city: string;
  country: string;
}
export interface VpnSettings {
  enabled: boolean;
  /** Account number masked to the last 4 digits — never returned in full. */
  accountMask: string | null;
  server: VpnServerView | null;
  /** The operator's chosen exit country (code or name), or null for "nearest". */
  country: string | null;
  configuredAt: number | null;
  lanSubnet: string;
}

export function getVpnSettings(): VpnSettings {
  const account = getS("vpn.account");
  const hostname = getS("vpn.server.hostname");
  return {
    enabled: isVpnEnabled(),
    accountMask: account ? "•••• •••• •••• " + account.slice(-4) : null,
    server: hostname ? { hostname, city: getS("vpn.server.city") ?? "", country: getS("vpn.server.country") ?? "" } : null,
    country: getS("vpn.country"),
    configuredAt: Number(getS("vpn.configuredAt")) || null,
    lanSubnet: LAN_SUBNET,
  };
}

/** The countries Mullvad currently offers a WireGuard relay in (for the picker).
 *  Best-effort: returns [] if Mullvad's relay list is unreachable. */
export async function listVpnCountries(): Promise<Country[]> {
  try {
    return await fetchCountries();
  } catch (error) {
    log.warn("VPN countries fetch failed", { message: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

// --- configure ---------------------------------------------------------------

export interface ConfigureResult {
  ok: boolean;
  error?: string;
  status?: number;
  settings?: VpnSettings;
  /** Non-fatal note, e.g. the requested country had no relay and a fallback was used. */
  warning?: string;
}

/** Persist the picked relay + refresh the gluetun env. Shared by configure and
 *  change-country. */
function applyServer(server: Relay, privateKey: string, address: string, country: string | null): void {
  writeGluetunEnv(server, privateKey, address);
  setS("vpn.privateKey", privateKey);
  setS("vpn.address", address);
  setS("vpn.server.hostname", server.hostname);
  setS("vpn.server.city", server.city);
  setS("vpn.server.country", server.country);
  setS("vpn.server.endpointIp", server.endpointIp);
  setS("vpn.server.publicKey", server.publicKey);
  if (country && country.trim()) setS("vpn.country", country.trim());
  else deleteS("vpn.country");
  setS("vpn.configuredAt", String(Date.now()));
  setS("vpn.enabled", "1");
}

/** The full "enter an account number and everything is set up" flow. Reuses a
 *  previously generated private key when reconfiguring the same install (so the
 *  Mullvad key slot isn't churned), otherwise generates a fresh one. An optional
 *  country preference selects the exit relay (else the nearest is used). */
export async function configureVpn(rawAccount: string, country?: string | null): Promise<ConfigureResult> {
  const account = normalizeAccount(rawAccount);
  if (!isValidAccountFormat(account)) return { ok: false, error: "Numéro de compte Mullvad invalide (16 chiffres attendus)", status: 400 };

  try {
    // Reuse the stored key when re-configuring (same account), else fresh.
    let privateKey = getS("vpn.privateKey");
    let publicKey: string;
    if (privateKey && getS("vpn.account") === account) {
      publicKey = publicKeyFromPrivate(privateKey);
    } else {
      const kp = generateWireguardKeypair();
      privateKey = kp.privateKey;
      publicKey = kp.publicKey;
    }

    const address = await registerKey(account, publicKey); // also validates the account
    // A country wasn't passed → keep any previously chosen one.
    const pref = country !== undefined ? country : getS("vpn.country");
    const { relay, countryMatched } = await pickRelay(pref);

    setS("vpn.account", account);
    applyServer(relay, privateKey, address, countryMatched ? (pref ?? null) : null);

    log.info("VPN configuré", { server: relay.hostname, city: relay.city, country: relay.country, km: Math.round(relay.distanceKm) });
    const settings = getVpnSettings();
    const warning = pref && !countryMatched ? `Aucun relais Mullvad dans « ${pref} » — relais le plus proche utilisé (${relay.country}).` : undefined;
    return { ok: true, settings, warning };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec de la configuration du VPN";
    log.warn("VPN configure failed", { message });
    return { ok: false, error: message, status: 502 };
  }
}

/** Change the exit country WITHOUT re-registering the WireGuard key: the same key
 *  works with any Mullvad relay, so this just re-picks a relay and rewrites the
 *  gluetun env. Requires the VPN to already be configured (stored key + address).
 *  Passing null/empty reverts to "nearest relay". */
export async function changeVpnCountry(country: string | null): Promise<ConfigureResult> {
  const privateKey = getS("vpn.privateKey");
  const address = getS("vpn.address");
  if (!privateKey || !address) return { ok: false, error: "Configurez d'abord le VPN (numéro de compte Mullvad).", status: 400 };

  try {
    const { relay, countryMatched } = await pickRelay(country);
    applyServer(relay, privateKey, address, countryMatched ? country : null);
    log.info("VPN pays changé", { requested: country, server: relay.hostname, country: relay.country, matched: countryMatched });
    const settings = getVpnSettings();
    const warning = country && !countryMatched ? `Aucun relais Mullvad dans « ${country} » — relais le plus proche utilisé (${relay.country}).` : undefined;
    return { ok: true, settings, warning };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec du changement de pays";
    log.warn("VPN change country failed", { message });
    return { ok: false, error: message, status: 502 };
  }
}

/** Disable the VPN: clear the flag and remove the gluetun env so a subsequent
 *  container start brings gluetun up with no tunnel (kill-switch blocks traffic,
 *  never leaks). The stored key is kept so re-enabling doesn't churn the slot. */
export function disableVpn(): VpnSettings {
  setS("vpn.enabled", "0");
  try {
    fs.rmSync(gluetunEnvPath(), { force: true });
  } catch {
    /* best effort */
  }
  return getVpnSettings();
}

// --- live status via gluetun control server ----------------------------------

export interface VpnStatus {
  /** Reachable gluetun + tunnel established. */
  connected: boolean;
  /** Current public (exit) IP as seen by gluetun, when connected. */
  publicIp: string | null;
  country: string | null;
  error: string | null;
}

export async function getVpnStatus(): Promise<VpnStatus> {
  if (!isVpnEnabled()) return { connected: false, publicIp: null, country: null, error: null };
  try {
    const res = await fetch(`${GLUETUN_CONTROL}/v1/publicip/ip`, { signal: AbortSignal.timeout(4_000), cache: "no-store" });
    if (!res.ok) return { connected: false, publicIp: null, country: null, error: `gluetun ${res.status}` };
    const data = (await res.json()) as { public_ip?: string; country?: string };
    const ip = data.public_ip ?? null;
    return { connected: !!ip, publicIp: ip, country: data.country ?? null, error: null };
  } catch {
    // gluetun unreachable = the vpn overlay isn't running yet (needs one compose up).
    return { connected: false, publicIp: null, country: null, error: "gluetun injoignable — appliquez la configuration (voir Paramètres)" };
  }
}
