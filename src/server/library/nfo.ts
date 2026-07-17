// Kodi-style NFO parsing (movie.nfo / tvshow.nfo / <episode>.nfo). Pure text
// in, plain data out — the returned strings are NEVER meant to be rendered as
// HTML (no dangerouslySetInnerHTML downstream, ever). fast-xml-parser has no
// DTD/network fetch support at all, so there is no way for a hostile NFO to
// make this process reach out to the network (no XXE surface to begin with);
// remote-looking fields (<thumb>, <uniqueid>) are simply never read.

import fs from "fs";
import { XMLParser } from "fast-xml-parser";
import { createLogger } from "../logger";

const log = createLogger("nfo");

const MAX_NFO_BYTES = 5 * 1024 * 1024;
const TITLE_MAX = 500;
const PLOT_MAX = 5000;
const SHORT_MAX = 200;

type XmlValue = string | XmlValue[] | { [key: string]: XmlValue };

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === "genre" || name === "actor" || name === "director",
});

function parseXml(xml: string): Record<string, XmlValue> | null {
  try {
    return parser.parse(xml) as Record<string, XmlValue>;
  } catch (error) {
    log.warn("malformed NFO XML", { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function asString(v: XmlValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function truncate(v: string | undefined, max: number): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function toList(v: XmlValue | undefined): XmlValue[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function toStringArray(v: XmlValue | undefined, max = 30): string[] {
  const out: string[] = [];
  for (const item of toList(v)) {
    const t = truncate(asString(item), 100);
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export interface NfoActor {
  name: string;
  role: string | null;
}

function toActors(v: XmlValue | undefined, max = 50): NfoActor[] {
  const out: NfoActor[] = [];
  for (const item of toList(v)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = truncate(asString(item.name), SHORT_MAX);
    if (!name) continue;
    out.push({ name, role: truncate(asString(item.role), SHORT_MAX) });
    if (out.length >= max) break;
  }
  return out;
}

function parseYear(yearVal: XmlValue | undefined, dateVal: XmlValue | undefined): number | null {
  const y = asString(yearVal);
  if (y) {
    const n = Number.parseInt(y, 10);
    if (Number.isInteger(n) && n > 1870 && n < 2100) return n;
  }
  const d = asString(dateVal);
  if (d) {
    const m = d.match(/^(\d{4})/);
    if (m) {
      const n = Number(m[1]);
      if (n > 1870 && n < 2100) return n;
    }
  }
  return null;
}

function parseRuntime(v: XmlValue | undefined): number | null {
  const s = asString(v);
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface NfoMovie {
  title: string | null;
  originalTitle: string | null;
  year: number | null;
  plot: string | null;
  tagline: string | null;
  runtime: number | null;
  genres: string[];
  actors: NfoActor[];
  directors: string[];
  studio: string | null;
  contentRating: string | null;
  premiered: string | null;
}

export function parseMovieNfo(xml: string): NfoMovie | null {
  const parsed = parseXml(xml);
  const root = parsed?.movie;
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  return {
    title: truncate(asString(root.title), TITLE_MAX),
    originalTitle: truncate(asString(root.originaltitle), TITLE_MAX),
    year: parseYear(root.year, root.premiered ?? root.releasedate),
    plot: truncate(asString(root.plot) ?? asString(root.outline), PLOT_MAX),
    tagline: truncate(asString(root.tagline), TITLE_MAX),
    runtime: parseRuntime(root.runtime),
    genres: toStringArray(root.genre),
    actors: toActors(root.actor),
    directors: toStringArray(root.director),
    studio: truncate(asString(root.studio), SHORT_MAX),
    contentRating: truncate(asString(root.mpaa), 50),
    premiered: truncate(asString(root.premiered), 20),
  };
}

export interface NfoShow {
  title: string | null;
  year: number | null;
  plot: string | null;
  genres: string[];
  actors: NfoActor[];
  studio: string | null;
  contentRating: string | null;
  status: string | null;
  premiered: string | null;
}

export function parseTvShowNfo(xml: string): NfoShow | null {
  const parsed = parseXml(xml);
  const root = parsed?.tvshow;
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  return {
    title: truncate(asString(root.title), TITLE_MAX),
    year: parseYear(root.year, root.premiered),
    plot: truncate(asString(root.plot) ?? asString(root.outline), PLOT_MAX),
    genres: toStringArray(root.genre),
    actors: toActors(root.actor),
    studio: truncate(asString(root.studio), SHORT_MAX),
    contentRating: truncate(asString(root.mpaa), 50),
    status: truncate(asString(root.status), 50),
    premiered: truncate(asString(root.premiered), 20),
  };
}

export interface NfoEpisode {
  title: string | null;
  plot: string | null;
  season: number | null;
  episode: number | null;
  aired: string | null;
}

function parseIntOrNull(v: XmlValue | undefined): number | null {
  const s = asString(v);
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseEpisodeNfo(xml: string): NfoEpisode | null {
  const parsed = parseXml(xml);
  const root = parsed?.episodedetails;
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  return {
    title: truncate(asString(root.title), TITLE_MAX),
    plot: truncate(asString(root.plot) ?? asString(root.outline), PLOT_MAX),
    season: parseIntOrNull(root.season),
    episode: parseIntOrNull(root.episode),
    aired: truncate(asString(root.aired), 20),
  };
}

/** Read an NFO file capped to MAX_NFO_BYTES — a giant file with that
 *  extension has no legitimate reason to exist and isn't worth parsing. */
export function readNfoFile(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_NFO_BYTES) return null;
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}
