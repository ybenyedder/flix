// Flix server configuration — resolves all runtime paths and options from the
// environment with safe, documented local-first defaults. No third-party services,
// no network calls of any kind: this is stricter than a typical self-hosted media
// server, by design. (The sole exception is the OPT-IN *arr download integration
// in src/server/arr/*, disabled by default; when enabled it talks only to the
// operator's own local Sonarr/Radarr/Prowlarr/Bazarr instances.)
//
// This module is server-only. It must never be imported from a client component.

import fs from "fs";
import os from "os";
import path from "path";
import { createLogger } from "./logger";

const log = createLogger("config");

export interface FlixConfig {
  /** Absolute path to the video library that is scanned and streamed. */
  mediaDir: string;
  /** Absolute path to the writable data directory (database, image cache, transcode, logs). */
  dataDir: string;
  /** Absolute path to the SQLite database file. */
  dbPath: string;
  /** Absolute path to the on-disk poster/backdrop/thumb cache. */
  imagesDir: string;
  /** Absolute path to the scratch directory used for HLS remux/transcode sessions. */
  transcodeDir: string;
  /** Absolute path to the misc cache directory (subtitle VTT cache, trickplay sprites). */
  cacheDir: string;
  /** TCP port the standalone/desktop server binds to. */
  port: number;
  /** Optional bearer token required for API access (LAN hardening). Empty = open. */
  authToken: string;
  /** Path or name of the ffmpeg binary. */
  ffmpegPath: string;
  /** Path or name of the ffprobe binary. */
  ffprobePath: string;
  /** Max concurrent transcode/remux ffmpeg sessions. */
  maxTranscodeSessions: number;
  /** Cap on the vertical resolution a software transcode will target (quality/CPU guard). */
  maxTranscodeHeight: number;
  /** Whether to build video-scrubbing trickplay sprites (extra ffmpeg work per file). */
  trickplay: boolean;
  /** Max files scanned in one pass (guards pathological trees). */
  maxScanFiles: number;
  /** Max directory recursion depth. */
  maxScanDepth: number;
}

function firstDefined(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** os.homedir() THROWS in a container with no HOME and no passwd entry for the
 *  uid — that would take getConfig() (and with it every route) down with a 500.
 *  Null lets each caller pick a sane cwd-relative fallback instead. */
function safeHomeDir(): string | null {
  try {
    return os.homedir() || null;
  } catch {
    return null;
  }
}

function resolveDataDir(): string {
  const explicit = firstDefined(process.env.FLIX_DATA_DIR);
  if (explicit) return path.resolve(/*turbopackIgnore: true*/ explicit);

  const xdg = firstDefined(process.env.XDG_DATA_HOME);
  if (xdg) return path.resolve(xdg, "flix");

  if (process.platform === "win32") {
    const appData = firstDefined(process.env.APPDATA);
    if (appData) return path.resolve(appData, "Flix");
  }
  const home = safeHomeDir();
  if (!home) {
    log.warn("no resolvable home directory — falling back to a cwd-relative data dir; set FLIX_DATA_DIR to choose one explicitly");
    return path.resolve(process.cwd(), ".flix-data");
  }
  if (process.platform === "darwin") {
    return path.resolve(home, "Library", "Application Support", "Flix");
  }
  return path.resolve(home, ".local", "share", "flix");
}

// Host-chosen settings (e.g. the video folder picked from the desktop app) are
// persisted next to the database so they survive restarts and outrank the env
// default. The self-hoster can repoint the library without touching env vars.
function hostSettingsPath(): string {
  return path.join(resolveDataDir(), "host-settings.json");
}
function readHostSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ hostSettingsPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveMediaDir(): string {
  const stored = readHostSettings().mediaDir;
  const configured = firstDefined(typeof stored === "string" ? stored : undefined, process.env.FLIX_MEDIA_DIR);
  if (configured) return path.resolve(/*turbopackIgnore: true*/ configured);
  const home = safeHomeDir();
  if (!home) {
    log.warn("no resolvable home directory — falling back to a cwd-relative media dir; set FLIX_MEDIA_DIR to choose one explicitly");
    return path.resolve(process.cwd(), "videos");
  }
  return path.resolve(home, "Videos");
}

/** Persist a host-chosen media directory and reset the cached config so the next
 *  scan reads the new folder. Returns the resolved absolute path. */
export function setMediaDir(dir: string): string {
  const abs = path.resolve(dir);
  fs.mkdirSync(resolveDataDir(), { recursive: true });
  const next = { ...readHostSettings(), mediaDir: abs };
  fs.writeFileSync(hostSettingsPath(), JSON.stringify(next, null, 2));
  resetConfigCache();
  return abs;
}

function parsePort(): number {
  // SERVER_PORT is the allocation port injected by game-server panels
  // (Pterodactyl/Pelican Wings) — honoured last so FLIX_PORT/PORT still win.
  const raw = firstDefined(process.env.FLIX_PORT, process.env.PORT, process.env.SERVER_PORT);
  const value = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 4247;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

let cached: FlixConfig | null = null;

export function getConfig(): FlixConfig {
  if (cached) return cached;

  const dataDir = resolveDataDir();
  const config: FlixConfig = {
    mediaDir: resolveMediaDir(),
    dataDir,
    dbPath: path.join(dataDir, "flix.db"),
    imagesDir: path.join(dataDir, "images"),
    transcodeDir: path.join(dataDir, "transcode"),
    cacheDir: path.join(dataDir, "cache"),
    port: parsePort(),
    authToken: firstDefined(process.env.FLIX_TOKEN) ?? "",
    ffmpegPath: firstDefined(process.env.FFMPEG_PATH) ?? "ffmpeg",
    ffprobePath: firstDefined(process.env.FFPROBE_PATH) ?? "ffprobe",
    maxTranscodeSessions: parseIntEnv(process.env.FLIX_MAX_TRANSCODES, 2),
    maxTranscodeHeight: parseIntEnv(process.env.FLIX_MAX_TRANSCODE_HEIGHT, 1080),
    trickplay: parseBool(process.env.FLIX_TRICKPLAY, false),
    maxScanFiles: parseIntEnv(process.env.FLIX_MAX_SCAN_FILES, 200_000),
    maxScanDepth: parseIntEnv(process.env.FLIX_MAX_SCAN_DEPTH, 12),
  };

  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.imagesDir, { recursive: true });
  fs.mkdirSync(config.transcodeDir, { recursive: true });
  fs.mkdirSync(config.cacheDir, { recursive: true });

  // Unlike dataDir/imagesDir, mediaDir isn't created for the user — a fresh empty
  // library is a normal state. But a MISSING or unreadable one (typo'd env var,
  // unmounted network share, permissions) degrades to the exact same observable
  // symptom — scanner.ts's walk() just catches ENOENT and returns nothing — so an
  // operator has no way to tell "empty on purpose" from "misconfigured" short of
  // reading this specific warning at boot (also surfaced live via /api/health's
  // mediaDir field).
  try {
    fs.accessSync(/*turbopackIgnore: true*/ config.mediaDir, fs.constants.R_OK);
  } catch {
    log.warn("configured media directory is missing or unreadable — library will scan as empty", {
      mediaDir: config.mediaDir,
    });
  }

  cached = config;
  return config;
}

/** Reset cached config — used by tests that mutate the environment. */
export function resetConfigCache(): void {
  cached = null;
}
