// Opt-in artwork enrichment (part of the *arr integration, same hard gate).
//
// The scanner's image pass can only synthesize posters/backdrops from video
// frames when no sidecar/embedded art ships with a file — functional, but a
// world away from real key art. Radarr/Sonarr already hold the real posters,
// fanart and clearlogos for everything they manage, served from their own
// MediaCover cache. This pass fetches THOSE — the request goes to the
// operator's *arr instance only; the TMDB `remoteUrl` variants are
// deliberately never used, keeping the zero-public-internet invariant.
//
// Priority order stays: sidecar > embedded > arr > generated. Only slots that
// are empty or frame-generated are replaced; art a user placed next to the
// file always wins, and "arr"-sourced art is never refetched on later passes.
//
// Chained after the image pass in scanner.ts (best-effort, single-flight,
// never throws) so it always sees freshly-extracted hashes, not a mid-pass DB.

import { getDb } from "../db";
import { createLogger } from "../logger";
import { isArrEnabled, getServiceConfig } from "./config";
import { arrFetch, type RadarrMovie, type SonarrSeries } from "./client";
import { fileBasename, findLibraryMovieId, findLibraryShowId } from "./libraryMatch";
import { cacheImageBuffer, type ImageKind } from "../library/images";

const log = createLogger("arr-artwork");

const COVER_TIMEOUT_MS = 15_000;
// A MediaCover poster is a few hundred KB; anything past this is not an image
// we want to buffer into memory.
const MAX_COVER_BYTES = 15 * 1024 * 1024;

// ---- pure helpers (unit-tested in test/arrArtwork.test.ts) ------------------

// Needs computation shared with the online-artwork pass — re-exported so
// existing consumers/tests keep their import path (house façade pattern).
import { computeNeeds, hasAnyNeed, listTargets as listNeedTargets, type ArtRow, type ArtNeeds } from "../library/artworkNeeds";
export { computeNeeds, hasAnyNeed };
export type { ArtRow, ArtNeeds };

export interface CoverImage {
  coverType?: string;
  remoteUrl?: string;
  url?: string;
}

/** The instance-local cover path for a type ("/MediaCover/12/poster.jpg…").
 *  `remoteUrl` (TMDB) is rejected on purpose — never the public internet. */
export function localCoverPath(images: CoverImage[] | undefined, coverType: string): string | null {
  const hit = images?.find((img) => img.coverType === coverType && typeof img.url === "string" && img.url.startsWith("/"));
  return hit?.url ?? null;
}

/** Join an instance base URL and a cover path, deduplicating the URL-base
 *  prefix Radarr/Sonarr fold into their image paths when configured under a
 *  sub-path (base http://host/radarr + cover /radarr/MediaCover/… must not
 *  double up). */
export function joinInstanceUrl(base: string, coverPath: string): string {
  const trimmed = base.replace(/\/+$/, "");
  let basePath = "";
  try {
    basePath = new URL(trimmed).pathname.replace(/\/+$/, "");
  } catch {
    /* malformed base — fall through to plain concat */
  }
  const relative = basePath && basePath !== "" && coverPath.startsWith(basePath + "/") ? coverPath.slice(basePath.length) : coverPath;
  return trimmed + relative;
}

// ---- effectful --------------------------------------------------------------

