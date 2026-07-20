// Flix container/standalone entrypoint.
//
// Sits next to the Next.js standalone `server.js` in the deployable bundle
// (copied there by scripts/prepare-standalone.mjs and the Dockerfile) and does
// the environment plumbing a bare `node server.js` leaves to the operator:
//
//   1. Port resolution   — FLIX_PORT > PORT > SERVER_PORT (Pterodactyl/Pelican
//                          Wings injects SERVER_PORT) > 4247, exported as PORT
//                          so Next's server.js and Flix's config agree.
//   2. Bind address      — FLIX_HOST > HOSTNAME (literal IPs only) > 0.0.0.0.
//                          Containers must bind the wildcard or the panel's
//                          port mapping goes nowhere.
//   3. ffmpeg preflight  — resolves FFMPEG_PATH/FFPROBE_PATH and warns loudly
//                          (without refusing to boot: direct play works without
//                          ffmpeg, scanning/remux/transcode do not).
//   4. Readiness banner  — polls /api/health until the server answers, then
//                          prints a stable `[flix] ready` line that Pterodactyl's
//                          egg uses as its "done" marker.
//
// Zero dependencies, Node 20+.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import readline from "node:readline/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Next's standalone server installs its own SIGTERM/SIGINT handler that closes
// the HTTP server and calls process.exit(143) — racing (and usually beating)
// Flix's graceful-shutdown hook in db.ts, whose async chain (kill live ffmpeg
// sessions → WAL checkpoint → close) then never completes. Suppress Next's
// handler: db.ts owns the signals and exits the process itself once cleanup is
// done. (If no request ever opened the DB, no handler exists and Node's default
// signal exit applies — fine, there is nothing to clean up.)
process.env.NEXT_MANUAL_SIG_HANDLE = "true";

const port = resolvePort();
const host = resolveHost();

process.env.NODE_ENV ||= "production";
process.env.PORT = String(port);
process.env.HOSTNAME = host;
// Panels only inject SERVER_PORT; mirror it into FLIX_PORT so every consumer
// of getConfig().port (desktop aside) sees the same value as server.js.
process.env.FLIX_PORT ||= String(port);

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function resolvePort() {
  const raw = firstEnv("FLIX_PORT", "PORT", "SERVER_PORT");
  const value = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 4247;
}

function resolveHost() {
  const explicit = firstEnv("FLIX_HOST");
  if (explicit) return explicit;
  // HOSTNAME is honoured ONLY when it is a literal IP: Docker/podman/Wings
  // always inject HOSTNAME=<container id>, and binding that resolves to the
  // eth0 address alone — loopback stops answering, so the image HEALTHCHECK
  // and announceWhenReady() below (both 127.0.0.1) fail forever while the
  // published port happily serves. That is the "unhealthy container /
  // Pterodactyl stuck on starting" failure seen in production. Next's own
  // standalone server reads HOSTNAME the same way, hence the export below.
  const hostname = firstEnv("HOSTNAME");
  if (hostname && net.isIP(hostname)) return hostname;
  return "0.0.0.0";
}

function checkBinary(label, envName, fallback) {
  const bin = firstEnv(envName) ?? fallback;
  const probe = spawnSync(bin, ["-version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    console.error(
      `[flix] WARNING: ${label} not found or not executable (${bin}). ` +
        `Library scanning and remux/transcode playback will fail — set ${envName} ` +
        `to a valid binary. Direct play of already-compatible files still works.`,
    );
    return false;
  }
  return true;
}

checkBinary("ffmpeg", "FFMPEG_PATH", "ffmpeg");
checkBinary("ffprobe", "FFPROBE_PATH", "ffprobe");

