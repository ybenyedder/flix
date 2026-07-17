// Direct-play byte streaming, BY media_files.id (never by raw filesystem path —
// the id is looked up server-side and the resulting path re-validated through
// resolveRealLibraryPath, so a client never controls the path used for disk I/O).
// Full HTTP range support: 206 Partial Content, 416 Range Not Satisfiable, HEAD,
// and the `bytes=-500` (last-N-bytes) suffix form some players issue on load.
// Model: /home/pc/Documents/auralis_enterprise_grade/src/app/api/stream/[...path]/route.ts

import { NextRequest, NextResponse } from "next/server";
import { stat as fsStat } from "fs/promises";
import { getDb } from "@/server/db";
import { contentTypeFor, resolveRealLibraryPath } from "@/server/paths";
import { getRequestUser } from "@/server/auth";
import { json } from "@/server/http";
import { isFileAllowedForUser } from "@/server/playback/access";
import { openWebFileStream } from "@/server/playback/streamUtil";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

export type ParsedRange = { start: number; end: number } | "invalid" | null;

export function parseRange(rangeHeader: string | null, fileSize: number): ParsedRange {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    // A syntactically valid MULTIPART range (`bytes=0-99,200-299` — some
    // TV/UPnP players emit these). We don't serve multipart/byteranges, and
    // RFC 9110 lets a server ignore the Range header entirely (full 200) —
    // that, not a 416, is the conformant fallback for a well-formed request.
    if (/^bytes=\s*(?:\d+-\d*|-\d+)(?:\s*,\s*(?:\d+-\d*|-\d+))+\s*$/.test(rangeHeader)) return null;
    return "invalid";
  }

  const startRaw = match[1];
  const endRaw = match[2];
  if (!startRaw && !endRaw) return "invalid";

  let start: number;
  let end: number;
  if (!startRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "invalid";
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : fileSize - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= fileSize) {
    return "invalid";
  }
  return { start, end: Math.min(end, fileSize - 1) };
}

/** Whether an If-Range validator still matches the file on disk — i.e. the
 *  Range request may be honoured with a 206. media_files ids are STABLE across
 *  rescans, so a file replaced on disk keeps its URL: without this check a
 *  client resuming from cache could splice byte ranges of the new file into
 *  ranges of the old one. No If-Range at all means the Range stands on its
 *  own (per RFC 9110 the client accepts that risk). */
export function ifRangeAllowsPartial(ifRange: string | null, etag: string, mtimeMs: number): boolean {
  if (!ifRange) return true;
  const value = ifRange.trim();
  // An entity-tag form (RFC: only a strong ETag may match for ranges).
  if (value.startsWith('"') || value.startsWith("W/")) return value === etag;
  const since = Date.parse(value);
  if (!Number.isFinite(since)) return false;
  // HTTP dates carry second resolution — compare against the truncated mtime.
  return Math.floor(mtimeMs / 1000) * 1000 <= since;
}

function getFilepath(fileId: number): string | null {
  const row = getDb().prepare("SELECT filepath FROM media_files WHERE id = ?").get(fileId) as { filepath: string } | undefined;
  return row?.filepath ?? null;
}

async function streamVideo(request: NextRequest, context: RouteContext, headOnly: boolean) {
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const { fileId: fileIdRaw } = await context.params;
  const fileId = Number.parseInt(fileIdRaw, 10);
  if (!Number.isInteger(fileId) || fileId <= 0) return new NextResponse("Not Found", { status: 404 });

  // Kids gate — same 404 (never 403) as items/search, so an enumerable file
  // id never confirms an adult title exists.
  if (!isFileAllowedForUser(user, fileId)) return new NextResponse("Not Found", { status: 404 });

  const relativePath = getFilepath(fileId);
  if (!relativePath) return new NextResponse("Not Found", { status: 404 });

  // Re-resolve through realpath so a symlink inside the library that points outside
  // the media root can't be used to exfiltrate arbitrary files. A missing file or a
  // symlink that escapes the root both resolve to null here, surfacing as a 404.
  const filePath = await resolveRealLibraryPath(relativePath);
  if (!filePath) return new NextResponse("Not Found", { status: 404 });

  let stat;
  try {
    stat = await fsStat(filePath);
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
  if (!stat.isFile()) return new NextResponse("Not Found", { status: 404 });

  const fileSize = stat.size;
  const contentType = contentTypeFor(relativePath);
  // Cache validators derived from what actually identifies the bytes on disk
  // (size + mtime) — the id alone can't, since a rescan reuses it for a
  // replaced file.
  const etag = `"${fileSize.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  const lastModified = new Date(stat.mtimeMs).toUTCString();

  let range = parseRange(request.headers.get("range"), fileSize);

  if (range === "invalid") {
    return new NextResponse("Range Not Satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${fileSize}`, "Accept-Ranges": "bytes" },
    });
  }

  // A stale If-Range validator demotes the Range request to a full 200 of the
  // current file, so cached ranges of two file generations are never mixed.
  if (range && !ifRangeAllowsPartial(request.headers.get("if-range"), etag, stat.mtimeMs)) range = null;

  if (range) {
    const { start, end } = range;
    const chunkSize = end - start + 1;
    const stream = headOnly ? null : await openWebFileStream(filePath, { start, end });
    if (!headOnly && !stream) return new NextResponse("Not Found", { status: 404 });
    return new NextResponse(stream as BodyInit | null, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(chunkSize),
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
        ETag: etag,
        "Last-Modified": lastModified,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const stream = headOnly ? null : await openWebFileStream(filePath);
  if (!headOnly && !stream) return new NextResponse("Not Found", { status: 404 });
  return new NextResponse(stream as BodyInit | null, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(fileSize),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      ETag: etag,
      "Last-Modified": lastModified,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: NextRequest, context: RouteContext) {
  return streamVideo(request, context, false);
}

export async function HEAD(request: NextRequest, context: RouteContext) {
  return streamVideo(request, context, true);
}
