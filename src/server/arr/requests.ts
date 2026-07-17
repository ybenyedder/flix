// Request lifecycle for the opt-in *arr integration: turn a user's "Demander"
// into a Radarr/Sonarr add, persist it in `arr_requests`, and reconcile its
// status against the download queues until the file lands in the library.
//
// The *arr client is injected (defaultClient) so the whole lifecycle is testable
// with a stub — see test/arr-requests.test.ts. The poller mirrors the watch-party
// sweeper (src/server/watch/party.ts): a module-level, unref'd interval that
// self-starts on the first active request and self-stops once none remain.

import type { Database as DB } from "better-sqlite3";
import { getDb } from "../db";
import { createLogger } from "../logger";
import { subscribeScan } from "../library/scanner";
import { isArrEnabled } from "./config";
import { ArrError, type RadarrMovie, type SonarrSeries, type QueueRecord } from "./client";
import { pickRelease } from "./releaseLang";
import { assembleReleaseOptions } from "./releaseOptions";
import { mapMovieStatus, mapShowStatus, isStalledDownload, stallDecision, DEFAULT_STALL_MINUTES, type RequestStatus } from "./statusMap";
import { proxyPoster, pickPoster } from "./posters";
import { defaultClient, type ArrClientApi } from "./clientApi";
import { fileBasename, findLibraryMovieId, findLibraryShowId } from "./libraryMatch";
import type { ArrRequest, RequestLanguage, RequestQuality, ReleaseOptions } from "@/lib/flix/types";

const log = createLogger("arr");

// --- injectable client -------------------------------------------------------

// The interface and default implementation live in ./clientApi; requests.ts owns
// the mutable binding the whole lifecycle reads through, plus the test hook.
export type { ArrClientApi };

let client: ArrClientApi = defaultClient;

/** Test hook: swap the *arr client (pass null to restore the real one). */
export function __setArrClient(c: ArrClientApi | null): void {
  client = c ?? defaultClient;
}

// --- row types & serialisation -----------------------------------------------

interface ArrRequestRow {
  id: number;
  user_id: number;
  media_type: "movie" | "show";
  tmdb_id: number | null;
  tvdb_id: number | null;
  title: string;
  year: number | null;
  poster_url: string | null;
  arr_id: number | null;
  status: RequestStatus;
  progress: number;
  error: string | null;
  library_item_id: number | null;
  created_at: number;
  updated_at: number;
  stalled_since: number | null;
  quality_fallback: number;
}

