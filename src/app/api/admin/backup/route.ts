// Admin backup download: a consistent point-in-time copy of the SQLite
// database via the online backup API (backupDbTo — safe against a live WAL
// connection, unlike copying flix.db off disk), written to a temp file under
// the data dir, streamed as an attachment, then cleaned up.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getConfig } from "@/server/config";
import { backupDbTo } from "@/server/db";
import { toWebStream } from "@/server/playback/streamUtil";
import { requireAdmin, json, applySecurityHeaders } from "@/server/http";
import { getRequestUser } from "@/server/auth";
import { rateLimitWindow } from "@/server/rateLimit";
import { createLogger } from "@/server/logger";

const log = createLogger("api:backup");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  // GET is CSRF-exempt by design, so a third-party page can loop <img src=…>
  // with the admin's cookie and trigger full-DB online-backup copies (temp
  // file + I/O) at will. A small per-admin window is ample for any human use.
  const admin = getRequestUser(request);
  if (rateLimitWindow(`backup:${admin?.id ?? "anon"}`, 5, 60_000)) {
    return json({ error: "Trop de sauvegardes rapprochées — réessayez dans une minute." }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const { dataDir } = getConfig();
  // Random suffix: two concurrent downloads must never share (then unlink) the
  // same temp file. `.tmp` extension keeps it visibly disposable in dataDir.
  const tmpFile = path.join(dataDir, `flix-backup-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.tmp`);
  const cleanup = () => fs.promises.unlink(tmpFile).catch(() => {});

  let size: number;
  try {
    await backupDbTo(tmpFile);
    size = (await fs.promises.stat(tmpFile)).size;
  } catch (error) {
    log.error("backup failed", { error: error instanceof Error ? error.message : String(error) });
    await cleanup();
    return json({ error: "Échec de la sauvegarde" }, { status: 500 });
  }

  // Stream (not buffer): a long-lived library DB can be tens of MB. The temp
  // file is unlinked when the stream closes — end of download AND client
  // abort both land on 'close' (autoDestroy), so it can't leak either way.
  const nodeStream = fs.createReadStream(tmpFile);
  nodeStream.on("close", () => void cleanup());

  const date = new Date().toISOString().slice(0, 10);
  const res = new NextResponse(toWebStream(nodeStream) as BodyInit, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="flix-backup-${date}.db"`,
      "Cache-Control": "no-store",
    },
  });
  return applySecurityHeaders(res);
}
