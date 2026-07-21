// Online artwork provider — automatic real posters/backdrops/logos for titles
// whose art the scanner could only synthesize from video frames.
//
// This is a DELIBERATE, operator-controlled exception to Flix's historical
// zero-outbound rule (added at the operator's request): playback, browsing and
// telemetry remain 100% local, but missing key art is fetched from public
// metadata services unless the admin turns the toggle off ("Illustrations" in
// Settings). Providers, by preference:
//
//   1. TMDB      — movies AND shows, posters + backdrops + logos, French
//                  variants preferred. Needs the operator's free API key.
//   2. TVmaze    — shows, official posters, keyless.
//   3. Wikipedia — movies, the infobox theatrical poster (fair-use, hosted by
//                  Wikipedia itself), keyless. Coverage is partial by nature.
//
// Same replacement policy as the arr pass (artworkNeeds.ts): only empty or
// frame-generated slots are filled; sidecar/embedded/arr art always wins, and
// "online" art is never refetched. Every fetch is best-effort with a short
// timeout — an unreachable provider can never fail or stall a scan.

import { getDb } from "../db";
import { createLogger } from "../logger";
import { cacheImageBuffer, type ImageKind } from "./images";
import { listTargets } from "./artworkNeeds";

const log = createLogger("online-artwork");

const FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
// Politeness gap between two consecutive titles — a 500-film first scan must
// not hammer anyone.
const TITLE_GAP_MS = 250;
const USER_AGENT = "Flix/self-hosted (offline media server; artwork fetch)";

// ---- settings ---------------------------------------------------------------

const ONLINE_ARTWORK_KEY = "artwork.online";
const TMDB_KEY_KEY = "artwork.tmdbKey";

function getSetting(key: string): string | null {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setSetting(key: string, value: string): void {
  getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** ON by default — the operator opts OUT for a strictly-offline install. */
export function isOnlineArtworkEnabled(): boolean {
  return getSetting(ONLINE_ARTWORK_KEY) !== "0";
}

export function setOnlineArtworkEnabled(enabled: boolean): void {
  setSetting(ONLINE_ARTWORK_KEY, enabled ? "1" : "0");
}

export function getTmdbKey(): string | null {
  const key = getSetting(TMDB_KEY_KEY)?.trim();
  return key ? key : null;
}

export function setTmdbKey(key: string): void {
  setSetting(TMDB_KEY_KEY, key.trim());
}

// ---- pure helpers (unit-tested in test/onlineArtwork.test.ts) ---------------

export interface TmdbImageRecord {
  file_path?: string;
  iso_639_1?: string | null;
  vote_average?: number;
}

export interface TmdbImagesResponse {
  posters?: TmdbImageRecord[];
  backdrops?: TmdbImageRecord[];
  logos?: TmdbImageRecord[];
}

/** Best record of a TMDB images list: French first, then language-neutral,
 *  then English, then whatever leads the list (TMDB pre-sorts by votes). */
export function pickTmdbImage(records: TmdbImageRecord[] | undefined): string | null {
  if (!records || records.length === 0) return null;
  const byLang = (lang: string | null) => records.find((r) => (r.iso_639_1 ?? null) === lang && typeof r.file_path === "string");
  const hit = byLang("fr") ?? byLang(null) ?? byLang("en") ?? records.find((r) => typeof r.file_path === "string");
  return hit?.file_path ?? null;
}

export function tmdbImageUrl(filePath: string, size: "w780" | "w1280" | "original" = "w780"): string {
  return `https://image.tmdb.org/t/p/${size}${filePath}`;
}

/** TVmaze singlesearch payload → poster URL (original preferred). */
export function tvmazePosterUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const image = (payload as { image?: { original?: unknown; medium?: unknown } }).image;
  if (!image || typeof image !== "object") return null;
  const original = image.original;
  const medium = image.medium;
  if (typeof original === "string" && original.startsWith("http")) return original;
  if (typeof medium === "string" && medium.startsWith("http")) return medium;
  return null;
}

/** Wikipedia REST summary payload → infobox image URL, rejecting SVGs (logos,
 *  maps — never a theatrical poster). */
export function wikipediaImageUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const original = (payload as { originalimage?: { source?: unknown } }).originalimage?.source;
  if (typeof original !== "string" || !original.startsWith("http")) return null;
  if (/\.svg$/i.test(new URL(original).pathname)) return null;
  return original;
}

/** First plausible page title of a Wikipedia search response. */
export function wikipediaFirstTitle(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const search = (payload as { query?: { search?: { title?: unknown }[] } }).query?.search;
  const title = search?.[0]?.title;
  return typeof title === "string" && title.length > 0 ? title : null;
}

// ---- effectful --------------------------------------------------------------

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

