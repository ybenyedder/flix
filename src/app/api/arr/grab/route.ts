// POST /api/arr/grab — grab the specific release the user picked in the version
// picker (language → quality), then track it like any request. Authenticated
// non-kids; rate-limited per user (shares the request budgets' spirit).

import { checkAuth, checkCsrf, readJsonBody, json, noStore } from "@/server/http";
import { getRequestUser } from "@/server/auth";
import { rateLimitWindow } from "@/server/rateLimit";
import { isArrEnabled } from "@/server/arr/config";
import { grabChosenRelease } from "@/server/arr/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = checkAuth(request);
  if (denied) return denied;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  if (user.is_kids === 1) return json({ error: "Indisponible" }, { status: 403 });
  if (!isArrEnabled()) return json({ error: "Téléchargements automatiques désactivés" }, { status: 400 });

  if (rateLimitWindow(`arr-req:${user.id}`, 5, 10 * 60_000) || rateLimitWindow(`arr-req-day:${user.id}`, 20, 24 * 60 * 60_000)) {
    return json({ error: "Limite de demandes atteinte, réessayez plus tard" }, { status: 429 });
  }

  const parsed = await readJsonBody<{ tmdbId?: unknown; arrId?: unknown; guid?: unknown; indexerId?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const { tmdbId, arrId, guid, indexerId } = parsed.body;

  const result = await grabChosenRelease(user.id, {
    tmdbId: typeof tmdbId === "number" ? tmdbId : NaN,
    arrId: typeof arrId === "number" ? arrId : NaN,
    guid: typeof guid === "string" ? guid : "",
    indexerId: typeof indexerId === "number" ? indexerId : NaN,
  });
  if (!result.ok) return json({ error: result.error }, { status: result.status ?? 400 });
  return noStore(json({ request: result.request }));
}
