// GET /api/arr/poster?u= — same-origin proxy + disk cache for remote posters
// from the *arr lookup (TMDB/TVDB/fanart CDNs). The CSP is img-src 'self', so
// discover cards can't hotlink; this proxy keeps that posture while an allowlist
// (isAllowedPosterUrl) blocks it from being turned into an open SSRF relay.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getRequestUser } from "@/server/auth";
import { getConfig } from "@/server/config";
import { rateLimitWindow } from "@/server/rateLimit";
import { isArrEnabled } from "@/server/arr/config";
import { isAllowedPosterUrl } from "@/server/arr/statusMap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "X-Content-Type-Options": "nosniff" } });
}

function tooManyRequests(): Response {
  return new Response("Too Many Requests", { status: 429, headers: { "X-Content-Type-Options": "nosniff" } });
}

function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function serve(buf: Buffer): Response {
  const type = sniffImageType(buf) ?? "image/jpeg";
  // Copy into a fresh Uint8Array (backed by a plain ArrayBuffer) — a Node Buffer
  // view isn't a valid BodyInit under the DOM lib types (ArrayBufferLike store).
  const body = new Uint8Array(buf);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=604800, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: Request) {
  const user = getRequestUser(request);
  if (!user) return notFound(); // opaque 404, never leak auth state on an <img>
  // Kids don't get the *arr surface (discover/requests reject them too); stay
  // opaque with a 404 rather than a 403 to keep the never-leak-on-<img> posture.
  if (user.is_kids === 1) return notFound();
  if (!isArrEnabled()) return notFound();

  // Per-user cap so this authenticated, on-disk-caching proxy can't be spun to
  // fill the cache or hammer upstream CDNs — matches the sibling arr routes.
  if (rateLimitWindow(`user:${user.id}:arr-poster`, 120, 60_000)) return tooManyRequests();

  const raw = new URL(request.url).searchParams.get("u") ?? "";
  if (!isAllowedPosterUrl(raw)) return notFound();

  const cacheDir = path.join(getConfig().cacheDir, "arr-posters");
  const cacheFile = path.join(cacheDir, crypto.createHash("sha1").update(raw).digest("hex"));

  try {
    return serve(fs.readFileSync(cacheFile));
  } catch {
    /* cache miss — fetch below */
  }

  let res: Response;
  try {
    res = await fetch(raw, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
  } catch {
    return notFound();
  }
  if (!res.ok || !res.body) return notFound();
  if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) return notFound();

  // Stream with a hard cap so a hostile/huge response can't exhaust memory.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return notFound();
      }
      chunks.push(value);
    }
  } catch {
    return notFound();
  }
  const buf = Buffer.concat(chunks);
  if (!sniffImageType(buf)) return notFound(); // content-type claimed image but bytes aren't

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, buf);
  } catch {
    /* cache write best-effort */
  }
  return serve(buf);
}
