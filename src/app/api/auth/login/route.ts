import { verifyCredentials, createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth";
import { json, noStore, readJsonBody } from "@/server/http";
import { clientKey, usernameKey, rateLimitCheck, rateLimitFail, rateLimitReset, rateLimitWindow } from "@/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Credentials are two short strings — anything past a few KiB is abuse.
const MAX_LOGIN_BODY_BYTES = 4 * 1024;

export async function POST(request: Request) {
  // Unauthenticated endpoint — the size guard runs before anything else here,
  // ahead of even the rate limiter, since there's no session to key work off yet.
  const parsed = await readJsonBody<{ username?: string; password?: string }>(request, MAX_LOGIN_BODY_BYTES);
  if (!parsed.ok) return parsed.response;

  const username = (parsed.body.username ?? "").trim().toLowerCase();
  const password = parsed.body.password ?? "";
  if (!username) return json({ error: "Identifiant requis" }, { status: 400 });

  // Global unauthenticated-login throttle. On default (no-trusted-proxy)
  // installs the per-IP key collapses to "local", so neither bucket below caps
  // AGGREGATE load — an attacker can pin the event loop with a flood of scrypt
  // verifications. This window caps total unauthenticated scrypt work per window
  // regardless of source IP; the ceiling is generous enough to never bother a
  // real user but low enough to blunt a CPU-exhaustion flood before hashing.
  if (rateLimitWindow("global:login", 30, 10_000)) {
    return json(
      { error: "Trop de tentatives de connexion. Réessayez dans un instant." },
      { status: 429, headers: { "Retry-After": "10" } },
    );
  }

  // Brute-force guard: two independent buckets. `ipKey` (IP+username) blunts a
  // single source; `userKey` (username only) caps total failures for an account
  // regardless of source IP, so rotating/spoofing X-Forwarded-For can't bypass it.
  const ipKey = clientKey(request, username);
  const userKey = usernameKey(username);
  // Without FLIX_TRUST_PROXY the "IP" key collapses to `local:<username>` —
  // shared by EVERY client — so a hard pre-verify block on it would let any
  // one client lock every profile out in a loop: the exact DoS the soft
  // userKey path below was designed to avoid. Hard-block only when the key is
  // a genuine per-client IP; otherwise it gets the same verify-first
  // semantics as userKey (correct password goes through, failures keep
  // feeding the cooldown).
  const ipWait = rateLimitCheck(ipKey);
  const ipIsPerClient = !ipKey.startsWith("local:");
  if (ipIsPerClient && ipWait > 0) {
    return json(
      { error: `Trop de tentatives. Réessayez dans ${Math.ceil(ipWait / 1000)} s.` },
      { status: 429, headers: { "Retry-After": String(Math.ceil(ipWait / 1000)) } },
    );
  }

  // The username-only bucket is fed by ANYONE's failures (that's its point) —
  // which cuts the other way too: usernames are enumerable via the profile
  // picker, so treating its cooldown as a hard block would let any LAN client
  // lock every profile out in a loop. During that cooldown we therefore still
  // verify the credentials and let a CORRECT login through (resetting the
  // bucket); failures keep feeding it and keep being rejected. The IP bucket
  // above remains a hard block.
  const userWait = rateLimitCheck(userKey);

  const user = verifyCredentials(username, password);
  if (!user) {
    rateLimitFail(ipKey);
    rateLimitFail(userKey);
    const wait = Math.max(userWait, ipIsPerClient ? 0 : ipWait);
    if (wait > 0) {
      return json(
        { error: `Trop de tentatives. Réessayez dans ${Math.ceil(wait / 1000)} s.` },
        { status: 429, headers: { "Retry-After": String(Math.ceil(wait / 1000)) } },
      );
    }
    return json({ error: "Identifiant ou mot de passe incorrect" }, { status: 401 });
  }
  rateLimitReset(ipKey);
  rateLimitReset(userKey);

  const token = createSessionToken(user.id);
  // Return the token so the client can persist it (localStorage) and present it
  // as a bearer on later launches — this keeps WebView/native clients logged in
  // even when the session cookie is dropped on app restart. Token in the body →
  // the response must never be cached (no-store).
  const res = noStore(json({
    ok: true,
    defaultPassword: user.is_default === 1,
    username: user.username,
    isAdmin: user.is_admin === 1,
    isKids: user.is_kids === 1,
    avatar: user.avatar,
    token,
  }));
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(request));
  return res;
}
