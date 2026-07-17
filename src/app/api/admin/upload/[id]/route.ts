// Per-session chunked-upload endpoint.
//   GET    → resume point { uploadId, received, size, targetRel } (404 if unknown).
//   PUT    → stream one chunk at ?offset= into the session (409 + received on mismatch).
//   DELETE → abort and remove the session.
// Admin-only on every verb.

import { NextResponse } from "next/server";
import { requireAdmin, checkCsrf, json, applySecurityHeaders } from "@/server/http";
import { getUploadStatus, appendChunk, abortUpload } from "@/server/upload/manager";
import { mapUploadError } from "../uploadError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: Ctx) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await context.params;
  const status = getUploadStatus(id);
  if (!status) return json({ error: "Session de téléversement introuvable" }, { status: 404 });
  return json(status);
}

export async function PUT(request: Request, context: Ctx) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;
  const offset = Number(new URL(request.url).searchParams.get("offset"));
  if (!Number.isInteger(offset) || offset < 0) return json({ error: "Décalage invalide" }, { status: 400 });

  try {
    const result = await appendChunk(id, offset, request.body);
    return json(result);
  } catch (err) {
    return mapUploadError(err);
  }
}

export async function DELETE(request: Request, context: Ctx) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;
  await abortUpload(id);
  return applySecurityHeaders(new NextResponse(null, { status: 204 }));
}
