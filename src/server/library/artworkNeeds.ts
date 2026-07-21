// Shared "which artwork slots want replacing" logic for the two enrichment
// passes (arr MediaCover and online providers). Pure + DB-read only, so both
// passes agree byte-for-byte on what is replaceable: empty slots and
// frame-generated images — never sidecar/embedded art a user shipped, never
// art a previous enrichment already fetched.

import type { getDb } from "../db";

export interface ArtRow {
  id: number;
  poster_hash: string | null;
  poster_source: string | null;
  backdrop_hash: string | null;
  backdrop_source: string | null;
  logo_hash: string | null;
}

export interface ArtNeeds {
  poster: boolean;
  backdrop: boolean;
  logo: boolean;
}

/** A slot wants enrichment when it's empty or holds a frame-extract. Sidecar,
 *  embedded, arr and online art are all left alone. Logos are only ever
 *  filled, never replaced — the scanner never generates one. */
export function computeNeeds(row: ArtRow): ArtNeeds {
  const wants = (hash: string | null, source: string | null) => hash === null || source === "generated";
  return {
    poster: wants(row.poster_hash, row.poster_source),
    backdrop: wants(row.backdrop_hash, row.backdrop_source),
    logo: row.logo_hash === null,
  };
}

export function hasAnyNeed(needs: ArtNeeds): boolean {
  return needs.poster || needs.backdrop || needs.logo;
}

export interface ArtTargetRow extends ArtRow {
  title: string;
  year: number | null;
}

/** All rows of a table still wanting art, with title/year for provider
 *  matching, keyed by library id. */
export function listTargets(db: ReturnType<typeof getDb>, table: "movies" | "shows"): Map<number, { needs: ArtNeeds; title: string; year: number | null }> {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.year, t.poster_hash, pi.source AS poster_source,
              t.backdrop_hash, bi.source AS backdrop_source, t.logo_hash
       FROM ${table} t
       LEFT JOIN images pi ON pi.hash = t.poster_hash
       LEFT JOIN images bi ON bi.hash = t.backdrop_hash`,
    )
    .all() as ArtTargetRow[];
  const map = new Map<number, { needs: ArtNeeds; title: string; year: number | null }>();
  for (const row of rows) {
    const needs = computeNeeds(row);
    if (hasAnyNeed(needs)) map.set(row.id, { needs, title: row.title, year: row.year });
  }
  return map;
}
