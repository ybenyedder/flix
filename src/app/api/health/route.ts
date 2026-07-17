import fs from "fs";
import { getDb } from "@/server/db";
import { getConfig } from "@/server/config";
import { isAuthenticated } from "@/server/auth";
import { json, withCors } from "@/server/http";
import { probeFfmpegAvailable } from "@/server/playback/sessions";
import pkg from "../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const config = getConfig();
  let movies = 0;
  let episodes = 0;
  let dbOk = true;
  try {
    movies = (getDb().prepare("SELECT COUNT(*) AS n FROM movies").get() as { n: number }).n;
    episodes = (getDb().prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n;
  } catch {
    dbOk = false;
  }
  // Readable, not just "exists" — a scan silently returns zero files against an
  // unreadable dir (permissions, unmounted network share) with no error anywhere,
  // so this is the only place an operator's healthcheck can catch that class of
  // misconfiguration before "library is empty" support requests show up.
  let mediaDirOk = true;
  try {
    fs.accessSync(config.mediaDir, fs.constants.R_OK);
  } catch {
    mediaDirOk = false;
  }
  // Memoised (one spawn per process, not per request) — a missing/broken
  // ffmpeg binary (FFMPEG_PATH typo, image without ffmpeg) only ever fails
  // asynchronously at session-spawn time, so health is where an operator can
  // actually see it. Direct play keeps working regardless.
  const ffmpegOk = await probeFfmpegAvailable();
  const status = dbOk && mediaDirOk && ffmpegOk ? "ok" : "degraded";
  // Health is the one endpoint clients probe cross-origin (before navigating to
  // the server), so it explicitly opts back into an open ACAO. Because it is both
  // unauthenticated AND CORS-open, it must NOT leak host internals: the absolute
  // mediaDir path is omitted, and the exact version (a CVE-targeting fingerprint)
  // and the library counts are withheld from anonymous callers and only returned
  // once the request carries a valid session. Per http.ts's CORS contract, the
  // wildcard ACAO goes on the UNAUTHENTICATED variant only — the authenticated
  // body stays same-origin (anonymous cross-origin probes don't carry
  // credentials anyway, so this loses nothing).
  const authed = isAuthenticated(request);
  const res = json({
    name: "Flix",
    status,
    db: dbOk,
    mediaDir: mediaDirOk,
    ffmpeg: ffmpegOk,
    ...(authed ? { version: pkg.version, movies, episodes } : {}),
  });
  return authed ? res : withCors(res);
}
