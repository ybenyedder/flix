// GET /api/subs/<subtitleId> — serves a subtitle track as WebVTT, extracting
// (embedded) or converting (external .srt/.ass/.ssa) lazily on first request.

import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth";
import { json } from "@/server/http";
import { rateLimitWindow } from "@/server/rateLimit";
import { isSubtitleAllowedForUser } from "@/server/playback/access";
import { getVttForSubtitle } from "@/server/playback/subtitles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

// A cache-miss on an embedded track spawns a full-file ffmpeg demux, so the
// request rate is capped — generous enough for a player loading a season's
// worth of tracks, far too low to fork-bomb the host. Keyed PER USER (the
// route is authenticated), not per IP: without FLIX_TRUST_PROXY every client
// behind a reverse proxy collapses onto one "local" IP bucket, and the whole
// household would trade 429s on each other's subtitles.
const SUBS_RATE_MAX = 60;
const SUBS_RATE_WINDOW_MS = 60_000;

export async function GET(request: Request, context: Ctx) {
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  if (rateLimitWindow(`user:${user.id}:subs`, SUBS_RATE_MAX, SUBS_RATE_WINDOW_MS)) {
    return new NextResponse("Too Many Requests", { status: 429, headers: { "Retry-After": "60" } });
  }

  const { id: idRaw } = await context.params;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isInteger(id) || id <= 0) return new NextResponse("Not Found", { status: 404 });

  // Kids gate — same 404 (never 403) as items/search, so an enumerable
  // subtitle id never confirms an adult title exists.
  if (!isSubtitleAllowedForUser(user, id)) return new NextResponse("Not Found", { status: 404 });

  const result = await getVttForSubtitle(id);
  if (!result) return new NextResponse("Not Found", { status: 404 });

  return new NextResponse(result.content, {
    status: 200,
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      // private: the response is per-profile (kids gate above) — a shared
      // proxy cache must never hand one profile's allowed copy to another.
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: `"${result.hash}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
