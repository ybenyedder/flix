// DELETE /api/arr/requests/<id> — drop a request row. Admin may remove any;
// the requester may remove their own until it becomes available. The
// Radarr/Sonarr entity is intentionally left in place (documented).

import { checkCsrf, json } from "@/server/http";
import { getRequestUser } from "@/server/auth";
import { deleteRequest } from "@/server/arr/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: Request, context: Ctx) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  // Same kids gate as the sibling arr routes (a kids profile has no requests
  // UI at all). Deliberately NOT gated on isArrEnabled(): deleting a stale
  // request row is DB-only — no arr I/O — and must stay possible after the
  // operator turns the feature off, or old rows could never be cleaned up.
  if (user.is_kids === 1) return json({ error: "Indisponible" }, { status: 403 });

  const { id: idRaw } = await context.params;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "Demande introuvable" }, { status: 404 });

  const result = deleteRequest(id, { id: user.id, isAdmin: user.is_admin === 1 });
  if (!result.ok) return json({ error: result.error }, { status: result.status ?? 400 });
  return json({ ok: true });
}
