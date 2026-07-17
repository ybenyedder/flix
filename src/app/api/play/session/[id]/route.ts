// DELETE /api/play/session/<id> — end a playback session early (tab closed,
// user pressed stop, switching video). Ownership-checked: only the user who
// created a session may tear it down.

import { getRequestUser } from "@/server/auth";
import { checkCsrf, json } from "@/server/http";
import { destroySession } from "@/server/playback/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

const SESSION_ID_RE = /^[0-9a-f-]{36}$/i;

export async function DELETE(request: Request, context: Ctx) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  // Never distinguish "doesn't exist" from "not yours" — both surface as the
  // same 404 so a probing client can't enumerate other users' session ids.
  if (!SESSION_ID_RE.test(id) || !destroySession(id, user.id)) {
    return json({ error: "Session introuvable" }, { status: 404 });
  }
  return json({ ok: true });
}
