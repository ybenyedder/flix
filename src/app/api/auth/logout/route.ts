import { SESSION_COOKIE, getRequestUser } from "@/server/auth";
import { json, checkCsrf } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Without this, a cross-site page could force-logout a visiting user
  // (e.g. <img src="/api/auth/logout">) since the cookie rides along.
  const csrf = checkCsrf(request);
  if (csrf) return csrf;

  // Best-effort: stop this user's own live ffmpeg session (if any) so signing
  // out doesn't leave it running unattended. Scoped to this user only (see
  // killSessionsForUser) and dynamically imported so the auth module never
  // takes a hard dependency on the playback subsystem.
  const user = getRequestUser(request);
  if (user) {
    void import("@/server/playback/sessions")
      .then((m) => m.killSessionsForUser(user.id))
      .catch(() => {});
  }

  const res = json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
