import { changePassword, getRequestUser, createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth";
import { json, noStore, checkCsrf, readJsonBody } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Two short passwords — anything past a few KiB is abuse.
const MAX_PASSWORD_BODY_BYTES = 4 * 1024;

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readJsonBody<{ currentPassword?: string; newPassword?: string }>(request, MAX_PASSWORD_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const result = changePassword(user.id, body.currentPassword ?? "", body.newPassword ?? "");
  if (!result.ok) return json({ error: result.error }, { status: 400 });

  // The change bumped token_version, invalidating every existing token (incl. this
  // device's). Re-issue a fresh one so the CURRENT session stays logged in while
  // OTHER devices are signed out. Cookie clients update transparently; token
  // clients (Android/desktop) read `token` from the body and re-store it —
  // hence no-store: a cached copy of this body would be a live credential.
  const token = createSessionToken(user.id);
  const res = noStore(json({ ok: true, token }));
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(request));
  return res;
}
