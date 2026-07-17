// GET /api/play/session/<id>/{stream.m3u8,init.mp4,segNNNNN.m4s} — serves the
// HLS assets for a live remux/transcode session. Every request is scoped to
// its OWNER (a session id alone is not enough — it must belong to the
// requesting user) and every filename is checked against a strict allowlist
// before ever touching the filesystem, so this route can never be used to
// read anything outside that one session's own directory.

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { getRequestUser } from "@/server/auth";
import { getOwnedSession, getSessionAsset, SEGMENT_NAME_RE } from "@/server/playback/sessions";
import { openWebFileStream } from "@/server/playback/streamUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; file: string[] }>;
}

const SESSION_ID_RE = /^[0-9a-f-]{36}$/i;

function contentTypeForAsset(filename: string): string {
  if (filename === "init.mp4") return "video/mp4";
  if (filename.endsWith(".m4s")) return "video/iso.segment";
  return "application/octet-stream";
}

export async function GET(request: NextRequest, context: Ctx) {
  const user = getRequestUser(request);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id, file } = await context.params;
  const filename = file.join("/");
  // Same "don't distinguish missing vs. foreign" rule as the DELETE route —
  // an invalid id, an unowned session and a bad filename all read as 404.
  if (!SESSION_ID_RE.test(id) || file.length !== 1 || !SEGMENT_NAME_RE.test(filename)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const session = getOwnedSession(id, user.id);
  if (!session) return new NextResponse("Not Found", { status: 404 });

  const asset = await getSessionAsset(session, filename);
  if (asset.kind === "not-found") return new NextResponse("Not Found", { status: 404 });
  if (asset.kind === "timeout") return new NextResponse("Gateway Timeout", { status: 504 });

  if (asset.kind === "playlist") {
    return new NextResponse(asset.body, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  let stat;
  try {
    stat = await fs.promises.stat(asset.path);
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
  // openWebFileStream (rather than a lazy fs.createReadStream) so a session
  // purged between the stat above and the first read surfaces as a clean 404
  // — and its no-op error listener keeps a client abort mid-segment from
  // becoming an uncaught stream exception (see streamUtil).
  const stream = await openWebFileStream(asset.path);
  if (!stream) return new NextResponse("Not Found", { status: 404 });
  return new NextResponse(stream as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentTypeForAsset(filename),
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
