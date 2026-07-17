// Session-token concerns extracted from auth.ts (which stays the public façade).
// Pure, DB-free helpers: HMAC-signed token encode/decode (constant-time
// signature check), cookie / bearer extraction, and the constant-time match for
// the static FLIX_TOKEN. The signing SECRET and its per-DB-connection
// memoisation stay in auth.ts and are injected here as a `sign` callback, so
// this module never depends on the DB connection identity (which is what keys
// the secret/seed memoisation and must not move).

import crypto from "crypto";

export const COOKIE_NAME = "flix_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Signs a payload string with the server secret (HMAC-SHA256, base64url). */
export type SignFn = (data: string) => string;

/** Constant-time string equality — closes the last `===` secret comparison on
 *  the static FLIX_TOKEN bearer so timing can't leak it. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** True when the presented bearer/query token matches the static FLIX_TOKEN
 *  in constant time (short-circuits safely when either side is absent). */
export function matchesAuthToken(authToken: string, bearer: string | null, queryToken: string | null): boolean {
  return (bearer !== null && timingSafeEqualStr(bearer, authToken)) || (queryToken !== null && timingSafeEqualStr(queryToken, authToken));
}

/** Build a signed session token carrying the user id and token version. */
export function encodeSessionToken(userId: number, tokenVersion: number, sign: SignFn): string {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, tv: tokenVersion, exp: Date.now() + SESSION_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Verify a session token and return { uid, tv } it carries, or null. */
export function decodeSessionToken(token: string | undefined | null, sign: SignFn): { uid: number; tv: number } | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp, tv } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { uid?: number; exp: number; tv?: number };
    if (typeof exp !== "number" || Date.now() >= exp || typeof uid !== "number") return null;
    return { uid, tv: typeof tv === "number" ? tv : 0 };
  } catch {
    return null;
  }
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      const raw = part.slice(idx + 1).trim();
      // A malformed %-escape must not throw: the URIError would bubble out of
      // every authenticated route as a 500 (instead of a clean 401), and a
      // client stuck with such a cookie could never recover by re-logging.
      // Fall back to the raw value — token verification simply rejects it.
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/** Bearer token from the Authorization header (case-insensitive "Bearer "), or null. */
export function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  return header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
}
