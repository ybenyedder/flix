// Lightweight in-memory rate limiter for the single-process self-hosted server.
// Used to blunt credential brute-force on the login route: after a burst of
// failures from the same key (IP + username), requests are rejected with an
// increasing cool-down. State is per-process and resets on restart — sufficient
// for a LAN/home server; a multi-worker deployment would move this to the DB.

interface Bucket {
  fails: number;
  blockedUntil: number;
}

const buckets = new Map<string, Bucket>();
const MAX_FAILS = 5; // free attempts before back-off kicks in
const BASE_COOLDOWN_MS = 5_000; // doubles per failure past the threshold, capped
const MAX_COOLDOWN_MS = 15 * 60_000; // 15 min ceiling
const SWEEP_AFTER_MS = 30 * 60_000; // forget idle buckets

function sweep(now: number) {
  for (const [key, b] of buckets) {
    if (b.blockedUntil < now && now - b.blockedUntil > SWEEP_AFTER_MS) buckets.delete(key);
  }
}

/** Returns the remaining cool-down in ms (>0 means the caller must reject). */
export function rateLimitCheck(key: string): number {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b) return 0;
  return b.blockedUntil > now ? b.blockedUntil - now : 0;
}

/** Record a failed attempt and arm/extend the cool-down once over the threshold. */
export function rateLimitFail(key: string): void {
  const now = Date.now();
  if (buckets.size > 5_000) sweep(now); // bound memory under abuse
  const b = buckets.get(key) ?? { fails: 0, blockedUntil: 0 };
  b.fails += 1;
  if (b.fails > MAX_FAILS) {
    const over = b.fails - MAX_FAILS;
    const cooldown = Math.min(BASE_COOLDOWN_MS * 2 ** (over - 1), MAX_COOLDOWN_MS);
    b.blockedUntil = now + cooldown;
  }
  buckets.set(key, b);
}

/** Clear the bucket after a successful auth. */
export function rateLimitReset(key: string): void {
  buckets.delete(key);
}

// --- Sliding-window limiter (for throttling background/CPU-heavy work) ---
const windows = new Map<string, number[]>();

/** Record a hit for `key`; returns true when it EXCEEDS `max` within `windowMs`
 *  (i.e. the caller should reject with 429). In-memory, per-process. */
export function rateLimitWindow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.push(now);
  // Only the newest max+1 timestamps can ever change the verdict (the dropped
  // ones are older, so they expire first) — without this cap a sustained flood
  // on one key grows the array unboundedly and re-filters it on every hit
  // (quadratic work).
  if (hits.length > max + 1) hits.splice(0, hits.length - (max + 1));
  windows.set(key, hits);
  if (windows.size > 5_000) {
    for (const [k, v] of windows) {
      if (v.every((t) => now - t >= windowMs)) windows.delete(k);
    }
  }
  return hits.length > max;
}

/** Best-effort client IP from common proxy headers, falling back to a constant.
 *  X-Forwarded-For / X-Real-IP are CLIENT-CONTROLLED and trivially spoofable, so we
 *  only honour them when the operator explicitly declares a trusted reverse proxy
 *  (FLIX_TRUST_PROXY=1). Otherwise every request collapses to the "local" bucket,
 *  so an attacker can't mint a fresh bucket per forged header to bypass the limit. */
export function clientKey(request: Request, suffix = ""): string {
  let ip = "local";
  if (process.env.FLIX_TRUST_PROXY === "1") {
    const xff = request.headers.get("x-forwarded-for");
    // Take the RIGHTMOST entry: a trusted reverse proxy APPENDS the real client
    // IP as the last hop, so anything to the left of it is client-supplied and
    // spoofable. Reading [0] would trust the attacker-controlled leftmost value.
    const parts = xff ? xff.split(",") : null;
    ip = (parts ? parts[parts.length - 1] : null)?.trim() || request.headers.get("x-real-ip") || "local";
  }
  return `${ip}:${suffix}`;
}

/** IP-independent key so a single account can't be brute-forced by rotating the
 *  source IP (real or spoofed). Used alongside clientKey as a second, global cap. */
export function usernameKey(username: string): string {
  return `user:${username}`;
}
