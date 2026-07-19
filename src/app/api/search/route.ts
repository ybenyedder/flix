import { search } from "@/server/library/repository";
import { getRequestUser } from "@/server/auth";
import { json, privateNoCache } from "@/server/http";
import { isAllowedForKids } from "@/lib/flix/kids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
  if (!q) return privateNoCache(json({ movies: [], shows: [], query: "" }));

  const results = search(q, limit);
  // Search results aren't the memoised /api/library snapshot (see
  // repository.ts's user-independence note) — filtering here doesn't touch
  // that cache, so kids gating is safe to apply per-request.
  if (user.is_kids === 1) {
    results.movies = results.movies.filter((m) => isAllowedForKids(m.contentRating));
    results.shows = results.shows.filter((s) => isAllowedForKids(s.contentRating));
  }
  return privateNoCache(json({ ...results, query: q }));
}
