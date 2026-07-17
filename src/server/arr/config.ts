// Opt-in *arr integration — configuration & feature gate.
//
// Flix is offline by default (see ../config.ts header). This whole subsystem is
// dormant unless the operator flips `arr.enabled` in the `settings` table. Once
// enabled, Flix talks ONLY to the operator's own local Prowlarr/Sonarr/Radarr/
// Bazarr instances — never to the public internet directly.
//
// Per-service URLs + API keys resolve with a two-layer precedence:
//   1. manual  — values typed into the admin Settings UI, stored in `settings`
//   2. auto    — `arr-services.json`, written into the data dir by the bundled
//                docker-compose init container (deploy/arr/arr-init.mjs)
// Manual always wins, so an operator can override an auto-detected endpoint.
//
// This module is server-only. It must never be imported from a client component.

import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import { getDb } from "../db";
import { createLogger } from "../logger";

const log = createLogger("arr");

export type ArrService = "sonarr" | "radarr" | "prowlarr" | "bazarr";
export const ARR_SERVICES: ArrService[] = ["sonarr", "radarr", "prowlarr", "bazarr"];

export const ARR_ENABLED_KEY = "arr.enabled";
export const ARR_DISMISSED_KEY = "arr.dismissed";

export interface ServiceConfig {
  url: string;
  apiKey: string;
  /** Where the values came from — surfaced in the admin UI as a provenance hint. */
  source: "manual" | "auto";
}

// --- settings KV helpers (same idiom as watcher.ts's library.autoScan) -------

function getSetting(key: string): string | null {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setSetting(key: string, value: string): void {
  getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function deleteSetting(key: string): void {
  try {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
  } catch {
    /* best effort */
  }
}

// --- feature gate ------------------------------------------------------------

/** The master switch. Every outbound call in client.ts re-checks this. */
export function isArrEnabled(): boolean {
  return getSetting(ARR_ENABLED_KEY) === "1";
}

/** Whether the opt-in has been decided at all (vs. never asked). Used by
 *  initArr() so a boot-time answer only ever seeds an UNDECIDED install. */
export function isArrDecided(): boolean {
  return getSetting(ARR_ENABLED_KEY) !== null;
}

export function setArrEnabled(enabled: boolean): void {
  setSetting(ARR_ENABLED_KEY, enabled ? "1" : "0");
  if (enabled) setSetting(ARR_DISMISSED_KEY, "1"); // enabling implies the nudge is resolved
}

/** The one-time admin banner is dismissed (either enabled, or explicitly hidden). */
export function isArrDismissed(): boolean {
  return getSetting(ARR_DISMISSED_KEY) === "1";
}

export function setArrDismissed(dismissed: boolean): void {
  setSetting(ARR_DISMISSED_KEY, dismissed ? "1" : "0");
}

// --- URL validation ----------------------------------------------------------

/** Normalise a service base URL: http/https only, no trailing slash. Returns
 *  null when the input isn't a usable absolute http(s) URL. */
export function normalizeServiceUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // Strip trailing slashes so `${url}/api/...` never doubles up.
  return parsed.toString().replace(/\/+$/, "");
}

// --- auto-detected services (arr-services.json) ------------------------------

interface AutoServicesFile {
  version?: number;
  wiredAt?: number;
  services?: Partial<Record<ArrService, { url?: string; apiKey?: string }>>;
}

function autoServicesPath(): string {
  const override = process.env.FLIX_ARR_SERVICES_FILE?.trim();
  if (override) return override;
  return path.join(getConfig().dataDir, "arr-services.json");
}

// Memoise the parsed file on its mtime — the init container writes it once, but
// this is read on every discover/request/poll pass.
let autoCache: { mtimeMs: number; data: AutoServicesFile } | null = null;

function readAutoServices(): AutoServicesFile {
  const file = autoServicesPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    autoCache = null;
    return {};
  }
  if (autoCache && autoCache.mtimeMs === mtimeMs) return autoCache.data;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as AutoServicesFile;
    autoCache = { mtimeMs, data: data && typeof data === "object" ? data : {} };
  } catch {
    // Tolerant: a half-written or corrupt file must not take the feature down.
    autoCache = { mtimeMs, data: {} };
  }
  return autoCache.data;
}

// --- per-service resolution --------------------------------------------------

