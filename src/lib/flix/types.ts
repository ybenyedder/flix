// Client-side DTOs. These mirror EXACTLY what the API routes serialise —
// verified by reading src/server/library/repository.ts and the
// src/app/api/{library,items,state,search}/*.ts routes before writing this
// file, rather than guessed from the DB schema. Keep in sync with both sides
// whenever either changes.

export interface CatalogActor {
  name: string;
  role: string | null;
}

/** Coarse quality signal derived from the tallest video stream across an
 *  item's files — enough for a Card/DetailModal badge (HD/4K, HDR), nothing
 *  more precise (per-file exact codec info lives in MediaFileInfo instead). */
export interface QualityInfo {
  height: number | null;
  hdr: boolean;
}

export interface Movie {
  id: number;
  type: "movie";
  title: string;
  sortTitle: string;
  originalTitle: string | null;
  year: number | null;
  duration: number;
  synopsis: string | null;
  tagline: string | null;
  genres: string[];
  actors: CatalogActor[];
  directors: string[];
  studio: string | null;
  contentRating: string | null;
  posterHash: string | null;
  backdropHash: string | null;
  thumbHash: string | null;
  logoHash: string | null;
  addedAt: number;
  quality: QualityInfo;
}

export interface Show {
  id: number;
  type: "show";
  title: string;
  sortTitle: string;
  year: number | null;
  synopsis: string | null;
  genres: string[];
  actors: CatalogActor[];
  studio: string | null;
  contentRating: string | null;
  status: string | null;
  posterHash: string | null;
  backdropHash: string | null;
  logoHash: string | null;
  seasonCount: number;
  episodeCount: number;
  addedAt: number;
  quality: QualityInfo;
}

export type CatalogEntry = Movie | Show;

export type ScanStatus = "idle" | "scanning" | "ready" | "error";

export interface ScanProgress {
  status: ScanStatus;
  phase: string;
  processed: number;
  total: number;
  added: number;
  updated: number;
  removed: number;
  probed: number;
  probeTotal: number;
  imaging: boolean;
  imaged: number;
  imageTotal: number;
  startedAt: number | null;
  finishedAt: number | null;
  scannedAt: string | null;
  root: string;
  error: string | null;
}

export interface CatalogSnapshot {
  movies: Movie[];
  shows: Show[];
  mediaDir: string;
  scannedAt: string | null;
  countMovies: number;
  countShows: number;
  countEpisodes: number;
  scan: ScanProgress;
}

export interface SearchResults {
  movies: Movie[];
  shows: Show[];
  query: string;
}

// --- item detail (movie/show), streams + tracks --------------------------

export interface StreamInfo {
  id: number;
  streamIndex: number;
  type: "video" | "audio" | "subtitle";
  codec: string | null;
  profile: string | null;
  level: number | null;
  width: number | null;
  height: number | null;
  bitDepth: number | null;
  frameRate: number | null;
  pixelFormat: string | null;
  hdrFormat: string | null;
  channels: number | null;
  channelLayout: string | null;
  sampleRate: number | null;
  language: string | null;
  title: string | null;
  bitrate: number | null;
  isDefault: boolean;
  isForced: boolean;
  attachedPic: boolean;
}

export interface SubtitleTrackInfo {
  id: number;
  streamIndex: number | null;
  source: "embedded" | "external";
  language: string | null;
  title: string | null;
  isForced: boolean;
  isSdh: boolean;
  format: string | null;
  isText: boolean;
}

export interface MediaFileInfo {
  id: number;
  /** File basename without extension — never the full filesystem path. */
  label: string;
  size: number;
  mtime: number;
  container: string | null;
  duration: number;
  bitrate: number | null;
  version: string | null;
  streams: StreamInfo[];
  subtitles: SubtitleTrackInfo[];
}

export interface MovieDetail extends Movie {
  files: MediaFileInfo[];
}

