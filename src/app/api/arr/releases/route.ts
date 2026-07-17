// POST   /api/arr/releases — probe what's actually available for a movie
//                            (adds it to Radarr if needed + interactive search).
// DELETE /api/arr/releases — clean up a browse that added a movie but didn't grab.
// Both authenticated non-kids; POST is rate-limited (the search is expensive).

import { checkAuth, checkCsrf, readJsonBody, json, noStore } from "@/server/http";
import { getRequestUser } from "@/server/auth";
import { rateLimitWindow } from "@/server/rateLimit";
import { isArrEnabled } from "@/server/arr/config";
import { getReleaseOptions, cancelReleaseBrowse } from "@/server/arr/requests";

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

  // The interactive search fans out over every indexer — cap it per user.
  if (rateLimitWindow(`arr-releases:${user.id}`, 10, 5 * 60_000)) {
    return json({ error: "Trop de recherches de versions, réessayez dans un instant" }, { status: 429 });
  }

  const parsed = await readJsonBody<{ tmdbId?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const tmdbId = typeof parsed.body.tmdbId === "number" ? parsed.body.tmdbId : NaN;

  const result = await getReleaseOptions(tmdbId);
  if (!result.ok) return json({ error: result.error }, { status: result.status ?? 400 });
  return noStore(json({ options: result.options }));
}

export async function DELETE(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = checkAuth(request);
  if (denied) return denied;
  const user = getRequestUser(request);
  if (!user || user.is_kids === 1) return json({ error: "Indisponible" }, { status: 403 });

  // arrId/wasAdded ride the query string (DELETE has no JSON body helper client-side).
  const params = new URL(request.url).searchParams;
  const arrId = Number(params.get("arrId"));
  const wasAdded = params.get("wasAdded") === "1";

  await cancelReleaseBrowse({ arrId: Number.isFinite(arrId) ? arrId : NaN, wasAdded });
  return noStore(json({ ok: true }));
}