async function fetchCover(service: "radarr" | "sonarr", coverPath: string): Promise<Buffer | null> {
  const cfg = getServiceConfig(service);
  if (!cfg) return null;
  try {
    const res = await fetch(joinInstanceUrl(cfg.url, coverPath), {
      headers: { "X-Api-Key": cfg.apiKey },
      signal: AbortSignal.timeout(COVER_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_COVER_BYTES) return null;
    return buf;
  } catch {
    return null; // unreachable instance / timeout — enrichment is best-effort
  }
}

type Db = ReturnType<typeof getDb>;

function listTargets(db: Db, table: "movies" | "shows"): Map<number, ArtNeeds> {
  const map = new Map<number, ArtNeeds>();
  for (const [id, target] of listNeedTargets(db, table)) map.set(id, target.needs);
  return map;
}

/** Fetch + cache the wanted covers for one matched record; returns the column
 *  updates to apply ({} when nothing resolved). */
async function resolveArt(service: "radarr" | "sonarr", images: CoverImage[] | undefined, needs: ArtNeeds): Promise<Record<string, string>> {
  const slots: { need: boolean; coverType: string; kind: ImageKind; column: string }[] = [
    { need: needs.poster, coverType: "poster", kind: "poster", column: "poster_hash" },
    { need: needs.backdrop, coverType: "fanart", kind: "backdrop", column: "backdrop_hash" },
    { need: needs.logo, coverType: "clearlogo", kind: "logo", column: "logo_hash" },
  ];
  const updates: Record<string, string> = {};
  for (const slot of slots) {
    if (!slot.need) continue;
    const coverPath = localCoverPath(images, slot.coverType);
    if (!coverPath) continue;
    const buf = await fetchCover(service, coverPath);
    if (!buf) continue;
    const hash = await cacheImageBuffer(buf, slot.kind, "arr");
    if (hash) updates[slot.column] = hash;
  }
  return updates;
}

function applyUpdates(db: Db, table: "movies" | "shows", id: number, updates: Record<string, string>): void {
  const columns = Object.keys(updates);
  if (columns.length === 0) return;
  const assignments = columns.map((c) => `${c} = ?`).join(", ");
  db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`).run(...columns.map((c) => updates[c]), id);
}

let running = false;

/** Enrich frame-generated/missing artwork from the operator's Radarr/Sonarr.
 *  Single-flight, hard-gated on the arr feature flag, never throws. */
export async function runArtworkPass(): Promise<void> {
  if (running) return;
  if (!isArrEnabled()) return;
  running = true;
  try {
    const db = getDb();
    let updated = 0;

    if (getServiceConfig("radarr")) {
      const targets = listTargets(db, "movies");
      if (targets.size > 0) {
        const records = await arrFetch<RadarrMovie[]>("radarr", "/api/v3/movie", { timeoutMs: 30_000 }).catch(() => [] as RadarrMovie[]);
        for (const record of records) {
          const libraryId = findLibraryMovieId(db, {
            title: record.title ?? "",
            year: record.year ?? null,
            fileBasename: fileBasename(record.movieFile?.relativePath ?? record.movieFile?.path),
          });
          const needs = libraryId !== null ? targets.get(libraryId) : undefined;
          if (libraryId === null || !needs) continue;
          const updates = await resolveArt("radarr", record.images, needs);
          if (Object.keys(updates).length > 0) {
            applyUpdates(db, "movies", libraryId, updates);
            targets.delete(libraryId); // duplicate arr records must not re-resolve
            updated++;
          }
        }
      }
    }

    if (getServiceConfig("sonarr")) {
      const targets = listTargets(db, "shows");
      if (targets.size > 0) {
        const records = await arrFetch<SonarrSeries[]>("sonarr", "/api/v3/series", { timeoutMs: 30_000 }).catch(() => [] as SonarrSeries[]);
        for (const record of records) {
          const libraryId = findLibraryShowId(db, {
            title: record.title ?? "",
            year: record.year ?? null,
            fileBasename: null, // series match on title/year — episode paths don't identify the show folder reliably
          });
          const needs = libraryId !== null ? targets.get(libraryId) : undefined;
          if (libraryId === null || !needs) continue;
          const updates = await resolveArt("sonarr", record.images, needs);
          if (Object.keys(updates).length > 0) {
            applyUpdates(db, "shows", libraryId, updates);
            targets.delete(libraryId);
            updated++;
          }
        }
      }
    }

    if (updated > 0) {
      // Same stamp the image pass uses: rotating imagesAt is what invalidates
      // the catalogue snapshot cache so the new art reaches the next read.
      db.prepare("INSERT INTO settings (key, value) VALUES ('imagesAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now()));
      log.info("artwork pass complete", { updated });
    }
  } catch (error) {
    log.warn("artwork pass failed", { message: error instanceof Error ? error.message : "unknown" });
  } finally {
    running = false;
  }
}
