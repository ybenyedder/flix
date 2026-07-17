// Admin settings: the effective server configuration (read-only — host paths
// and ports are operator-level information, same admin gate as
// /api/library/source) plus the auto-scan toggle, applied hot through the
// watcher module.

import fs from "fs";
import { getConfig } from "@/server/config";
import { getAutoScan, setAutoScan, getWatcherStatus } from "@/server/library/watcher";
import { requireAdmin, checkCsrf, readJsonBody, json, noStore } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function settingsPayload() {
  const config = getConfig();
  const watcher = getWatcherStatus();
  return {
    autoScan: getAutoScan(),
    watcherActive: watcher.active,
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

  const parsed = await readJsonBody<{ autoScan?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  if (typeof parsed.body.autoScan !== "boolean") return json({ error: "autoScan invalide" }, { status: 400 });

  setAutoScan(parsed.body.autoScan);
  return noStore(json(settingsPayload()));
}
