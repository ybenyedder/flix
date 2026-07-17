// Serves cached posters/backdrops/thumbs/logos by content hash, optionally
// resized to a fixed width bucket (?w=240|480|960|1440). Content-addressed, so
// the hash IS the cache validator: responses are immutable forever and a
// revalidation is answered with a cheap 304. Requires authentication (session
// cookie, bearer, or ?token=) — image URLs can carry a ?token= for clients that
// can't attach headers (e.g. native <img>/ExoPlayer artwork on Android).
// Model: /home/pc/Documents/auralis_enterprise_grade/src/app/api/art/[hash]/route.ts

import { readImageVariant, readCachedImage } from "@/server/library/images";
import { applySecurityHeaders, checkAuth, ifNoneMatchHits } from "@/server/http";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ hash: string }>;
}

const HASH_RE = /^[a-f0-9]{40}$/;

export async function GET(request: Request, context: Ctx) {
  const denied = checkAuth(request);
  if (denied) return denied;

  const { hash } = await context.params;
  if (!HASH_RE.test(hash)) return applySecurityHeaders(new NextResponse("Not Found", { status: 404 }));

  const sizeRaw = new URL(request.url).searchParams.get("w");
  const size = sizeRaw ? Number.parseInt(sizeRaw, 10) : 0;

  const etag = `"${hash}-${size || 0}"`;
  // `private`, not `public`: the route requires auth, so a shared proxy cache
  // must never serve one user's fetched artwork to the next anonymous client.
  // The browser cache still keeps it forever (content-addressed → immutable).
  const cacheControl = "private, max-age=31536000, immutable";
  if (ifNoneMatchHits(request.headers.get("if-none-match"), etag)) {
    return applySecurityHeaders(new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } }));
  }

  const image = size > 0 ? await readImageVariant(hash, size) : await readCachedImage(hash);
  if (!image) return applySecurityHeaders(new NextResponse("Not Found", { status: 404 }));

  const res = new NextResponse(image.buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.buffer.length),
      "Cache-Control": cacheControl,
      ETag: etag,
    },
  });
  return applySecurityHeaders(res);
}