// ABI preflight — fatal, unlike the ffmpeg warnings above: the bundled
// better-sqlite3 binding is compiled for Node 22 (Dockerfile/CI/egg all
// agree), and under a mismatched Node the server still boots, /api/health
// answers 200 "degraded" and the ready banner prints — a total DB outage
// (every route 500s) disguised as a successful start. Requiring the module
// loads the native binding without opening any database.
try {
  createRequire(import.meta.url)("better-sqlite3");
} catch (error) {
  console.error(
    `[flix] FATAL: the bundled better-sqlite3 native binding cannot load under ` +
      `Node ${process.versions.node} (${error instanceof Error ? error.message : error}).\n` +
      `[flix] This bundle is built for Node 22 — run it with Node 22, or rebuild ` +
      `the binding in place: npm rebuild better-sqlite3`,
  );
  process.exit(1);
}

// Poll our own health endpoint until the HTTP server actually answers, then
// print the readiness banner. Runs alongside the server import below; gives
// panels (and `docker logs`) a single unambiguous "it works" line.
async function announceWhenReady() {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 503) {
        console.log(`[flix] ready - listening on http://${host}:${port}`);
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error("[flix] server did not answer /api/health within 120s — check the logs above.");
}

// Optional opt-in prompt for the *arr download integration. ONLY when an
// interactive terminal is attached (a bare-metal `node start.mjs`) — never in
// Docker/Pterodactyl (no TTY), so the non-interactive boot path and the
// `[flix] ready` stdout contract are byte-for-byte unchanged. Zero-dep: the
// answer is persisted to host-settings.json and consumed once by the server's
// initArr() (start.mjs must not open SQLite). Containers opt in via FLIX_ARR_SETUP.
function arrDataDir() {
  const explicit = process.env.FLIX_DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return path.resolve(xdg, "flix");
  if (process.platform === "win32" && process.env.APPDATA) return path.resolve(process.env.APPDATA, "Flix");
  let home = null;
  try {
    home = os.homedir() || null;
  } catch {
    home = null;
  }
  if (!home) return path.resolve(process.cwd(), ".flix-data");
  if (process.platform === "darwin") return path.resolve(home, "Library", "Application Support", "Flix");
  return path.resolve(home, ".local", "share", "flix");
}

function readHostSettings(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "host-settings.json"), "utf8"));
  } catch {
    return {};
  }
}

function persistArrAnswer(dir, answer) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "host-settings.json");
    fs.writeFileSync(file, JSON.stringify({ ...readHostSettings(dir), arrPromptAnswer: answer }, null, 2));
  } catch {
    // best effort — a non-writable data dir just means we re-ask next TTY boot
  }
}

async function maybePromptArrSetup() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return; // no interactive terminal
  if (process.env.FLIX_ARR_SETUP) return; // opt-in already decided via env (compose override)
  const dir = arrDataDir();
  if (readHostSettings(dir).arrPromptAnswer) return; // already asked once

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer = "later";
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    timer.unref?.();
    let reply = "";
    try {
      reply = (await rl.question("[flix] Activer les téléchargements automatiques (Sonarr/Radarr/Prowlarr/Bazarr + qBittorrent) ? [o/N] ", { signal: ac.signal }))
        .trim()
        .toLowerCase();
    } finally {
      clearTimeout(timer);
    }
    if (["o", "oui", "y", "yes"].includes(reply)) {
      answer = "yes";
      console.log("[flix] Téléchargements automatiques activés. Déployez la pile complète avec :");
      console.log("[flix]   docker compose -f docker-compose.yml -f docker-compose.arr.yml up -d");
      console.log("[flix] ou renseignez des services existants dans Paramètres → Téléchargements. Détails : docs/downloads-arr.md");
    } else if (["n", "non", "no"].includes(reply)) {
      answer = "no";
    }
  } catch {
    answer = "later"; // aborted (30s timeout) or read error — decide later, don't block boot again
  } finally {
    rl.close();
  }
  persistArrAnswer(dir, answer);
}

await maybePromptArrSetup();

console.log(`[flix] starting on ${host}:${port} (data: ${process.env.FLIX_DATA_DIR ?? "default"}, media: ${process.env.FLIX_MEDIA_DIR ?? "default"})`);
void announceWhenReady();

await import("./server.js");