/** Resolve a service's usable {url, apiKey, source}, or null if unconfigured. */
export function getServiceConfig(service: ArrService): ServiceConfig | null {
  const manualUrl = normalizeServiceUrl(getSetting(`arr.${service}.url`));
  const manualKey = getSetting(`arr.${service}.apiKey`)?.trim();
  if (manualUrl && manualKey) return { url: manualUrl, apiKey: manualKey, source: "manual" };

  const auto = readAutoServices().services?.[service];
  const autoUrl = normalizeServiceUrl(auto?.url);
  const autoKey = auto?.apiKey?.trim();
  if (autoUrl && autoKey) return { url: autoUrl, apiKey: autoKey, source: "auto" };

  return null;
}

export interface ServiceConfigView {
  service: ArrService;
  configured: boolean;
  source: "manual" | "auto" | null;
  /** Base URL only — the API key is never sent to the client. */
  url: string | null;
}

/** Non-secret view of every service's config for the admin Settings UI. */
export function listServiceConfigs(): ServiceConfigView[] {
  return ARR_SERVICES.map((service) => {
    const cfg = getServiceConfig(service);
    return { service, configured: cfg !== null, source: cfg?.source ?? null, url: cfg?.url ?? null };
  });
}

/** Persist a manual URL/API-key pair for a service. Passing an empty string for
 *  a field clears that manual override (falling back to auto-detection). */
export function setServiceConfig(service: ArrService, updates: { url?: string; apiKey?: string }): { ok: boolean; error?: string } {
  if (updates.url !== undefined) {
    const trimmed = updates.url.trim();
    if (trimmed === "") {
      deleteSetting(`arr.${service}.url`);
    } else {
      const normalized = normalizeServiceUrl(trimmed);
      if (!normalized) return { ok: false, error: `URL invalide pour ${service} (http:// ou https:// requis)` };
      setSetting(`arr.${service}.url`, normalized);
    }
  }
  if (updates.apiKey !== undefined) {
    const trimmed = updates.apiKey.trim();
    if (trimmed === "") deleteSetting(`arr.${service}.apiKey`);
    else setSetting(`arr.${service}.apiKey`, trimmed);
  }
  return { ok: true };
}

// --- boot-time opt-in consumption -------------------------------------------

/** Read the launch-time answer the operator gave, from (1) the FLIX_ARR_SETUP
 *  env var (set by the docker-compose override — running the *arr compose IS the
 *  opt-in) or (2) `arrPromptAnswer` in host-settings.json (written by the TTY
 *  prompt in start.mjs). Returns "yes" | "no" | null (undecided / "later"). */
function readLaunchAnswer(): "yes" | "no" | null {
  const env = process.env.FLIX_ARR_SETUP?.trim().toLowerCase();
  if (env) {
    if (["1", "yes", "true", "on", "o", "oui"].includes(env)) return "yes";
    if (["0", "no", "false", "off", "n", "non"].includes(env)) return "no";
  }
  try {
    const file = path.join(getConfig().dataDir, "host-settings.json");
    const answer = (JSON.parse(fs.readFileSync(file, "utf8")) as { arrPromptAnswer?: unknown }).arrPromptAnswer;
    if (answer === "yes") return "yes";
    if (answer === "no") return "no";
  } catch {
    /* no host-settings / not written yet */
  }
  return null;
}

let initialised = false;

/** Boot hook (see bootstrap.ts) — never throws. Consumes the launch-time opt-in
 *  answer ONCE on an undecided install, then, if the feature is on, revives the
 *  request poller so any download in flight before a restart keeps advancing. */
export function initArr(): void {
  if (initialised) return;
  initialised = true;
  try {
    if (!isArrDecided()) {
      const answer = readLaunchAnswer();
      if (answer === "yes") {
        setArrEnabled(true);
        log.info("téléchargements automatiques activés au lancement (opt-in)");
      } else if (answer === "no") {
        setArrEnabled(false);
        log.info("téléchargements automatiques refusés au lancement");
      }
    }
    if (isArrEnabled()) {
      void import("./requests")
        .then((m) => m.resumePoller())
        .catch(() => {});
    }
  } catch (error) {
    log.warn("arr init failed", { message: error instanceof Error ? error.message : String(error) });
  }
}

/** Test hook: reset the one-shot init guard and the auto-services memo. */
export function __resetArrInit(): void {
  initialised = false;
  autoCache = null;
}
