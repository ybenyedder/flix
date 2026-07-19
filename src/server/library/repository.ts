// Read model. Turns the SQLite catalogue into the shape the API/UI consumes.
// Per-account signals (my list, ratings, progress) live in /api/state, never
// here, so this snapshot is USER-INDEPENDENT — identical for every profile —
// and can be built once per library change and memoised/ETag'd across requests.
// (Kids profiles do NOT see it verbatim: GET /api/library filters a copy per
// request and varies its ETag — the memoised object itself stays unfiltered.)

import path from "path";
import { getDb } from "../db";
import { getConfig } from "../config";
import { getScanProgress } from "./scanner";

export interface CatalogActor {
  name: string;
  role: string | null;
}

/** Coarse quality signal (tallest video stream across an item's files) used
 *  for the Card/DetailModal HD/4K/HDR badge — see buildQualityMaps(). */
export interface QualityInfo {
  height: number | null;
  hdr: boolean;
}

export interface CatalogMovie {
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

export interface CatalogShow {
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

interface MovieRow {
  id: number;
  title: string;
  sort_title: string;
  original_title: string | null;
  year: number | null;
  duration: number;
  synopsis: string | null;
  tagline: string | null;
  genres: string | null;
  actors: string | null;
  directors: string | null;
  studio: string | null;
  content_rating: string | null;
  poster_hash: string | null;
  backdrop_hash: string | null;
  thumb_hash: string | null;
  logo_hash: string | null;
  added_at: number;
}

interface ShowRow {
  id: number;
  title: string;
  sort_title: string;
  year: number | null;
  synopsis: string | null;
  genres: string | null;
  actors: string | null;
  studio: string | null;
  content_rating: string | null;
  status: string | null;
  poster_hash: string | null;
  backdrop_hash: string | null;
  logo_hash: string | null;
  added_at: number;
  season_count: number;
  episode_count: number;
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseActors(json: string | null): CatalogActor[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((v): v is { name?: unknown; role?: unknown } => !!v && typeof v === "object")
      .map((v) => ({ name: typeof v.name === "string" ? v.name : "", role: typeof v.role === "string" ? v.role : null }))
      .filter((a) => a.name);
  } catch {
    return [];
  }
}

const NO_QUALITY: QualityInfo = { height: null, hdr: false };

function mapMovie(row: MovieRow, quality: QualityInfo = NO_QUALITY): CatalogMovie {
  return {
    id: row.id,
    type: "movie",
    title: row.title,
    sortTitle: row.sort_title,
    originalTitle: row.original_title,
    year: row.year,
    duration: row.duration,
    synopsis: row.synopsis,
    tagline: row.tagline,
    genres: parseStringArray(row.genres),
    actors: parseActors(row.actors),
    directors: parseStringArray(row.directors),
    studio: row.studio,
    contentRating: row.content_rating,
    posterHash: row.poster_hash,
    backdropHash: row.backdrop_hash,
    thumbHash: row.thumb_hash,
    logoHash: row.logo_hash,
    addedAt: row.added_at,
    quality,
  };
}

function mapShow(row: ShowRow, quality: QualityInfo = NO_QUALITY): CatalogShow {
  return {
    id: row.id,
    type: "show",
    title: row.title,
    sortTitle: row.sort_title,
    year: row.year,
    synopsis: row.synopsis,
    genres: parseStringArray(row.genres),
    actors: parseActors(row.actors),
    studio: row.studio,
    contentRating: row.content_rating,
    status: row.status,
    posterHash: row.poster_hash,
    backdropHash: row.backdrop_hash,
    logoHash: row.logo_hash,
    seasonCount: row.season_count,
    episodeCount: row.episode_count,
    addedAt: row.added_at,
    quality,
  };
}

/** One GROUP BY query per item kind (movies; shows via their episodes) to
 *  find the tallest non-attached-pic video stream and whether any of it is
 *  HDR. Both queries walk the whole streams table, so callers go through
 *  getQualityMaps() below, which memoises the result on the library version
 *  instead of recomputing on every search keystroke / detail open. */
function buildQualityMaps(db: ReturnType<typeof getDb>): { movies: Map<number, QualityInfo>; shows: Map<number, QualityInfo> } {
  const movieRows = db
    .prepare(
      `SELECT mf.movie_id AS id, MAX(s.height) AS height,
              MAX(CASE WHEN s.hdr_format IS NOT NULL AND s.hdr_format != 'SDR' THEN 1 ELSE 0 END) AS hdr
       FROM media_files mf
       JOIN streams s ON s.media_file_id = mf.id AND s.type = 'video' AND s.attached_pic = 0
       WHERE mf.movie_id IS NOT NULL
       GROUP BY mf.movie_id`,
    )
    .all() as { id: number; height: number | null; hdr: number }[];

  const showRows = db
    .prepare(
      `SELECT e.show_id AS id, MAX(s.height) AS height,
              MAX(CASE WHEN s.hdr_format IS NOT NULL AND s.hdr_format != 'SDR' THEN 1 ELSE 0 END) AS hdr
       FROM media_files mf
       JOIN episodes e ON e.id = mf.episode_id
       JOIN streams s ON s.media_file_id = mf.id AND s.type = 'video' AND s.attached_pic = 0
       GROUP BY e.show_id`,
    )
    .all() as { id: number; height: number | null; hdr: number }[];

  return {
    movies: new Map(movieRows.map((r) => [r.id, { height: r.height, hdr: r.hdr === 1 }])),
    shows: new Map(showRows.map((r) => [r.id, { height: r.height, hdr: r.hdr === 1 }])),
  };
}

const MOVIE_SELECT = "SELECT * FROM movies";
const SHOW_SELECT = `
  SELECT s.*,
    (SELECT COUNT(*) FROM seasons se WHERE se.show_id = s.id) AS season_count,
    (SELECT COUNT(*) FROM episodes e WHERE e.show_id = s.id) AS episode_count
  FROM shows s
`;

export interface CatalogSnapshot {
  movies: CatalogMovie[];
  shows: CatalogShow[];
  mediaDir: string;
  scannedAt: string | null;
  countMovies: number;
  countShows: number;
  countEpisodes: number;
}

let cached: { version: string; snapshot: CatalogSnapshot } | null = null;

/** Cheap fingerprint of everything that can change the catalogue body. */
function libraryVersion(db: ReturnType<typeof getDb>): string {
  const movies = (db.prepare("SELECT COUNT(*) AS n FROM movies").get() as { n: number }).n;
  const shows = (db.prepare("SELECT COUNT(*) AS n FROM shows").get() as { n: number }).n;
  const episodes = (db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n;
  const scannedAt = (db.prepare("SELECT value FROM settings WHERE key = 'scannedAt'").get() as { value: string } | undefined)?.value ?? "0";
  // The background image pass (Phase 3) mutates poster/backdrop/thumb/logo
  // hashes WITHOUT touching row counts or scannedAt, so without this the
  // catalogue cache would keep serving null image hashes until the next full
  // rescan — folding in its completion stamp is what makes freshly-extracted
  // covers show up on the very next /api/library read.
  const imagesAt = (db.prepare("SELECT value FROM settings WHERE key = 'imagesAt'").get() as { value: string } | undefined)?.value ?? "0";
  return `${movies}-${shows}-${episodes}-${scannedAt}-${imagesAt}`;
}

// Quality maps memoised on the same key as the snapshot cache. Streams only
// change through a scan (probe pass), and every scan ends by bumping
// scannedAt — which rotates libraryVersion() — so invalidation is automatic
// and repeated searches/detail opens between scans skip both GROUP BYs.
let qualityCached: { version: string; maps: ReturnType<typeof buildQualityMaps> } | null = null;

function getQualityMaps(db: ReturnType<typeof getDb>): ReturnType<typeof buildQualityMaps> {
  const version = libraryVersion(db);
  if (qualityCached && qualityCached.version === version) return qualityCached.maps;
  const maps = buildQualityMaps(db);
  qualityCached = { version, maps };
  return maps;
}

function buildSnapshot(db: ReturnType<typeof getDb>): CatalogSnapshot {
  const { mediaDir } = getConfig();
  const quality = getQualityMaps(db);
  const movies = (db.prepare(`${MOVIE_SELECT} ORDER BY sort_title COLLATE NOCASE`).all() as MovieRow[]).map((row) =>
    mapMovie(row, quality.movies.get(row.id)),
  );
  const shows = (db.prepare(`${SHOW_SELECT} ORDER BY s.sort_title COLLATE NOCASE`).all() as ShowRow[]).map((row) =>
    mapShow(row, quality.shows.get(row.id)),
  );
  const episodeCount = (db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n;
  const scannedAtRow = db.prepare("SELECT value FROM settings WHERE key = 'scannedAt'").get() as { value: string } | undefined;
  const scanProgress = getScanProgress();

  return {
    movies,
    shows,
    mediaDir,
    scannedAt: scannedAtRow?.value ?? scanProgress.scannedAt ?? null,
    countMovies: movies.length,
    countShows: shows.length,
    countEpisodes: episodeCount,
  };
}

/** The shared catalogue. Memoised on the library version, so repeated reads
 *  between scans are effectively free. */
export function getSnapshot(): CatalogSnapshot {
  const db = getDb();
  const version = libraryVersion(db);
  if (cached && cached.version === version) return cached.snapshot;
  const snapshot = buildSnapshot(db);
  cached = { version, snapshot };
  return snapshot;
}

// Weak validator for GET /api/library — mirrors the catalogue cache key, so it
// only changes when the body would.
export function getSnapshotEtag(): string {
  return `W/"${libraryVersion(getDb())}"`;
}

function escapeFts(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 12);
  if (!tokens.length) return "";
  return tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(" ");
}

export interface SearchResults {
  movies: CatalogMovie[];
  shows: CatalogShow[];
}

export function search(query: string, limit = 50): SearchResults {
  const db = getDb();
  const expr = escapeFts(query);
  if (!expr) return { movies: [], shows: [] };

  const hits = db
    .prepare("SELECT item_type, item_id FROM catalog_fts WHERE catalog_fts MATCH ? ORDER BY rank LIMIT ?")
    .all(expr, limit) as { item_type: string; item_id: number }[];
  if (!hits.length) return { movies: [], shows: [] };

  const movieIds = hits.filter((h) => h.item_type === "movie").map((h) => h.item_id);
  const showIds = hits.filter((h) => h.item_type === "show").map((h) => h.item_id);
  const quality = getQualityMaps(db);

  const movies = movieIds.length
    ? (db.prepare(`${MOVIE_SELECT} WHERE id IN (${movieIds.map(() => "?").join(",")})`).all(...movieIds) as MovieRow[]).map((row) =>
        mapMovie(row, quality.movies.get(row.id)),
      )
    : [];
  const shows = showIds.length
    ? (db.prepare(`${SHOW_SELECT} WHERE s.id IN (${showIds.map(() => "?").join(",")})`).all(...showIds) as ShowRow[]).map((row) =>
        mapShow(row, quality.shows.get(row.id)),
      )
    : [];

  const order = new Map(hits.map((h, i) => [`${h.item_type}:${h.item_id}`, i]));
  movies.sort((a, b) => (order.get(`movie:${a.id}`) ?? 0) - (order.get(`movie:${b.id}`) ?? 0));
  shows.sort((a, b) => (order.get(`show:${a.id}`) ?? 0) - (order.get(`show:${b.id}`) ?? 0));

  return { movies, shows };
}

// ---------------------------------------------------------------------------
// Item detail (movie/show): media files + streams + subtitle tracks. Used by
// GET /api/items/movie/[id] and GET /api/items/show/[id] (DetailModal). Still
// user-independent — kids gating is applied by the route, not here.
// ---------------------------------------------------------------------------

export interface CatalogStream {
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

export interface CatalogSubtitleTrack {
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

export interface CatalogMediaFile {
  id: number;
  label: string;
  size: number;
  mtime: number;
  container: string | null;
  duration: number;
  bitrate: number | null;
  version: string | null;
  streams: CatalogStream[];
  subtitles: CatalogSubtitleTrack[];
}

export interface MovieDetail extends CatalogMovie {
  files: CatalogMediaFile[];
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
  files: CatalogMediaFile[];
}

export interface SeasonDetail {
  id: number;
  seasonNumber: number;
  title: string | null;
  posterHash: string | null;
  episodes: EpisodeDetail[];
}

export interface ShowDetail extends CatalogShow {
  seasons: SeasonDetail[];
}

interface StreamRow {
  id: number;
  stream_index: number;
  type: string;
  codec: string | null;
  profile: string | null;
  level: number | null;
  width: number | null;
  height: number | null;
  bit_depth: number | null;
  frame_rate: number | null;
  pixel_format: string | null;
  hdr_format: string | null;
  channels: number | null;
  channel_layout: string | null;
  sample_rate: number | null;
  language: string | null;
  title: string | null;
  bitrate: number | null;
  is_default: number;
  is_forced: number;
  attached_pic: number;
}

function mapStream(row: StreamRow): CatalogStream {
  return {
    id: row.id,
    streamIndex: row.stream_index,
    type: row.type === "audio" || row.type === "subtitle" ? row.type : "video",
    codec: row.codec,
    profile: row.profile,
    level: row.level,
    width: row.width,
    height: row.height,
    bitDepth: row.bit_depth,
    frameRate: row.frame_rate,
    pixelFormat: row.pixel_format,
    hdrFormat: row.hdr_format,
    channels: row.channels,
    channelLayout: row.channel_layout,
    sampleRate: row.sample_rate,
    language: row.language,
    title: row.title,
    bitrate: row.bitrate,
    isDefault: row.is_default === 1,
    isForced: row.is_forced === 1,
    attachedPic: row.attached_pic === 1,
  };
}

interface SubtitleRow {
  id: number;
  stream_index: number | null;
  source: string;
  language: string | null;
  title: string | null;
  is_forced: number;
  is_sdh: number;
  format: string | null;
  is_text: number;
}

function mapSubtitle(row: SubtitleRow): CatalogSubtitleTrack {
  return {
    id: row.id,
    streamIndex: row.stream_index,
    source: row.source === "external" ? "external" : "embedded",
    language: row.language,
    title: row.title,
    isForced: row.is_forced === 1,
    isSdh: row.is_sdh === 1,
    format: row.format,
    isText: row.is_text === 1,
  };
}

interface MediaFileRow {
  id: number;
  filepath: string;
  size: number;
  mtime: number;
  container: string | null;
  duration: number;
  bitrate: number | null;
  version: string | null;
}

const MEDIA_FILE_COLUMNS = "id, filepath, size, mtime, container, duration, bitrate, version";

/** Hydrate streams + subtitle tracks for a whole batch of files at once — one
 *  IN (...) query per child table instead of two queries per file (a
 *  200-episode show used to cost ~400 round-trips per detail open). Returns
 *  the mapped files in the same order as `rows`. */
function mapMediaFiles(db: ReturnType<typeof getDb>, rows: MediaFileRow[]): CatalogMediaFile[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");

  const streamsByFile = new Map<number, CatalogStream[]>();
  const streamRows = db
    .prepare(`SELECT * FROM streams WHERE media_file_id IN (${placeholders}) ORDER BY media_file_id, stream_index`)
    .all(...ids) as (StreamRow & { media_file_id: number })[];
  for (const s of streamRows) {
    const arr = streamsByFile.get(s.media_file_id);
    if (arr) arr.push(mapStream(s));
    else streamsByFile.set(s.media_file_id, [mapStream(s)]);
  }

  const subtitlesByFile = new Map<number, CatalogSubtitleTrack[]>();
  const subtitleRows = db
    .prepare(`SELECT * FROM subtitles WHERE media_file_id IN (${placeholders}) ORDER BY media_file_id, id`)
    .all(...ids) as (SubtitleRow & { media_file_id: number })[];
  for (const s of subtitleRows) {
    const arr = subtitlesByFile.get(s.media_file_id);
    if (arr) arr.push(mapSubtitle(s));
    else subtitlesByFile.set(s.media_file_id, [mapSubtitle(s)]);
  }

  return rows.map((row) => ({
    id: row.id,
    // Basename only — never the absolute filesystem path — so the client
    // gets a human label ("Inception (2010) 1080p x265") without any
    // filesystem layout disclosure beyond what the catalogue already implies.
    label: path.basename(row.filepath, path.extname(row.filepath)),
    size: row.size,
    mtime: row.mtime,
    container: row.container,
    duration: row.duration,
    bitrate: row.bitrate,
    version: row.version,
    streams: streamsByFile.get(row.id) ?? [],
    subtitles: subtitlesByFile.get(row.id) ?? [],
  }));
}

export function getMovieDetail(id: number): MovieDetail | null {
  const db = getDb();
  const row = db.prepare(`${MOVIE_SELECT} WHERE id = ?`).get(id) as MovieRow | undefined;
  if (!row) return null;
  const quality = getQualityMaps(db).movies.get(id);
  const fileRows = db.prepare(`SELECT ${MEDIA_FILE_COLUMNS} FROM media_files WHERE movie_id = ? ORDER BY id`).all(id) as MediaFileRow[];
  return { ...mapMovie(row, quality), files: mapMediaFiles(db, fileRows) };
}

export function getShowDetail(id: number): ShowDetail | null {
  const db = getDb();
  const row = db.prepare(`${SHOW_SELECT} WHERE s.id = ?`).get(id) as ShowRow | undefined;
  if (!row) return null;
  const quality = getQualityMaps(db).shows.get(id);

  const seasonRows = db
    .prepare("SELECT id, season_number, title, poster_hash FROM seasons WHERE show_id = ? ORDER BY season_number")
    .all(id) as { id: number; season_number: number; title: string | null; poster_hash: string | null }[];

  const episodeRows = db
    .prepare(
      "SELECT id, season_id, episode_number, episode_end, title, synopsis, air_date, duration, thumb_hash FROM episodes WHERE show_id = ? ORDER BY season_id, episode_number",
    )
    .all(id) as {
    id: number;
    season_id: number;
    episode_number: number;
    episode_end: number | null;
    title: string | null;
    synopsis: string | null;
    air_date: string | null;
    duration: number;
    thumb_hash: string | null;
  }[];

  const filesByEpisode = new Map<number, CatalogMediaFile[]>();
  if (episodeRows.length) {
    const episodeIds = episodeRows.map((e) => e.id);
    const placeholders = episodeIds.map(() => "?").join(",");
    const fileRows = db
      .prepare(`SELECT ${MEDIA_FILE_COLUMNS}, episode_id FROM media_files WHERE episode_id IN (${placeholders}) ORDER BY id`)
      .all(...episodeIds) as (MediaFileRow & { episode_id: number })[];
    const dtos = mapMediaFiles(db, fileRows);
    fileRows.forEach((f, i) => {
      const arr = filesByEpisode.get(f.episode_id);
      if (arr) arr.push(dtos[i]);
      else filesByEpisode.set(f.episode_id, [dtos[i]]);
    });
  }

  const episodesBySeason = new Map<number, EpisodeDetail[]>();
  for (const e of episodeRows) {
    const dto: EpisodeDetail = {
      id: e.id,
      seasonId: e.season_id,
      episodeNumber: e.episode_number,
      episodeEnd: e.episode_end,
      title: e.title,
      synopsis: e.synopsis,
      airDate: e.air_date,
      duration: e.duration,
      thumbHash: e.thumb_hash,
      files: filesByEpisode.get(e.id) ?? [],
    };
    const arr = episodesBySeason.get(e.season_id);
    if (arr) arr.push(dto);
    else episodesBySeason.set(e.season_id, [dto]);
  }

  const seasons: SeasonDetail[] = seasonRows.map((s) => ({
    id: s.id,
    seasonNumber: s.season_number,
    title: s.title,
    posterHash: s.poster_hash,
    episodes: episodesBySeason.get(s.id) ?? [],
  }));

  return { ...mapShow(row, quality), seasons };
}
