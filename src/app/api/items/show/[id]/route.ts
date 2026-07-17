// Show detail: metadata + seasons + episodes + their media files/streams, for
// DetailModal's season selector / EpisodeRow list. Same kids gating as the
// movie detail route.

import { getShowDetail } from "@/server/library/repository";
import { getRequestUser } from "@/server/auth";
import { json } from "@/server/http";
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

  const show = getShowDetail(id);
  if (!show) return json({ error: "Série introuvable" }, { status: 404 });
  if (user.is_kids === 1 && !isAllowedForKids(show.contentRating)) {
    return json({ error: "Série introuvable" }, { status: 404 });
  }
  return json(show);
}
