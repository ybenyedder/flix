// GET  /api/arr/requests — list the household's requests (any non-kids profile).
// POST /api/arr/requests — create one from an external {mediaType, tmdbId|tvdbId}.
// Rate-limited per user; CSRF-guarded like every cookie-authed mutation.

import { checkAuth, checkCsrf, readJsonBody, json, noStore } from "@/server/http";
import { getRequestUser } from "@/server/auth";
import { rateLimitWindow } from "@/server/rateLimit";
import { isArrEnabled } from "@/server/arr/config";
import { listRequests, createRequest } from "@/server/arr/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = checkAuth(request);
  if (denied) return denied;
  const user = getRequestUser(request);
  if (user?.is_kids === 1) return json({ error: "Indisponible" }, { status: 403 });
  return noStore(json({ enabled: isArrEnabled(), requests: isArrEnabled() ? listRequests() : [] }));
}

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = checkAuth(request);
  if (denied) return denied;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  if (user.is_kids === 1) return json({ error: "Indisponible" }, { status: 403 });
  if (!isArrEnabled()) return json({ error: "Téléchargements automatiques désactivés" }, { status: 400 });

  // Two windows: a short burst cap and a daily cap, both per user.
  if (rateLimitWindow(`arr-req:${user.id}`, 5, 10 * 60_000) || rateLimitWindow(`arr-req-day:${user.id}`, 20, 24 * 60 * 60_000)) {
    return json({ error: "Limite de demandes atteinte, réessayez plus tard" }, { status: 429 });
  }

  const parsed = await readJsonBody<{ mediaType?: unknown; tmdbId?: unknown; tvdbId?: unknown; language?: unknown; quality?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const { mediaType, tmdbId, tvdbId, language, quality } = parsed.body;
  if (mediaType !== "movie" && mediaType !== "show") return json({ error: "Type invalide" }, { status: 400 });
  // Movies only; anything unrecognised (or a show) falls back to the default search.
  const lang = language === "fr" || language === "vo" ? language : "any";
  const qual = quality === "2160p" || quality === "1080p" || quality === "720p" || quality === "sd" ? quality : "any";

  const result = await createRequest(user.id, {
    mediaType,
    tmdbId: typeof tmdbId === "number" ? tmdbId : undefined,
    tvdbId: typeof tvdbId === "number" ? tvdbId : undefined,
    language: lang,
    quality: qual,
  });
  if (!result.ok) return json({ error: result.error }, { status: result.status ?? 400 });
  return noStore(json({ request: result.request }));
}
