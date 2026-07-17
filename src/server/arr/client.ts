// The project's FIRST server-side outbound HTTP client — deliberately narrow.
//
// Every call is hard-gated on isArrEnabled(): with the feature off (the default)
// arrFetch() throws before touching the network, so Flix's "zero outbound calls"
// posture holds exactly as before unless the operator opts in. The blast radius
// is one host (the operator's own local *arr instance), one auth header, a
// bounded timeout, and the handful of endpoints wrapped below.

import { getServiceConfig, isArrEnabled, type ArrService } from "./config";

const DEFAULT_TIMEOUT_MS = 20_000;
// Metadata lookups traverse Radarr/Sonarr's cloud proxies (api.radarr.video,
// Skyhook) — on a cold cache or behind the VPN tunnel they routinely exceed 8s,
// which used to surface as « radarr n'a pas répondu à temps » on every first
// "Demander". They get a bigger budget than LAN-only endpoints.
const LOOKUP_TIMEOUT_MS = 30_000;
// Safe-to-repeat GETs get one automatic retry: most « n'a pas répondu à temps »
// failures are a one-off hiccup (service waking up, tunnel renegotiating).
const GET_ATTEMPTS = 2;

export class ArrError extends Error {
  service: ArrService;
  status?: number;
  /** Parsed response body when the server returned JSON (used to detect the
   *  "already added" 400 from Radarr/Sonarr). */
  body?: unknown;
  constructor(service: ArrService, message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "ArrError";
    this.service = service;
    this.status = status;
    this.body = body;
  }
}

interface FetchOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
  /** Extra query params appended to the path. */
  query?: Record<string, string | number | undefined>;
}