interface ResolvedArt {
  poster?: string;
  backdrop?: string;
  logo?: string;
}

/** TMDB: search the title, then pull its images. Handles movies and shows. */
async function resolveTmdb(kind: "movie" | "tv", title: string, year: number | null, apiKey: string): Promise<ResolvedArt> {
  const query = new URLSearchParams({ api_key: apiKey, query: title, language: "fr-FR" });
  if (year !== null) query.set(kind === "movie" ? "year" : "first_air_date_year", String(year));
  const search = (await fetchJson(`https://api.themoviedb.org/3/search/${kind}?${query}`)) as { results?: { id?: number }[] } | null;
  const id = search?.results?.[0]?.id;
  if (typeof id !== "number") return {};
  const images = (await fetchJson(`https://api.themoviedb.org/3/${kind}/${id}/images?api_key=${encodeURIComponent(apiKey)}`)) as TmdbImagesResponse | null;
  if (!images) return {};
  const poster = pickTmdbImage(images.posters);
  const backdrop = pickTmdbImage(images.backdrops);
  const logo = pickTmdbImage(images.logos);
  return {
    poster: poster ? tmdbImageUrl(poster, "w780") : undefined,
    backdrop: backdrop ? tmdbImageUrl(backdrop, "w1280") : undefined,
    logo: logo ? tmdbImageUrl(logo, "original") : undefined,
  };
}

async function resolveTvmaze(title: string): Promise<ResolvedArt> {
  const payload = await fetchJson(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}`);
  const poster = tvmazePosterUrl(payload);
  return poster ? { poster } : {};
}

async function resolveWikipedia(title: string, year: number | null): Promise<ResolvedArt> {
  // Search first (handles disambiguation: "The Matrix" vs "The Matrix (film)"),
  // then read the winning page's summary for its infobox image.
  const term = `${title} ${year ?? ""} film`.trim();
  const search = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&format=json&srlimit=1`);
  const page = wikipediaFirstTitle(search);
  if (!page) return {};
  const summary = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.replaceAll(" ", "_"))}`);
  const poster = wikipediaImageUrl(summary);
  return poster ? { poster } : {};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Db = ReturnType<typeof getDb>;

async function enrichTable(db: Db, table: "movies" | "shows", tmdbKey: string | null): Promise<number> {
  const targets = listTargets(db, table);
  if (targets.size === 0) return 0;
  let updated = 0;
  for (const [id, target] of targets) {
    const art: ResolvedArt = tmdbKey
      ? await resolveTmdb(table === "movies" ? "movie" : "tv", target.title, target.year, tmdbKey)
      : table === "movies"
        ? await resolveWikipedia(target.title, target.year)
        : await resolveTvmaze(target.title);

    const slots: { need: boolean; url: string | undefined; kind: ImageKind; column: string }[] = [
      { need: target.needs.poster, url: art.poster, kind: "poster", column: "poster_hash" },
      { need: target.needs.backdrop, url: art.backdrop, kind: "backdrop", column: "backdrop_hash" },
      { need: target.needs.logo, url: art.logo, kind: "logo", column: "logo_hash" },
    ];
    const updates: Record<string, string> = {};
    for (const slot of slots) {
      if (!slot.need || !slot.url) continue;
      const buf = await fetchImage(slot.url);
      if (!buf) continue;
      const hash = await cacheImageBuffer(buf, slot.kind, "online");
      if (hash) updates[slot.column] = hash;
    }
    const columns = Object.keys(updates);
    if (columns.length > 0) {
      db.prepare(`UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...columns.map((c) => updates[c]), id);
      updated++;
    }
    await sleep(TITLE_GAP_MS);
  }
  return updated;
}

let running = false;

/** Fill missing/frame-generated art from online providers. Single-flight,
 *  gated on the admin toggle (ON by default), never throws. */
export async function runOnlineArtworkPass(): Promise<void> {
  if (running) return;
  if (!isOnlineArtworkEnabled()) return;
  running = true;
  try {
    const db = getDb();
    const tmdbKey = getTmdbKey();
    const updated = (await enrichTable(db, "movies", tmdbKey)) + (await enrichTable(db, "shows", tmdbKey));
    if (updated > 0) {
      // Same stamp the image pass uses: rotating imagesAt invalidates the
      // catalogue snapshot so the new art reaches the next /api/library read.
      db.prepare("INSERT INTO settings (key, value) VALUES ('imagesAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now()));
      log.info("online artwork pass complete", { updated, provider: tmdbKey ? "tmdb" : "tvmaze+wikipedia" });
    }
  } catch (error) {
    log.warn("online artwork pass failed", { message: error instanceof Error ? error.message : "unknown" });
  } finally {
    running = false;
  }
}
