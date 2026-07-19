// Personalised Home feed: billboard pick + ordered, ranked rows, plus a
// match-% map for every scored item so Card.tsx can show a badge on ANY
// card, not just the ones inside a recommendation row. Read-only — the
// taste signals themselves are written through /api/state (my list, rating,
// watch event), which calls invalidateReco() on write; see userState.ts.

import { getRequestUser } from "@/server/auth";
import { json, privateNoCache } from "@/server/http";
import { matchPercent } from "@/lib/flix/reco";
import { becauseYouWatched, discover, genreRows, pickBillboard, recommend, scoreAll, topTen } from "@/server/reco/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ItemRef {
  type: "movie" | "show";
  id: number;
}

interface RecoRow {
  id: string;
  title: string;
  items: ItemRef[];
}

function toRef(ref: { type: "movie" | "show"; id: number }): ItemRef {
  return { type: ref.type, id: ref.id };
}

export async function GET(request: Request) {
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  const isKids = user.is_kids === 1;

  const rows: RecoRow[] = [];

  const top10Movies = topTen("movie", isKids);
  if (top10Movies.length) rows.push({ id: "top10-movies", title: "Top 10 des films", items: top10Movies.map(toRef) });

  const top10Shows = topTen("show", isKids);
  if (top10Shows.length) rows.push({ id: "top10-shows", title: "Top 10 des séries", items: top10Shows.map(toRef) });

  const forYou = recommend(user.id, isKids);
  if (forYou.length) rows.push({ id: "for-you", title: "Notre sélection pour vous", items: forYou.map(toRef) });

  for (const because of becauseYouWatched(user.id, isKids)) {
    rows.push({
      id: `because-${because.seedType}-${because.seedId}`,
      title: `Parce que vous avez regardé ${because.seedTitle}`,
      items: because.items.map(toRef),
    });
  }

  for (const genre of genreRows(user.id, isKids)) {
    rows.push({ id: `genre-${genre.genre}`, title: genre.genre, items: genre.items.map(toRef) });
  }

  const discovered = discover(user.id, isKids);
  if (discovered.length) rows.push({ id: "discover", title: "À découvrir", items: discovered.map(toRef) });

  const billboard = pickBillboard(user.id, isKids);
  const matchScores: Record<string, number> = {};
  for (const [key, score] of scoreAll(user.id, isKids)) matchScores[key] = matchPercent(score);

  return privateNoCache(
    json({
      billboard: billboard ? { type: billboard.type, id: billboard.id } : null,
      rows,
      matchScores,
    }),
  );
}
