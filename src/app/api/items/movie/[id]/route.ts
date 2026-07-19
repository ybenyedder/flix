// Movie detail: full metadata + media files + streams/subtitle tracks, for
// DetailModal. Kids profiles get a 404 (not a 403) for anything their content
// rating gate rejects, so the endpoint never confirms an adult title exists.

import { getMovieDetail } from "@/server/library/repository";
import { getRequestUser } from "@/server/auth";
import { json, privateNoCache } from "@/server/http";
import { isAllowedForKids } from "@/lib/flix/kids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: Ctx) {
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const { id: idParam } = await context.params;
  const id = Number.parseInt(idParam, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "Identifiant invalide" }, { status: 400 });

  const movie = getMovieDetail(id);
  if (!movie) return json({ error: "Film introuvable" }, { status: 404 });
  if (user.is_kids === 1 && !isAllowedForKids(movie.contentRating)) {
    return json({ error: "Film introuvable" }, { status: 404 });
  }
  return privateNoCache(json(movie));
}