function toDto(row: ArrRequestRow & { username?: string | null }): ArrRequest {
  return {
    id: row.id,
    mediaType: row.media_type,
    title: row.title,
    year: row.year,
    posterUrl: proxyPoster(row.poster_url),
    status: row.status,
    progress: row.progress,
    error: row.error,
    requestedBy: row.username ?? null,
    libraryItemId: row.library_item_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- library matching (D12) --------------------------------------------------
// fileBasename / findLibraryMovieId / findLibraryShowId live in ./libraryMatch.

/** Whether a title/year is already in the library (used to short-circuit a
 *  request for something already present). */
export function isInLibrary(mediaType: "movie" | "show", title: string, year: number | null): boolean {
  const db = getDb();
  return mediaType === "movie"
    ? findLibraryMovieId(db, { title, year, fileBasename: null }) !== null
    : findLibraryShowId(db, { title, year, fileBasename: null }) !== null;
}

// --- read helpers ------------------------------------------------------------

export function listRequests(): ArrRequest[] {
  const rows = getDb()
    .prepare("SELECT r.*, u.username FROM arr_requests r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC")
    .all() as (ArrRequestRow & { username: string | null })[];
  return rows.map(toDto);
}

/** Map of EVERY request (terminal ones too — 'available'/'failed') keyed by
 *  `${mediaType}:${externalId}`, so the discover section can annotate a search
 *  result with an existing request's status (including "already available"). */
export function requestStatusesByExternalId(): Map<string, RequestStatus> {
  const rows = getDb()
    .prepare("SELECT media_type, tmdb_id, tvdb_id, status FROM arr_requests")
    .all() as { media_type: "movie" | "show"; tmdb_id: number | null; tvdb_id: number | null; status: RequestStatus }[];
  const map = new Map<string, RequestStatus>();
  for (const r of rows) {
    const id = r.media_type === "movie" ? r.tmdb_id : r.tvdb_id;
    if (id != null) map.set(`${r.media_type}:${id}`, r.status);
  }
  return map;
}

// A request is "active" (still worth polling) until it reaches a terminal status.
// One SQL fragment so every call site — and isActiveStatus() in statusMap.ts —
// agree on what "terminal" means; add a status here and all four update together.
const ACTIVE_REQUEST_SQL = "status NOT IN ('available','failed')";

function findActiveRow(mediaType: "movie" | "show", externalId: number): ArrRequestRow | null {
  const col = mediaType === "movie" ? "tmdb_id" : "tvdb_id";
  return (
    (getDb()
      .prepare(`SELECT * FROM arr_requests WHERE media_type = ? AND ${col} = ? AND ${ACTIVE_REQUEST_SQL} ORDER BY id DESC LIMIT 1`)
      .get(mediaType, externalId) as ArrRequestRow | undefined) ?? null
  );
}

// --- create ------------------------------------------------------------------

export interface CreateRequestInput {
  mediaType: "movie" | "show";
  tmdbId?: number;
  tvdbId?: number;
  /** Movies only: audio-language preference. "any" (default) keeps the fast
   *  profile-driven search; "fr"/"vo" trigger a background language-ranked grab. */
  language?: RequestLanguage;
  /** Movies only: quality-tier preference. "any" (default) leaves it to the
   *  profile; a tier (e.g. "1080p") constrains the background grab by resolution. */
  quality?: RequestQuality;
}

export async function createRequest(userId: number, input: CreateRequestInput): Promise<{ ok: boolean; error?: string; status?: number; request?: ArrRequest }> {
  if (!isArrEnabled()) return { ok: false, error: "Téléchargements automatiques désactivés", status: 400 };
  if (input.mediaType !== "movie" && input.mediaType !== "show") return { ok: false, error: "Type invalide", status: 400 };

  const db = getDb();
  const now = Date.now();

  try {
    if (input.mediaType === "movie") {
      const tmdbId = input.tmdbId;
      if (!Number.isInteger(tmdbId) || (tmdbId as number) <= 0) return { ok: false, error: "tmdbId requis", status: 400 };
      return await createMovieRequest(db, userId, tmdbId as number, now, input.language ?? "any", input.quality ?? "any");
    }
    const tvdbId = input.tvdbId;
    if (!Number.isInteger(tvdbId) || (tvdbId as number) <= 0) return { ok: false, error: "tvdbId requis", status: 400 };
    return await createShowRequest(db, userId, tvdbId as number, now);
  } catch (error) {
    const message = error instanceof ArrError ? error.message : "Échec de la demande";
    log.warn("createRequest failed", { message });
    return { ok: false, error: message, status: 502 };
  }
}

async function createMovieRequest(db: DB, userId: number, tmdbId: number, now: number, language: RequestLanguage, quality: RequestQuality) {
  const existing = findActiveRow("movie", tmdbId);
  if (existing) return { ok: true, request: toDto(existing) };

  // A specific language OR quality means: add WITHOUT Radarr's blind search, then
  // pick the best matching release ourselves in the background (grabByPreference).
  const wantsCustom = language !== "any" || quality !== "any";

  // Profiles/roots don't depend on the lookup — fetching all three at once cuts
  // "Demander" latency to a single round-trip (the lookup, which traverses
  // Radarr's metadata proxy, dominates).
  const [lookup, profiles, roots] = await Promise.all([client.radarrLookupByTmdbId(tmdbId), client.radarrQualityProfiles(), client.radarrRootFolders()]);
  if (!lookup) return { ok: false, error: "Film introuvable", status: 404 };
  const title = String(lookup.title ?? "Sans titre");
  const year = typeof lookup.year === "number" ? lookup.year : null;
  const posterUrl = pickPoster(lookup);

  if (isInLibrary("movie", title, year)) return { ok: false, error: "Déjà disponible dans votre bibliothèque", status: 409 };

  if (!profiles.length) return { ok: false, error: "Radarr : aucun profil de qualité configuré", status: 502 };
  if (!roots.length) return { ok: false, error: "Radarr : aucun dossier racine configuré", status: 502 };

  let arrId: number | null = typeof lookup.id === "number" && lookup.id > 0 ? lookup.id : null;
  let attached = false;
  try {
    const payload: Record<string, unknown> = {
      ...lookup,
      qualityProfileId: profiles[0].id,
      rootFolderPath: roots[0].path,
      monitored: true,
      addOptions: { searchForMovie: !wantsCustom },
    };
    const added = await client.radarrAddMovie(payload);
    if (typeof added.id === "number") arrId = added.id;
  } catch (error) {
    // "This movie has already been added" — attach to the existing entity
    // rather than failing the request. Radarr's tmdb lookup never carries an
    // existing movie's id (unlike Sonarr's series lookup), so resolve it with
    // an explicit query; a 400 about a movie NOT in Radarr finds nothing there
    // and stays an error.
    if (!(error instanceof ArrError && error.status === 400)) throw error;
    if (arrId == null) {
      const existing = await client.radarrGetMovieByTmdbId(tmdbId);
      arrId = typeof existing?.id === "number" && existing.id > 0 ? existing.id : null;
    }
    if (arrId == null) throw error;
    attached = true;
  }

  // Attaching skips the add's searchForMovie option — if the existing entity is
  // idle (nothing queued, no file), kick a search so "searching" is real. An
  // active download is left alone: re-searching could grab a duplicate release.
  // The language/quality path is handled uniformly by grabByPreference below
  // (which has its own idle guard), so skip the plain search kick when a
  // language or quality was requested.
  if (attached && arrId != null && !wantsCustom) {
    const id = arrId;
    try {
      const [movie, queue] = await Promise.all([client.radarrGetMovie(id), client.radarrQueue()]);
      if (movie?.hasFile !== true && !queue.some((q) => q.movieId === id)) await client.radarrSearchMovie(id);
    } catch (error) {
      log.warn("attach: search kick failed (poller will reconcile)", { tmdbId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const info = db
    .prepare(
      "INSERT INTO arr_requests (user_id, media_type, tmdb_id, title, year, poster_url, arr_id, status, progress, created_at, updated_at) VALUES (?, 'movie', ?, ?, ?, ?, ?, 'searching', 0, ?, ?)",
    )
    .run(userId, tmdbId, title, year, posterUrl, arrId, now, now);
  ensureScanHook();
  startPoller();
  // Fire-and-forget the language/quality-ranked interactive grab. It self-guards
  // on idleness, so it's safe for both the fresh-add (searchForMovie:false) and
  // the attach-to-existing paths; the poller then reconciles the download.
  if (wantsCustom && arrId != null) void grabByPreference(arrId, language, quality, Number(info.lastInsertRowid));
  const row = db.prepare("SELECT r.*, u.username FROM arr_requests r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?").get(info.lastInsertRowid) as ArrRequestRow & { username: string | null };
  return { ok: true, request: toDto(row) };
}

async function createShowRequest(db: DB, userId: number, tvdbId: number, now: number) {
  const existing = findActiveRow("show", tvdbId);
  if (existing) return { ok: true, request: toDto(existing) };

  // Same single-round-trip parallelisation as createMovieRequest.
  const [matches, profiles, roots] = await Promise.all([client.sonarrLookup(`tvdb:${tvdbId}`), client.sonarrQualityProfiles(), client.sonarrRootFolders()]);
  const lookup = matches[0];
  if (!lookup) return { ok: false, error: "Série introuvable", status: 404 };
  const title = String(lookup.title ?? "Sans titre");
  const year = typeof lookup.year === "number" ? lookup.year : null;
  const posterUrl = pickPoster(lookup);

  if (isInLibrary("show", title, year)) return { ok: false, error: "Déjà disponible dans votre bibliothèque", status: 409 };

  if (!profiles.length) return { ok: false, error: "Sonarr : aucun profil de qualité configuré", status: 502 };
  if (!roots.length) return { ok: false, error: "Sonarr : aucun dossier racine configuré", status: 502 };

  let arrId: number | null = typeof lookup.id === "number" && lookup.id > 0 ? lookup.id : null;
  let attached = false;
  try {
    const payload: Record<string, unknown> = {
      ...lookup,
      qualityProfileId: profiles[0].id,
      rootFolderPath: roots[0].path,
      monitored: true,
      seasonFolder: true,
      addOptions: { monitor: "all", searchForMissingEpisodes: true },
    };
    const added = await client.sonarrAddSeries(payload);
    if (typeof added.id === "number") arrId = added.id;
  } catch (error) {
    // Same attach-to-existing as createMovieRequest (Sonarr's lookup usually
    // carries the existing id, but not every path guarantees it).
    if (!(error instanceof ArrError && error.status === 400)) throw error;
    if (arrId == null) {
      const existing = await client.sonarrGetSeriesByTvdbId(tvdbId);
      arrId = typeof existing?.id === "number" && existing.id > 0 ? existing.id : null;
    }
    if (arrId == null) throw error;
    attached = true;
  }

  // Attach path: if the existing series is idle (no queue item, no episode on
  // disk), kick a search — the add's searchForMissingEpisodes never ran.
  if (attached && arrId != null) {
    const id = arrId;
    try {
      const [series, queue] = await Promise.all([client.sonarrGetSeries(id), client.sonarrQueue()]);
      if ((series?.statistics?.episodeFileCount ?? 0) === 0 && !queue.some((q) => q.seriesId === id)) await client.sonarrSearchSeries(id);
    } catch (error) {
      log.warn("attach: search kick failed (poller will reconcile)", { tvdbId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const info = db
    .prepare(
      "INSERT INTO arr_requests (user_id, media_type, tvdb_id, title, year, poster_url, arr_id, status, progress, created_at, updated_at) VALUES (?, 'show', ?, ?, ?, ?, ?, 'searching', 0, ?, ?)",
    )
    .run(userId, tvdbId, title, year, posterUrl, arrId, now, now);
  ensureScanHook();
  startPoller();
  const row = db.prepare("SELECT r.*, u.username FROM arr_requests r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?").get(info.lastInsertRowid) as ArrRequestRow & { username: string | null };
  return { ok: true, request: toDto(row) };
}

// --- language-ranked interactive grab (movies) -------------------------------

/** Terminally fail a request with a user-facing message. 'failed' rows are
 *  skipped by reconcile(), so the status sticks (no poller flip-back). No-op if
 *  the row was deleted meanwhile. */
function failRequest(requestId: number, message: string): void {
  try {
    getDb().prepare("UPDATE arr_requests SET status = 'failed', progress = 0, error = ?, stalled_since = NULL, updated_at = ? WHERE id = ?").run(message, Date.now(), requestId);
  } catch {
    /* best effort — the row may have been removed by the user */
  }
}

/** Human message for a request that found no release matching the wanted
 *  language and/or quality (e.g. « Aucune version française en 1080p trouvée … »). */
function noMatchMessage(language: RequestLanguage, quality: RequestQuality): string {
  const langPart = language === "fr" ? " française" : language === "vo" ? " VO" : "";
  const qMap: Record<Exclude<RequestQuality, "any">, string> = { "2160p": "4K", "1080p": "1080p", "720p": "720p", sd: "SD" };
  const qPart = quality !== "any" ? ` en ${qMap[quality]}` : "";
  return `Aucune version${langPart}${qPart} trouvée pour ce titre`;
}

/** Background best-effort: run Radarr's interactive search for an idle movie,
 *  pick the release that best matches the wanted audio language (title-based —
 *  Radarr's parsed languages mislabel MULTi rips) and quality tier, and grab it.
 *  When the constraint can't be met it FAILS the request with a clear message
 *  (any explicit language≠vo or quality≠any), except a plain "vo, any quality"
 *  which falls back to a normal profile search. Self-guards on idleness → safe
 *  for a freshly-added (no-search) movie or an attached existing one. Never throws. */
async function grabByPreference(arrId: number, language: RequestLanguage, quality: RequestQuality, requestId: number): Promise<void> {
  if (!isArrEnabled()) return;
  try {
    // Leave an already-downloaded or in-flight entity untouched.
    const [movie, queue] = await Promise.all([client.radarrGetMovie(arrId).catch(() => null), client.radarrQueue().catch(() => [] as QueueRecord[])]);
    if (movie?.hasFile === true || queue.some((q) => q.movieId === arrId)) return;

    const releases = await client.radarrReleaseSearch(arrId);
    const pick = pickRelease(releases, { language, quality });
    if (pick.release && pick.matched) {
      await client.radarrGrabRelease(pick.release.guid, pick.release.indexerId);
      log.info("preference grab", { requestId, arrId, language, quality, title: pick.release.title });
      return;
    }

    // A plain "vo, any quality" with nothing usable keeps the lenient fallback;
    // any other explicit constraint fails clearly rather than grabbing something
    // the user didn't ask for (or hanging at "searching").
    const lenientFallback = language === "vo" && quality === "any";
    if (lenientFallback) {
      log.info("preference grab: no acceptable match, normal search fallback", { requestId, arrId, language, quality, candidates: releases.length });
      await client.radarrSearchMovie(arrId);
      return;
    }
    // Remove the just-added monitored movie so it doesn't linger / auto-grab later.
    try {
      await client.radarrDeleteMovie(arrId);
    } catch (error) {
      log.warn("preference grab: radarr movie cleanup failed", { requestId, arrId, message: error instanceof Error ? error.message : String(error) });
    }
    failRequest(requestId, noMatchMessage(language, quality));
    log.info("preference grab: no match → request failed", { requestId, arrId, language, quality, candidates: releases.length });
  } catch (error) {
    log.warn("preference grab failed, normal search fallback", { requestId, arrId, language, quality, message: error instanceof Error ? error.message : String(error) });
    try {
      await client.radarrSearchMovie(arrId);
    } catch {
      /* poller will surface the still-searching request */
    }
  }
}

// --- real-availability release picker (Demander → langue → qualité) ----------

/** Retry a Radarr call through TRANSIENT reachability failures only (rootless
 *  podman's aardvark-dns can briefly drop internal-name lookups when Prowlarr's
 *  interactive search resolves dozens of tracker domains at once → a one-off
 *  « injoignable »). Logic errors (4xx, « déjà ajouté ») are re-thrown at once so
 *  the caller's own handling still runs. Small increasing backoff. */
async function withArrRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 700): Promise<T> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      const transient = error instanceof ArrError && error.status === undefined && /injoignable|n'a pas répondu/i.test(error.message);
      if (!transient || i === attempts) throw error;
      await new Promise((r) => setTimeout(r, baseDelayMs * i));
    }
  }
  throw new Error("unreachable");
}

/** Probe what's actually available for a title: add it to Radarr if needed (so
 *  an interactive search can run), search, and return the languages × qualities
 *  that really exist. `wasAdded` tells the caller to clean up on cancel. */
export async function getReleaseOptions(tmdbId: number): Promise<{ ok: boolean; error?: string; status?: number; options?: ReleaseOptions }> {
  if (!isArrEnabled()) return { ok: false, error: "Téléchargements automatiques désactivés", status: 400 };
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return { ok: false, error: "tmdbId requis", status: 400 };
  try {
    const [lookup, profiles, roots] = await withArrRetry(() =>
      Promise.all([client.radarrLookupByTmdbId(tmdbId), client.radarrQualityProfiles(), client.radarrRootFolders()]),
    );
    if (!lookup) return { ok: false, error: "Film introuvable", status: 404 };
    const title = String(lookup.title ?? "Sans titre");
    const year = typeof lookup.year === "number" ? lookup.year : null;
    if (isInLibrary("movie", title, year)) return { ok: false, error: "Déjà disponible dans votre bibliothèque", status: 409 };
    if (!profiles.length) return { ok: false, error: "Radarr : aucun profil de qualité configuré", status: 502 };
    if (!roots.length) return { ok: false, error: "Radarr : aucun dossier racine configuré", status: 502 };

    // The movie must exist in Radarr to run an interactive release search.
    let arrId: number | null = typeof lookup.id === "number" && lookup.id > 0 ? lookup.id : null;
    let wasAdded = false;
    if (arrId == null) {
      try {
        const added = await withArrRetry(() =>
          client.radarrAddMovie({ ...lookup, qualityProfileId: profiles[0].id, rootFolderPath: roots[0].path, monitored: false, addOptions: { searchForMovie: false } }),
        );
        if (typeof added.id === "number") {
          arrId = added.id;
          wasAdded = true;
        }
      } catch (error) {
        if (!(error instanceof ArrError && error.status === 400)) throw error;
        const existing = await client.radarrGetMovieByTmdbId(tmdbId);
        arrId = typeof existing?.id === "number" && existing.id > 0 ? existing.id : null;
      }
    }
    if (arrId == null) return { ok: false, error: "Radarr n'a pas pu préparer la recherche", status: 502 };

    const releases = await withArrRetry(() => client.radarrReleaseSearch(arrId));
    return { ok: true, options: assembleReleaseOptions({ arrId, wasAdded, title, year, releases }) };
  } catch (error) {
    const message = error instanceof ArrError ? error.message : "Échec de la recherche des versions";
    log.warn("getReleaseOptions failed", { tmdbId, message });
    return { ok: false, error: message, status: 502 };
  }
}

/** Grab a specific release the user picked (guid+indexerId), then persist the
 *  request row so the poller tracks it to completion. Dedupes an existing active
 *  request for the same title. */
export async function grabChosenRelease(
  userId: number,
  input: { tmdbId: number; arrId: number; guid: string; indexerId: number },
): Promise<{ ok: boolean; error?: string; status?: number; request?: ArrRequest }> {
  if (!isArrEnabled()) return { ok: false, error: "Téléchargements automatiques désactivés", status: 400 };
  const { tmdbId, arrId, guid, indexerId } = input;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !Number.isInteger(arrId) || arrId <= 0 || typeof guid !== "string" || !guid || !Number.isInteger(indexerId)) {
    return { ok: false, error: "Paramètres invalides", status: 400 };
  }
  const db = getDb();
  const existing = findActiveRow("movie", tmdbId);
  if (existing) return { ok: true, request: toDto(existing) };
  try {
    const lookup = await client.radarrLookupByTmdbId(tmdbId);
    const title = String(lookup?.title ?? "Sans titre");
    const year = typeof lookup?.year === "number" ? lookup.year : null;
    const posterUrl = lookup ? pickPoster(lookup) : null;

    await client.radarrGrabRelease(guid, indexerId);

    const now = Date.now();
    const info = db
      .prepare(
        "INSERT INTO arr_requests (user_id, media_type, tmdb_id, title, year, poster_url, arr_id, status, progress, created_at, updated_at) VALUES (?, 'movie', ?, ?, ?, ?, ?, 'searching', 0, ?, ?)",
      )
      .run(userId, tmdbId, title, year, posterUrl, arrId, now, now);
    ensureScanHook();
    startPoller();
    const row = db.prepare("SELECT r.*, u.username FROM arr_requests r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?").get(info.lastInsertRowid) as ArrRequestRow & { username: string | null };
    return { ok: true, request: toDto(row) };
  } catch (error) {
    const message = error instanceof ArrError ? error.message : "Échec de la demande";
    log.warn("grabChosenRelease failed", { tmdbId, message });
    return { ok: false, error: message, status: 502 };
  }
}

/** Undo a browse that ADDED a movie to Radarr but was closed without grabbing —
 *  remove the idle, request-less, file-less entity so it doesn't linger. No-op
 *  otherwise (pre-existing movie, has a request, downloading, or has a file). */
export async function cancelReleaseBrowse(input: { arrId: number; wasAdded: boolean }): Promise<{ ok: boolean }> {
  const { arrId, wasAdded } = input;
  if (!isArrEnabled() || !wasAdded || !Number.isInteger(arrId) || arrId <= 0) return { ok: true };
  try {
    const hasRequest = getDb().prepare("SELECT 1 FROM arr_requests WHERE arr_id = ? LIMIT 1").get(arrId);
    if (hasRequest) return { ok: true };
    const [movie, queue] = await Promise.all([client.radarrGetMovie(arrId).catch(() => null), client.radarrQueue().catch(() => [] as QueueRecord[])]);
    if (movie && movie.hasFile !== true && !queue.some((q) => q.movieId === arrId)) {
      await client.radarrDeleteMovie(arrId);
    }
  } catch (error) {
    log.warn("cancelReleaseBrowse cleanup failed", { arrId, message: error instanceof Error ? error.message : String(error) });
  }
  return { ok: true };
}

// --- delete ------------------------------------------------------------------

export function deleteRequest(id: number, actor: { id: number; isAdmin: boolean }): { ok: boolean; error?: string; status?: number } {
  const db = getDb();
  const row = db.prepare("SELECT * FROM arr_requests WHERE id = ?").get(id) as ArrRequestRow | undefined;
  if (!row) return { ok: false, error: "Demande introuvable", status: 404 };
  // Admin can remove any request; the requester can remove their own until it
  // becomes available (Radarr/Sonarr entities are left in place — documented).
  const isOwner = row.user_id === actor.id;
  if (!actor.isAdmin && !(isOwner && row.status !== "available")) {
    return { ok: false, error: "Non autorisé", status: 403 };
  }
  db.prepare("DELETE FROM arr_requests WHERE id = ?").run(id);
  return { ok: true };
}

// --- reconcile ---------------------------------------------------------------

function updateRow(
  db: DB,
  id: number,
  patch: { status: RequestStatus; progress: number; error: string | null; libraryItemId: number | null; stalledSince: number | null },
): void {
  db.prepare("UPDATE arr_requests SET status = ?, progress = ?, error = ?, library_item_id = ?, stalled_since = ?, updated_at = ? WHERE id = ?").run(
    patch.status,
    patch.progress,
    patch.error,
    patch.libraryItemId,
    patch.stalledSince,
    Date.now(),
    id,
  );
}

// --- stall watchdog ----------------------------------------------------------

/** Minutes a download may sit at ~0% before the balanced fallback fires
 *  (FLIX_ARR_STALL_MINUTES overrides; default 10). */
function stallThresholdMs(): number {
  const raw = Number(process.env.FLIX_ARR_STALL_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_MINUTES;
  return minutes * 60_000;
}
/** The watchdog is on by default; FLIX_ARR_STALL_FALLBACK=0 disables it. */
function stallFallbackEnabled(): boolean {
  return process.env.FLIX_ARR_STALL_FALLBACK !== "0";
}
/** Retuning the SHARED default Radarr/Sonarr quality profile to "balanced" is a
 *  GLOBAL side effect: applyBalancedProfile rewrites the operator's default
 *  profile in place, so one user's stalled request degrades quality for EVERY
 *  future import. This is the operator-requested "stall → balanced" behaviour so
 *  it stays ON by default, but the blast radius is now (a) logged loudly and
 *  (b) escapable: set FLIX_ARR_STALL_GLOBAL_RETUNE=0 to keep the per-item rescue
 *  (blocklist + re-search) while leaving the shared profile untouched. Scoping
 *  the retune to just this movie/series would need extra *arr API surface
 *  (assign the entity its own profile) that this module doesn't have yet. */
function stallGlobalRetuneEnabled(): boolean {
  return process.env.FLIX_ARR_STALL_GLOBAL_RETUNE !== "0";
}

interface StallContext {
  service: "radarr" | "sonarr";
  item: QueueRecord | null;
  arrId: number | null;
  profileId: number | null;
  queueId: number | null;
}

/** Rescue a stalled download: blocklist + drop the stuck release and kick off a
 *  fresh search. Optionally (opt-in, see stallGlobalRetuneEnabled) also retune
 *  the SHARED default quality profile to balanced first. Throws on a hard API
 *  failure so the caller can fall back to a normal status write. */
async function runQualityFallback(db: DB, row: ArrRequestRow, ctx: StallContext): Promise<void> {
  if (ctx.profileId == null || ctx.arrId == null) throw new Error("missing arr id / quality profile for fallback");

  // The retune mutates the operator's shared default profile GLOBALLY, so only
  // run it when explicitly opted in, and warn loudly about the blast radius.
  let retuned = false;
  if (stallGlobalRetuneEnabled()) {
    retuned = await client.applyBalancedProfile(ctx.service, ctx.profileId);
    log.warn("stall fallback retuned the SHARED default quality profile to balanced — affects ALL future imports", {
      id: row.id,
      service: ctx.service,
      profileId: ctx.profileId,
      retuned,
    });
  }

  // Blocklist + remove the dead release so the same torrent isn't re-grabbed.
  if (ctx.queueId != null) {
    try {
      if (ctx.service === "radarr") await client.radarrRemoveQueueItem(ctx.queueId);
      else await client.sonarrRemoveQueueItem(ctx.queueId);
    } catch (error) {
      log.warn("stall fallback: queue removal failed (continuing)", { id: row.id, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (ctx.service === "radarr") await client.radarrSearchMovie(ctx.arrId);
  else await client.sonarrSearchSeries(ctx.arrId);

  db.prepare("UPDATE arr_requests SET status = 'searching', progress = 0, error = ?, stalled_since = NULL, quality_fallback = 1, updated_at = ? WHERE id = ?").run(
    retuned
      ? "Téléchargement bloqué à 0 % — qualité basculée en « balanced » et relance automatique."
      : "Téléchargement bloqué à 0 % — relance automatique avec un autre lien.",
    Date.now(),
    row.id,
  );
  log.info("stall fallback → balanced + re-search", { id: row.id, title: row.title, service: ctx.service, profileRetuned: retuned });
}

/** One reconciliation pass: refresh every active request against the Radarr/
 *  Sonarr queues and the library, then stop the poller if nothing's left. */
export async function reconcile(): Promise<void> {
  const db = getDb();
  if (!isArrEnabled()) {
    stopPoller();
    return;
  }
  const active = db.prepare(`SELECT * FROM arr_requests WHERE ${ACTIVE_REQUEST_SQL}`).all() as ArrRequestRow[];
  if (!active.length) {
    stopPoller();
    return;
  }

  const hasMovie = active.some((r) => r.media_type === "movie");
  const hasShow = active.some((r) => r.media_type === "show");
  const [movieQueue, showQueue] = await Promise.all([
    hasMovie ? client.radarrQueue().catch(() => null) : Promise.resolve<QueueRecord[] | null>([]),
    hasShow ? client.sonarrQueue().catch(() => null) : Promise.resolve<QueueRecord[] | null>([]),
  ]);

  // A null queue means the fetch FAILED (service unreachable), NOT an empty queue
  // (service up, nothing downloading). We pass this down so reconcile still honours
  // queue-INDEPENDENT transitions (library completion → available, forward moves)
  // while refusing to let a MISSING queue downgrade a live "downloading 45%"
  // request to "searching 0%" (self-heals next pass, but a visible regression).
  const movieQueueOk = movieQueue !== null;
  const showQueueOk = showQueue !== null;
  const movieQueueBy = indexQueue(movieQueue, "movieId");
  const showQueueBy = indexQueue(showQueue, "seriesId");

  for (const row of active) {
    const queueOk = row.media_type === "movie" ? movieQueueOk : showQueueOk;
    try {
      if (row.media_type === "movie") await reconcileMovie(db, row, movieQueueBy, queueOk);
      else await reconcileShow(db, row, showQueueBy, queueOk);
    } catch (error) {
      // A per-service outage leaves the row untouched — try again next pass.
      log.warn("reconcile row failed", { id: row.id, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM arr_requests WHERE ${ACTIVE_REQUEST_SQL}`).get() as { n: number };
  if (remaining.n === 0) stopPoller();
}

function indexQueue(records: QueueRecord[] | null, key: "movieId" | "seriesId"): Map<number, QueueRecord> {
  const map = new Map<number, QueueRecord>();
  if (!records) return map;
  for (const rec of records) {
    const id = rec[key];
    if (typeof id === "number") map.set(id, rec);
  }
  return map;
}

function profileIdOf(entity: Record<string, unknown> | null): number | null {
  const id = entity?.qualityProfileId;
  return typeof id === "number" && id > 0 ? id : null;
}

async function reconcileMovie(db: DB, row: ArrRequestRow, queueBy: Map<number, QueueRecord>, queueOk: boolean): Promise<void> {
  let movie: RadarrMovie | null = null;
  if (row.arr_id != null) movie = await client.radarrGetMovie(row.arr_id).catch(() => null);
  const basename = fileBasename(movie?.movieFile?.relativePath ?? movie?.movieFile?.path ?? null);
  const libId = findLibraryMovieId(db, { title: row.title, year: row.year, fileBasename: basename });
  const queueItem = row.arr_id != null ? queueBy.get(row.arr_id) ?? null : null;
  const next = mapMovieStatus({ queueItem, hasFile: movie?.hasFile === true, libraryMatched: libId != null });
  // A "searching" computed while the queue was unreachable is only an artifact of
  // the missing queue — leave the row untouched instead of downgrading a live
  // request. Completion (library match → available) and forward moves are checked
  // first in mapMovieStatus, are queue-independent, and still apply here.
  if (!queueOk && next.status === "searching") return;
  await applyReconcile(db, row, next, libId, { service: "radarr", item: queueItem, arrId: row.arr_id, profileId: profileIdOf(movie), queueId: queueItem?.id ?? null });
}

async function reconcileShow(db: DB, row: ArrRequestRow, queueBy: Map<number, QueueRecord>, queueOk: boolean): Promise<void> {
  let series: SonarrSeries | null = null;
  if (row.arr_id != null) series = await client.sonarrGetSeries(row.arr_id).catch(() => null);
  const libId = findLibraryShowId(db, { title: row.title, year: row.year, fileBasename: null });
  const queueItem = row.arr_id != null ? queueBy.get(row.arr_id) ?? null : null;
  const next = mapShowStatus({ queueItem, episodeFileCount: series?.statistics?.episodeFileCount ?? 0, libraryMatched: libId != null });
  // See reconcileMovie: don't let a missing queue downgrade a live request to
  // "searching"; completion/forward moves are queue-independent and still apply.
  if (!queueOk && next.status === "searching") return;
  await applyReconcile(db, row, next, libId, { service: "sonarr", item: queueItem, arrId: row.arr_id, profileId: profileIdOf(series), queueId: queueItem?.id ?? null });
}

/** Persist the reconciled status, running the stall watchdog first: a download
 *  stuck at ~0% past the threshold triggers the one-time balanced fallback;
 *  otherwise the stalled_since clock is updated alongside the normal status. */
async function applyReconcile(
  db: DB,
  row: ArrRequestRow,
  next: { status: RequestStatus; progress: number; error?: string },
  libId: number | null,
  ctx: StallContext,
): Promise<void> {
  const stalled = next.status === "downloading" && isStalledDownload(ctx.item, next.progress, row.progress);
  const decision = stallDecision({
    stalled,
    prevSince: row.stalled_since,
    alreadyFellBack: row.quality_fallback === 1,
    now: Date.now(),
    thresholdMs: stallThresholdMs(),
  });

  if (decision.fallback && stallFallbackEnabled() && ctx.profileId != null && ctx.arrId != null) {
    try {
      await runQualityFallback(db, row, ctx);
      return;
    } catch (error) {
      // A fallback failure must not lose the status — fall through to a normal write.
      log.warn("stall fallback failed", { id: row.id, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const nextError = next.error ?? null;
  const nextLibId = libId ?? row.library_item_id;
  if (
    row.status === next.status &&
    row.progress === next.progress &&
    row.error === nextError &&
    row.library_item_id === nextLibId &&
    row.stalled_since === decision.stalledSince
  ) {
    return;
  }
  updateRow(db, row.id, { status: next.status, progress: next.progress, error: nextError, libraryItemId: nextLibId, stalledSince: decision.stalledSince });
}

// --- poller ------------------------------------------------------------------

let poller: ReturnType<typeof setInterval> | null = null;

function startPoller(): void {
  if (poller) return;
  poller = setInterval(() => void reconcile(), 20_000);
  if (typeof poller.unref === "function") poller.unref();
}

function stopPoller(): void {
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
}

// Run one reconcile right after each library scan completes, so an imported file
// flips its request importing→available within seconds of the watcher's rescan
// instead of waiting up to a full 20s poll.
let scanHooked = false;
let lastReconciledScanAt: number | null = null;

function ensureScanHook(): void {
  if (scanHooked) return;
  scanHooked = true;
  subscribeScan((snapshot) => {
    if (snapshot.status !== "ready") return;
    if (snapshot.finishedAt === lastReconciledScanAt) return;
    lastReconciledScanAt = snapshot.finishedAt;
    void reconcile();
  });
}

/** Called from initArr() on boot: revive the poller if the feature is on and
 *  there is unfinished work, and reconcile once immediately. */
export function resumePoller(): void {
  if (!isArrEnabled()) return;
  const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM arr_requests WHERE ${ACTIVE_REQUEST_SQL}`).get() as { n: number }).n;
  if (n === 0) return;
  ensureScanHook();
  startPoller();
  void reconcile();
}

/** Test hook: stop the poller and reset the scan-hook guard. */
export function __resetPoller(): void {
  stopPoller();
  scanHooked = false;
  lastReconciledScanAt = null;
}
