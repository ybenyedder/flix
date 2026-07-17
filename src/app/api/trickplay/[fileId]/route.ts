// GET /api/trickplay/<fileId>          -> trickplay metadata JSON
// GET /api/trickplay/<fileId>?sprite=1 -> the JPEG sprite itself
//
// Both require authentication and pass the same parental gate as every other
// playback route that takes a raw fileId (a kids profile must never confirm an
// adult title exists via an enumerable id — always the same 404). Responses
// are keyed on fileId+mtime via the ETag, `private` cached (per-profile gate →
// a shared proxy cache must never reuse them across users), and 404 when the
// sprite simply hasn't been generated (flag off, pass not run yet, or the file
// changed since).

import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { getRequestUser } from "@/server/auth";
import { applySecurityHeaders, ifNoneMatchHits, json } from "@/server/http";
import { isFileAllowedForUser } from "@/server/playback/access";
import { getTrickplayForFile } from "@/server/library/trickplay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ fileId: string }>;
}

// mtime-keyed, not content-addressed: a replaced file reuses the same URL, so
// the browser must revalidate — the ETag makes that a cheap 304.
const CACHE_CONTROL = "private, max-age=3600";

export async function GET(request: Request, context: Ctx) {
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const { fileId: raw } = await context.params;
  const fileId = Number.parseInt(raw, 10);
  if (!Number.isInteger(fileId) || fileId <= 0) return json({ error: "Fichier introuvable" }, { status: 404 });

  // Kids gate — byte-identical to the "not generated / unknown id" 404 below.
  if (!isFileAllowedForUser(user, fileId)) return json({ error: "Fichier introuvable" }, { status: 404 });

  const trickplay = getTrickplayForFile(fileId);
  if (!trickplay) return json({ error: "Fichier introuvable" }, { status: 404 });

  const wantsSprite = new URL(request.url).searchParams.get("sprite") === "1";
  const etag = `"tp-${fileId}-${trickplay.mtime}-${wantsSprite ? "sprite" : "meta"}"`;
  if (ifNoneMatchHits(request.headers.get("if-none-match"), etag)) {
    return applySecurityHeaders(new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": CACHE_CONTROL } }));
  }

  if (!wantsSprite) {
    const res = json(trickplay.meta);
    res.headers.set("Cache-Control", CACHE_CONTROL);
    res.headers.set("ETag", etag);
    return res;
  }

  let sprite: Buffer;
  try {
    sprite = await readFile(trickplay.spritePath);
  } catch {
    // vanished between the metadata check and the read (cache pruned mid-request)
    return json({ error: "Fichier introuvable" }, { status: 404 });
  }
  const res = new NextResponse(sprite as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(sprite.length),
      "Cache-Control": CACHE_CONTROL,
      ETag: etag,
    },
  });
  return applySecurityHeaders(res);
}
