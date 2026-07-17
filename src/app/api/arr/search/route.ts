// GET /api/arr/search?q= — external discovery for titles not in the library.
// Authenticated non-kids only; rate-limited per user. Returns [] (never an error)
// when the feature is off or a lookup service is unreachable, so the discover
// section degrades quietly under the main library search.

import { checkAuth, json, noStore } from "@/server/http";
import { getRequestUser } from "@/server/auth";
import { rateLimitWindow } from "@/server/rateLimit";
import { isArrEnabled } from "@/server/arr/config";
import { discover } from "@/server/arr/discover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = checkAuth(request);
  if (denied) return denied;
  const user = getRequestUser(request);
  if (user?.is_kids === 1) return json({ error: "Indisponible" }, { status: 403 });

  if (!isArrEnabled()) return noStore(json({ enabled: false, results: [] }));

  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return noStore(json({ enabled: true, results: [] }));

  if (rateLimitWindow(`arr-search:${user?.id ?? "?"}`, 30, 60_000)) {
    return json({ error: "Trop de recherches, réessayez dans un instant" }, { status: 429 });
  }

  try {
    const results = await discover(q);
    return noStore(json({ enabled: true, results }));
  } catch {
    return noStore(json({ enabled: true, results: [] }));
  }
}
