// Admin settings: the effective server configuration (read-only — host paths
// and ports are operator-level information, same admin gate as
// /api/library/source) plus the auto-scan toggle, applied hot through the
// watcher module.

import fs from "fs";
import { getConfig } from "@/server/config";
import { getAutoScan, setAutoScan, getWatcherStatus } from "@/server/library/watcher";
import { isOnlineArtworkEnabled, setOnlineArtworkEnabled, getTmdbKey, setTmdbKey, runOnlineArtworkPass } from "@/server/library/onlineArtwork";
import { requireAdmin, checkCsrf, readJsonBody, json, noStore } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function settingsPayload() {
  const config = getConfig();
  const watcher = getWatcherStatus();
  return {
    autoScan: getAutoScan(),
    watcherActive: watcher.active,
    // Online artwork enrichment — the TMDB key itself is write-only (never
    // echoed back), only its presence is surfaced.
    onlineArtwork: isOnlineArtworkEnabled(),
    tmdbKeySet: getTmdbKey() !== null,
    config: {
      mediaDir: config.mediaDir,
      mediaDirExists: fs.existsSync(config.mediaDir),
      dataDir: config.dataDir,
      port: config.port,
      trickplay: config.trickplay,
      ffmpegPath: config.ffmpegPath,
      maxTranscodeSessions: config.maxTranscodeSessions,
      maxTranscodeHeight: config.maxTranscodeHeight,
    },
  };
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return noStore(json(settingsPayload()));
}

// POST { autoScan } → persist the toggle and start/stop the watcher without a
// restart. Admin-only mutation → CSRF-guarded like every cookie-authed write.
export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = requireAdmin(request);
  if (denied) return denied;

  const parsed = await readJsonBody<{ autoScan?: unknown; onlineArtwork?: unknown; tmdbKey?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (body.autoScan === undefined && body.onlineArtwork === undefined && body.tmdbKey === undefined) {
    return json({ error: "aucun réglage fourni" }, { status: 400 });
  }

  if (body.autoScan !== undefined) {
    if (typeof body.autoScan !== "boolean") return json({ error: "autoScan invalide" }, { status: 400 });
    setAutoScan(body.autoScan);
  }
  if (body.onlineArtwork !== undefined) {
    if (typeof body.onlineArtwork !== "boolean") return json({ error: "onlineArtwork invalide" }, { status: 400 });
    setOnlineArtworkEnabled(body.onlineArtwork);
  }
  if (body.tmdbKey !== undefined) {
    if (typeof body.tmdbKey !== "string") return json({ error: "tmdbKey invalide" }, { status: 400 });
    setTmdbKey(body.tmdbKey);
  }

  // Enabling the toggle (or handing over a TMDB key) should surface real art
  // without waiting for the next scan. Self-gating, single-flight, never throws.
  if ((body.onlineArtwork === true || (typeof body.tmdbKey === "string" && body.tmdbKey.trim() !== "")) && isOnlineArtworkEnabled()) {
    void runOnlineArtworkPass().catch(() => {/* best effort */});
  }

  return noStore(json(settingsPayload()));
}
