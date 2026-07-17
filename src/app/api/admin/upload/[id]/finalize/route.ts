// POST /api/admin/upload/<id>/finalize — atomically move a fully-received
// upload into the library and kick a background rescan. Admin-only.

import { requireAdmin, checkCsrf, json } from "@/server/http";
import { finalizeUpload } from "@/server/upload/manager";
import { mapUploadError } from "../../uploadError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: Ctx) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;
  try {
    const result = await finalizeUpload(id);
    return json({ rel: result.rel, scan: "started" });
  } catch (err) {
    return mapUploadError(err);
  }
}