export interface EpisodeDetail {
  id: number;
  seasonId: number;
  episodeNumber: number;
  episodeEnd: number | null;
  title: string | null;
  synopsis: string | null;
  airDate: string | null;
  duration: number;
  thumbHash: string | null;
  files: MediaFileInfo[];
}

export interface SeasonDetail {
  id: number;
  seasonNumber: number;
  title: string | null;
  posterHash: string | null;
  episodes: EpisodeDetail[];
}

export interface ShowDetail extends Show {
  seasons: SeasonDetail[];
}

// --- per-user state (/api/state) ------------------------------------------

export interface MyListEntry {
  itemType: "movie" | "show";
  itemId: number;
  createdAt: number;
}

export interface RatingEntry {
  itemType: "movie" | "show";
  itemId: number;
  value: number;
  createdAt: number;
}

/** Progress row enriched server-side so the UI never has to resolve an
 *  episode back to its show itself — see src/server/state/userState.ts. */
export interface ProgressSummary {
  itemType: "movie" | "episode";
  itemId: number;
  mediaFileId: number | null;
  position: number;
  duration: number;
  watched: boolean;
  updatedAt: number;
  topType: "movie" | "show";
  topId: number;
  title: string;
  subtitle: string | null;
  posterHash: string | null;
  backdropHash: string | null;
  thumbHash: string | null;
}

export interface UserStateSnapshot {
  myList: MyListEntry[];
  ratings: RatingEntry[];
  progress: ProgressSummary[];
}

// --- per-profile settings (/api/settings) ---------------------------------
// Mirrors src/server/state/settings.ts's PlaybackPrefs as serialised by
// src/app/api/settings/route.ts. The values feed decide()'s track
// preselection (via the play/decision route); the player writes them
// fire-and-forget whenever a track is picked in the TrackMenu.

export interface PlaybackPreferences {
  /** Preferred audio language code ("fra", "eng"…), null = no preference. */
  audioLang: string | null;
  /** Preferred subtitle language code, "off" (explicitly none), or null. */
  subtitleLang: string | null;
}

// --- playback decision (/api/play/decision, /api/play/session) -----------
// Mirrors src/server/playback/decision.ts's `Decision` (server-only module —
// imports better-sqlite3 — so the client can't import it directly; these are
// the plain JSON shapes it actually serialises).

export type PlaybackMode = "direct" | "remux" | "transcode";

export interface PlaybackAudioTrack {
  id: number;
  streamIndex: number;
  language: string | null;
  title: string | null;
  codec: string | null;
  channels: number | null;
  channelLayout: string | null;
  isDefault: boolean;
  supported: boolean;
}

export interface PlaybackSubtitleTrack {
  id: number;
  streamIndex: number | null;
  source: "embedded" | "external";
  language: string | null;
  title: string | null;
  isForced: boolean;
  isSdh: boolean;
  format: string | null;
  requiresBurnIn: boolean;
}

/** Chapter as exposed by /api/play/decision: `end` is derived server-side
 *  (the next chapter's start, or the file duration for the last one) — the
 *  raw ffprobe rows stored in media_files.chapters only carry {start, title}. */
export interface PlaybackChapter {
  start: number;
  end: number;
  title: string | null;
}

export interface PlaybackDecision {
  mode: PlaybackMode;
  fileId: number;
  reason: string;
  url?: string;
  duration: number;
  container: string;
  videoCodec: string | null;
  videoStreamIndex: number | null;
  audioStreamIndex: number | null;
  subtitleId: number | null;
  requiresBurnIn: boolean;
  audioTracks: PlaybackAudioTrack[];
  subtitles: PlaybackSubtitleTrack[];
  chapters: PlaybackChapter[];
}

// --- trickplay (/api/trickplay/[fileId]) ------------------------------------
// Mirrors the public metadata JSON served by src/app/api/trickplay/[fileId]/
// route.ts (sprites are built by src/server/library/trickplay.ts, a
// server-only module the client can't import).

