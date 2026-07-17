// Public list of profiles so the "Qui est-ce ?" screen can offer a picker (the
// user selects who they are instead of typing it). Self-hosted LAN app: exposing
// username/avatar/kids-flag (no hashes) before login is an acceptable trade.
import { listUsers } from "@/server/auth";
import { json } from "@/server/http";
import { clientKey, rateLimitWindow } from "@/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Unauthenticated endpoint that hands out the exact username list the login
// brute-force path needs — throttle it. The picker loads this once per visit,
// so the window is generous for humans and useless for scripted harvesting.
const ACCOUNTS_MAX_PER_WINDOW = 30;
const ACCOUNTS_WINDOW_MS = 60_000;

export async function GET(request: Request) {
  if (rateLimitWindow(clientKey(request, "accounts"), ACCOUNTS_MAX_PER_WINDOW, ACCOUNTS_WINDOW_MS)) {
    return json(
      { error: "Trop de requêtes. Réessayez dans un instant." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(ACCOUNTS_WINDOW_MS / 1000)) } },
    );
  }
  return json({
    profiles: listUsers().map((u) => ({ username: u.username, avatar: u.avatar, isKids: u.is_kids === 1 })),
  });
}
