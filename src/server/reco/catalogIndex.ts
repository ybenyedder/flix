// ============================================================================
// Catalogue feature index — the user-independent half of the taste engine.
// Turns the library snapshot (+ episode durations) into a keyed map of scored
// candidates, each with its precomputed ContentFeatures. Pure builder: the
// actual rebuild-on-snapshot-version cache lives in engine.ts, which owns the
// module-level state.
// ============================================================================

import { getDb } from "../db";
import { getSnapshot } from "../library/repository";
import { buildFeatures, type ContentFeatures } from "@/lib/flix/reco";

export type ItemType = "movie" | "show";

export interface ItemRow {
  key: string;
  type: ItemType;
  id: number;
  title: string;
  genres: string[];
  contentRating: string | null;
  addedAt: number;
  features: ContentFeatures;
}

export function buildCatalogIndex(): Map<string, ItemRow> {
  const db = getDb();
  const snapshot = getSnapshot();

  const showDuration = new Map<number, number>();
  for (const row of db
    .prepare("SELECT show_id, AVG(duration) AS avg_duration FROM episodes WHERE duration > 0 GROUP BY show_id")
    .all() as { show_id: number; avg_duration: number }[]) {
    showDuration.set(row.show_id, row.avg_duration);
  }

  const items = new Map<string, ItemRow>();
  for (const m of snapshot.movies) {
    const key = `movie:${m.id}`;
    const people = [...m.actors.map((a) => a.name), ...m.directors];
    items.set(key, {
      key,
      type: "movie",
      id: m.id,
      title: m.title,
      genres: m.genres,
      contentRating: m.contentRating,
      addedAt: m.addedAt,
      features: buildFeatures({ type: "movie", genres: m.genres, year: m.year, durationSeconds: m.duration || null, people, studio: m.studio }),
    });
  }
  for (const s of snapshot.shows) {
    const key = `show:${s.id}`;
    const people = s.actors.map((a) => a.name);
    items.set(key, {
      key,
      type: "show",
      id: s.id,
      title: s.title,
      genres: s.genres,
      contentRating: s.contentRating,
      addedAt: s.addedAt,
      features: buildFeatures({ type: "show", genres: s.genres, year: s.year, durationSeconds: showDuration.get(s.id) ?? null, people, studio: s.studio }),
    });
  }
  return items;
}