function buildUrl(base: string, apiPath: string, query?: FetchOptions["query"]): string {
  const url = new URL(base + apiPath);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** Core outbound call. Throws ArrError when the feature is disabled, the service
 *  is unconfigured, the request times out, or the server answers non-2xx. */
export async function arrFetch<T = unknown>(service: ArrService, apiPath: string, opts: FetchOptions = {}): Promise<T> {
  if (!isArrEnabled()) throw new ArrError(service, "Téléchargements automatiques désactivés");
  const cfg = getServiceConfig(service);
  if (!cfg) throw new ArrError(service, `${service} n'est pas configuré`);

  const url = buildUrl(cfg.url, apiPath, opts.query);
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Only GETs are retried — a replayed POST could double-add an entity.
  const attempts = method === "GET" ? GET_ATTEMPTS : 1;
  let res: Response | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      res = await fetch(url, {
        method,
        // Header names are case-insensitive at the HTTP layer, so this single
        // X-Api-Key satisfies Bazarr's X-API-KEY expectation too.
        headers: {
          "X-Api-Key": cfg.apiKey,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      break;
    } catch (error) {
      if (attempt < attempts) continue;
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ArrError(service, timedOut ? `${service} n'a pas répondu à temps — réessayez dans quelques secondes` : `${service} injoignable`);
    }
  }
  if (!res) throw new ArrError(service, `${service} injoignable`);

  if (!res.ok) {
    let body: unknown;
    let message = `${service} a répondu ${res.status}`;
    try {
      body = await res.json();
      // Radarr/Sonarr validation errors come back as [{ errorMessage }].
      if (Array.isArray(body) && body[0] && typeof body[0] === "object" && "errorMessage" in body[0]) {
        message = String((body[0] as { errorMessage: unknown }).errorMessage);
      } else if (body && typeof body === "object" && "message" in body) {
        message = String((body as { message: unknown }).message);
      }
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new ArrError(service, message, res.status, body);
  }

  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    return undefined as T;
  }
}

// --- typed shapes (only the fields we read/echo) -----------------------------

export interface RadarrMovie {
  id?: number;
  tmdbId?: number;
  title?: string;
  year?: number;
  overview?: string;
  remotePoster?: string;
  images?: { coverType?: string; remoteUrl?: string; url?: string }[];
  titleSlug?: string;
  hasFile?: boolean;
  movieFile?: { relativePath?: string; path?: string } | null;
  [key: string]: unknown;
}

export interface SonarrSeries {
  id?: number;
  tvdbId?: number;
  title?: string;
  year?: number;
  overview?: string;
  remotePoster?: string;
  images?: { coverType?: string; remoteUrl?: string; url?: string }[];
  titleSlug?: string;
  statistics?: { episodeFileCount?: number };
  [key: string]: unknown;
}

export interface QualityProfile {
  id: number;
  name: string;
}
export interface RootFolder {
  path: string;
}
export interface QueueRecord {
  /** The queue record's own id — needed to remove/blocklist a stuck download. */
  id?: number;
  movieId?: number;
  seriesId?: number;
  status?: string;
  trackedDownloadState?: string;
  trackedDownloadStatus?: string;
  size?: number;
  sizeleft?: number;
  errorMessage?: string;
}

/** A full Radarr/Sonarr quality profile (GET, mutated, PUT back). */
export interface QualityProfileFull {
  id: number;
  name: string;
  cutoff: number;
  upgradeAllowed?: boolean;
  items: {
    id?: number;
    name?: string;
    allowed: boolean;
    quality?: { id: number; name: string };
    items?: unknown[];
  }[];
  [key: string]: unknown;
}

const STATUS_PATH: Record<ArrService, string> = {
  radarr: "/api/v3/system/status",
  sonarr: "/api/v3/system/status",
  prowlarr: "/api/v1/system/status",
  bazarr: "/api/system/status",
};

// --- wrappers ----------------------------------------------------------------

/** Probe a service and return its reported version (used by the admin test button). */
export async function testService(service: ArrService): Promise<{ version: string }> {
  const status = await arrFetch<{ version?: string; data?: { bazarr_version?: string } }>(service, STATUS_PATH[service]);
  const version = status?.version ?? status?.data?.bazarr_version ?? "?";
  return { version: String(version) };
}

export function radarrLookup(term: string): Promise<RadarrMovie[]> {
  return arrFetch<RadarrMovie[]>("radarr", "/api/v3/movie/lookup", { query: { term }, timeoutMs: LOOKUP_TIMEOUT_MS });
}
export function radarrLookupByTmdbId(tmdbId: number): Promise<RadarrMovie | null> {
  return arrFetch<RadarrMovie>("radarr", "/api/v3/movie/lookup/tmdb", { query: { tmdbId }, timeoutMs: LOOKUP_TIMEOUT_MS }).then((m) => m ?? null);
}
export function sonarrLookup(term: string): Promise<SonarrSeries[]> {
  return arrFetch<SonarrSeries[]>("sonarr", "/api/v3/series/lookup", { query: { term }, timeoutMs: LOOKUP_TIMEOUT_MS });
}

export function radarrQualityProfiles(): Promise<QualityProfile[]> {
  return arrFetch<QualityProfile[]>("radarr", "/api/v3/qualityprofile");
}
export function radarrRootFolders(): Promise<RootFolder[]> {
  return arrFetch<RootFolder[]>("radarr", "/api/v3/rootfolder");
}
export function sonarrQualityProfiles(): Promise<QualityProfile[]> {
  return arrFetch<QualityProfile[]>("sonarr", "/api/v3/qualityprofile");
}
export function sonarrRootFolders(): Promise<RootFolder[]> {
  return arrFetch<RootFolder[]>("sonarr", "/api/v3/rootfolder");
}

export function radarrAddMovie(payload: Record<string, unknown>): Promise<RadarrMovie> {
  return arrFetch<RadarrMovie>("radarr", "/api/v3/movie", { method: "POST", body: payload });
}
export function sonarrAddSeries(payload: Record<string, unknown>): Promise<SonarrSeries> {
  return arrFetch<SonarrSeries>("sonarr", "/api/v3/series", { method: "POST", body: payload });
}

export function radarrGetMovie(id: number): Promise<RadarrMovie | null> {
  return arrFetch<RadarrMovie>("radarr", `/api/v3/movie/${id}`).then((m) => m ?? null);
}

/** Remove a movie entity from Radarr (keeps files, no import exclusion) — used to
 *  tidy up a just-added movie when a language-specific request finds no match. */
export function radarrDeleteMovie(id: number): Promise<void> {
  return arrFetch<void>("radarr", `/api/v3/movie/${id}`, { method: "DELETE", query: { deleteFiles: "false", addImportExclusion: "false" } });
}
export function sonarrGetSeries(id: number): Promise<SonarrSeries | null> {
  return arrFetch<SonarrSeries>("sonarr", `/api/v3/series/${id}`).then((s) => s ?? null);
}

/** Resolve an already-added entity by its external id. Radarr's
 *  `movie/lookup/tmdb` returns `id: null` even for movies it already has
 *  (unlike Sonarr's series lookup), so the "already added" attach path needs
 *  this explicit query to find the entity to attach to. */
export function radarrGetMovieByTmdbId(tmdbId: number): Promise<RadarrMovie | null> {
  return arrFetch<RadarrMovie[]>("radarr", "/api/v3/movie", { query: { tmdbId } }).then((list) => (Array.isArray(list) && list.length ? list[0] : null));
}
export function sonarrGetSeriesByTvdbId(tvdbId: number): Promise<SonarrSeries | null> {
  return arrFetch<SonarrSeries[]>("sonarr", "/api/v3/series", { query: { tvdbId } }).then((list) => (Array.isArray(list) && list.length ? list[0] : null));
}

// --- interactive release search (used by the per-request language picker) -----

/** One release row from Radarr's interactive search. Only the fields the
 *  language-ranking + grab need are typed; Radarr's parsed `languages` array is
 *  deliberately treated as a weak hint (it mislabels "MULTi" rips as English),
 *  so ranking leans on the release title. */
export interface RadarrRelease {
  guid: string;
  indexerId: number;
  title: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  rejected?: boolean;
  protocol?: string;
  languages?: { id?: number; name?: string }[];
  quality?: { quality?: { id?: number; name?: string; resolution?: number } };
}

/** Interactive search for a movie already in Radarr — queries every configured
 *  indexer, so it inherits the slow LOOKUP budget (a cold public-tracker sweep
 *  routinely runs 30-60s). */
export function radarrReleaseSearch(movieId: number): Promise<RadarrRelease[]> {
  return arrFetch<RadarrRelease[]>("radarr", "/api/v3/release", { query: { movieId }, timeoutMs: 90_000 }).then((l) => (Array.isArray(l) ? l : []));
}

/** Push a specific release to the download client (the "grab this exact one"
 *  the language picker resolves to). */
export function radarrGrabRelease(guid: string, indexerId: number): Promise<void> {
  return arrFetch<void>("radarr", "/api/v3/release", { method: "POST", body: { guid, indexerId } });
}

export function radarrQueue(): Promise<QueueRecord[]> {
  return arrFetch<{ records?: QueueRecord[] }>("radarr", "/api/v3/queue", { query: { page: 1, pageSize: 200 } }).then((r) => r?.records ?? []);
}
export function sonarrQueue(): Promise<QueueRecord[]> {
  return arrFetch<{ records?: QueueRecord[] }>("sonarr", "/api/v3/queue", { query: { page: 1, pageSize: 200 } }).then((r) => r?.records ?? []);
}

// --- stall-fallback plumbing (quality profile retune + re-grab) --------------

export function radarrQualityProfile(id: number): Promise<QualityProfileFull> {
  return arrFetch<QualityProfileFull>("radarr", `/api/v3/qualityprofile/${id}`);
}
export function sonarrQualityProfile(id: number): Promise<QualityProfileFull> {
  return arrFetch<QualityProfileFull>("sonarr", `/api/v3/qualityprofile/${id}`);
}
export function radarrUpdateQualityProfile(id: number, body: QualityProfileFull): Promise<QualityProfileFull> {
  return arrFetch<QualityProfileFull>("radarr", `/api/v3/qualityprofile/${id}`, { method: "PUT", body });
}
export function sonarrUpdateQualityProfile(id: number, body: QualityProfileFull): Promise<QualityProfileFull> {
  return arrFetch<QualityProfileFull>("sonarr", `/api/v3/qualityprofile/${id}`, { method: "PUT", body });
}

/** Remove a queue item and blocklist its release so the same dead torrent isn't
 *  immediately re-grabbed on the next search. */
export function radarrRemoveQueueItem(queueId: number): Promise<void> {
  return arrFetch<void>("radarr", `/api/v3/queue/${queueId}`, { method: "DELETE", query: { removeFromClient: "true", blocklist: "true" } });
}
export function sonarrRemoveQueueItem(queueId: number): Promise<void> {
  return arrFetch<void>("sonarr", `/api/v3/queue/${queueId}`, { method: "DELETE", query: { removeFromClient: "true", blocklist: "true" } });
}

/** Kick off a fresh search for a movie / series after the fallback retune. */
export function radarrSearchMovie(movieId: number): Promise<void> {
  return arrFetch<void>("radarr", "/api/v3/command", { method: "POST", body: { name: "MoviesSearch", movieIds: [movieId] } });
}
export function sonarrSearchSeries(seriesId: number): Promise<void> {
  return arrFetch<void>("sonarr", "/api/v3/command", { method: "POST", body: { name: "SeriesSearch", seriesId } });
}

export function prowlarrIndexerCount(): Promise<number> {
  return arrFetch<unknown[]>("prowlarr", "/api/v1/indexer").then((list) => (Array.isArray(list) ? list.length : 0));
}

// --- Prowlarr indexer management (used by the live "add indexer packs" feature) ---

export interface ProwlarrIndexer {
  id?: number;
  name?: string;
  definitionName?: string;
  [key: string]: unknown;
}
export interface ProwlarrSchemaField {
  name: string;
  value?: unknown;
}
/** A Prowlarr indexer/proxy schema — POSTed back almost verbatim (spread) with a
 *  few fields overridden, mirroring deploy/arr/arr-init.mjs. */
export interface ProwlarrSchema {
  name?: string;
  definitionName?: string;
  implementation?: string;
  implementationName?: string;
  configContract?: string;
  appProfileId?: number;
  priority?: number;
  /** "public" | "semiPrivate" | "private" — the "everything" mode only ever
   *  auto-adds public (no-account) definitions. */
  privacy?: string;
  /** ISO language code of the indexer's content (e.g. "en-US", "fr-FR"). */
  language?: string;
  fields?: ProwlarrSchemaField[];
  [key: string]: unknown;
}
export interface ProwlarrTag {
  id: number;
  label: string;
}
export interface ProwlarrProxy {
  id?: number;
  implementation?: string;
  [key: string]: unknown;
}

export function prowlarrIndexers(): Promise<ProwlarrIndexer[]> {
  return arrFetch<ProwlarrIndexer[]>("prowlarr", "/api/v1/indexer").then((l) => (Array.isArray(l) ? l : []));
}
export function prowlarrIndexerSchemas(): Promise<ProwlarrSchema[]> {
  return arrFetch<ProwlarrSchema[]>("prowlarr", "/api/v1/indexer/schema").then((l) => (Array.isArray(l) ? l : []));
}
export function prowlarrAddIndexer(payload: Record<string, unknown>, timeoutMs = 40_000): Promise<ProwlarrIndexer> {
  // Prowlarr connectivity-tests the indexer synchronously on add, which can take
  // well over the default timeout (slow/geo-blocked sites, FlareSolverr round-
  // trips) — give it room so a reachable source isn't a false timeout. The
  // "everything" batch mode passes a tighter budget to keep chunks snappy.
  return arrFetch<ProwlarrIndexer>("prowlarr", "/api/v1/indexer", { method: "POST", body: payload, timeoutMs });
}
export function prowlarrTags(): Promise<ProwlarrTag[]> {
  return arrFetch<ProwlarrTag[]>("prowlarr", "/api/v1/tag").then((l) => (Array.isArray(l) ? l : []));
}
export function prowlarrAddTag(label: string): Promise<ProwlarrTag> {
  return arrFetch<ProwlarrTag>("prowlarr", "/api/v1/tag", { method: "POST", body: { label } });
}
export function prowlarrIndexerProxies(): Promise<ProwlarrProxy[]> {
  return arrFetch<ProwlarrProxy[]>("prowlarr", "/api/v1/indexerproxy").then((l) => (Array.isArray(l) ? l : []));
}
export function prowlarrIndexerProxySchemas(): Promise<ProwlarrSchema[]> {
  return arrFetch<ProwlarrSchema[]>("prowlarr", "/api/v1/indexerproxy/schema").then((l) => (Array.isArray(l) ? l : []));
}
export function prowlarrAddIndexerProxy(payload: Record<string, unknown>): Promise<ProwlarrProxy> {
  return arrFetch<ProwlarrProxy>("prowlarr", "/api/v1/indexerproxy", { method: "POST", body: payload });
}
