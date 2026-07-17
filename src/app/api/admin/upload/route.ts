// Admin chunked-upload control endpoint.
//   GET  → capability probe + the list of in-flight sessions.
//   POST → open a new upload session for a movie or TV episode.
// Admin-only: an upload writes arbitrary bytes into the media library, so this
// must never be reachable by a non-admin (mirrors /api/library/source).

import { requireAdmin, checkCsrf, readJsonBody, json } from "@/server/http";
import { checkUploadCapability, listUploads, initUpload, type UploadDestination } from "@/server/upload/manager";
import { mapUploadError } from "./uploadError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const cap = await checkUploadCapability();
  return json({ writable: cap.writable, freeBytes: cap.freeBytes, chunkSize: cap.chunkSize, sessions: listUploads() });
}

interface InitBody {
  filename?: unknown;
  size?: unknown;
  destination?: unknown;
  conflict?: unknown;
}

function toYear(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseDestination(raw: unknown): UploadDestination | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.kind === "movie") {
    if (typeof d.title !== "string" || !d.title.trim()) return null;
    return { kind: "movie", title: d.title, year: toYear(d.year) };
  }
  if (d.kind === "episode") {
    if (typeof d.show !== "string" || !d.show.trim()) return null;
    const season = Number(d.season);
    if (!Number.isInteger(season) || season < 0) return null;
    return { kind: "episode", show: d.show, showYear: toYear(d.showYear), season };
  }
  return null;
}

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = requireAdmin(request);
  if (denied) return denied;

  const parsed = await readJsonBody<InitBody>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const destination = parseDestination(body.destination);
  if (!destination) return json({ error: "Destination invalide" }, { status: 400 });

  const filename = typeof body.filename === "string" ? body.filename : "";
  const size = typeof body.size === "number" ? body.size : Number(body.size);
  const conflict = body.conflict === "rename" ? "rename" : body.conflict === "reject" ? "reject" : undefined;

  try {
    const result = await initUpload({ filename, size, destination, conflict });
    return json(result, { status: 201 });
  } catch (err) {
    return mapUploadError(err);
  }
}