export interface TrickplayMeta {
  /** Seconds between two consecutive sprite tiles. */
  interval: number;
  tileWidth: number;
  tileHeight: number;
  /** Tiles per sprite-grid row. */
  cols: number;
  /** Total number of valid tiles (the grid's last row may be padded). */
  count: number;
  /** Source duration (seconds) at generation time. */
  duration: number;
}

export interface PlaybackSessionResponse {
  mode: PlaybackMode;
  url?: string;
  sessionId?: string;
  playlistUrl?: string;
}

// --- opt-in *arr download integration -------------------------------------
// Mirrors src/server/arr/requests.ts serialisation. `posterUrl` is already the
// same-origin proxy path (/api/arr/poster?u=…), never a raw remote URL, so the
// CSP img-src 'self' holds. All of this is dormant unless the admin enables the
// feature (GET /api/arr/status → { enabled }).

export type ArrRequestStatus = "requested" | "searching" | "downloading" | "importing" | "available" | "failed";

/** Audio-language preference chosen on "Demander" (movies only). "any" keeps the
 *  fast default search; "fr"/"vo" trigger a language-ranked interactive grab. */
export type RequestLanguage = "any" | "fr" | "vo";

/** Quality-tier preference chosen on "Demander" (movies only). "any" leaves the
 *  quality profile to decide; a tier constrains the interactive grab by
 *  resolution (2160p = 4K, sd = below 720p). */
export type RequestQuality = "any" | "2160p" | "1080p" | "720p" | "sd";

// --- real-availability release picker (Demander → langue → qualité) ---------
// The cascading picker offers only what an interactive search actually returned,
// per language then per quality — no guessed/fixed tiers.

/** One available quality tier for a given language, with the best release to grab. */
export interface ReleaseQualityOption {
  quality: Exclude<RequestQuality, "any">;
  label: string;
  /** How many releases exist at this language+tier. */
  count: number;
  /** Best release (highest seeders/size) — the one that gets grabbed. */
  sizeBytes: number;
  seeders: number;
  guid: string;
  indexerId: number;
  title: string;
}

/** One available audio language, with its available quality tiers (best-first). */
export interface ReleaseLanguageOption {
  language: Exclude<RequestLanguage, "any">;
  label: string;
  qualities: ReleaseQualityOption[];
}

/** Response of the release-options probe: what's actually available for a title. */
export interface ReleaseOptions {
  arrId: number;
  /** Whether the probe ADDED the movie to Radarr (→ remove on cancel). */
  wasAdded: boolean;
  title: string;
  year: number | null;
  /** Empty ⇒ « Aucune version disponible ». */
  languages: ReleaseLanguageOption[];
}

/** An external title surfaced by /api/arr/search that isn't in the library. */
export interface ArrDiscoverItem {
  mediaType: "movie" | "show";
  tmdbId: number | null;
  tvdbId: number | null;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  /** Already present in the Flix library (offer "Déjà disponible" instead of "Demander"). */
  inLibrary: boolean;
  /** Non-null when the current household already has an open request for it. */
  requestStatus: ArrRequestStatus | null;
}

export interface ArrRequest {
  id: number;
  mediaType: "movie" | "show";
  title: string;
  year: number | null;
  posterUrl: string | null;
  status: ArrRequestStatus;
  progress: number;
  error: string | null;
  requestedBy: string | null;
  libraryItemId: number | null;
  createdAt: number;
  updatedAt: number;
}

// --- recommendations (/api/recommend) -------------------------------------
// Mirrors src/server/reco/engine.ts's outputs, as serialised by
// src/app/api/recommend/route.ts. Rows carry lightweight {type,id} refs only
// (like Auralis's trackhash-only RecoTrack) — the client resolves them
// against the catalogue it already holds via useCatalog().

export interface RecoItemRef {
  type: "movie" | "show";
  id: number;
}

export interface RecoRow {
  id: string;
  title: string;
  items: RecoItemRef[];
}

export interface RecommendResponse {
  billboard: RecoItemRef | null;
  rows: RecoRow[];
  /** `${type}:${id}` -> match % (0..100), for every scored (non-excluded) item. */
  matchScores: Record<string, number>;
}
