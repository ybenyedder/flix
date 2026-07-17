import { getRequestUser, createSessionToken } from "@/server/auth";
import { json, noStore } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = getRequestUser(request);
  // The body carries a freshly-minted session token → no-store, always.
  return noStore(json({
    authenticated: Boolean(user),
    // Only reveal account details to an authenticated session.
    defaultPassword: user ? user.is_default === 1 : false,
    username: user?.username ?? null,
    isAdmin: user ? user.is_admin === 1 : false,
    isKids: user ? user.is_kids === 1 : false,
    avatar: user?.avatar ?? null,
    // Re-issue a fresh session token so a cookie-authenticated client can persist
    // it in localStorage and present it on every request — this is what keeps
    // writes (my list, ratings, progress) working reliably across app restarts.
    token: user ? createSessionToken(user.id) : null,
  }));
}
