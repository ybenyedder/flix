// Pure TV episode filename/foldername parser — no I/O, fully unit-testable.
// The scanner feeds it the chain of relative directory names leading to a file
// plus the filename itself, and gets back season/episode numbers, the show's
// root folder and a best-effort episode title.

import { normalizeSeparators, stripExtension, extractTitleYear, cutAtReleaseTag, sortTitle, type TitleYear } from "./namingCommon";

export { sortTitle };

export type ParsedShowName = TitleYear;

export function parseShowFolderName(folderName: string): ParsedShowName {
  return extractTitleYear(normalizeSeparators(stripExtension(folderName)));
}

// "S01E01", "S1E1", "S01 E01", "S01E01-E02", "S01E01-02" (case-insensitive).
const SXXEYY_RE = /\bS(\d{1,2})\s?E(\d{1,3})(?:[-E ]+E?(\d{1,3}))?\b/i;
// "1x01" (case-insensitive "x"). Requires a word boundary on both sides so it
// doesn't fire inside a resolution string like "1920x1080".
const NXNN_RE = /\b(\d{1,2})x(\d{2,3})\b/i;
// "Season 01", "Saison 1", "S01", or the bare "Specials" folder → season 0.
const SEASON_FOLDER_RE = /^(?:Season|Saison|S)\s*(\d{1,2})$/i;
const SPECIALS_RE = /^specials?$/i;
// A season-folder file named by its bare episode number: "01 - Pilot.mkv".
const LEADING_EPISODE_NUM_RE = /^(\d{1,3})\b/;

function cleanEpisodeTitle(raw: string): string | null {
  const stripped = raw.replace(/^[\s-]+/, "");
  const title = normalizeSeparators(cutAtReleaseTag(stripped));
  return title.length ? title : null;
}

export interface ParsedEpisodeFromFilename {
  season: number;
  episode: number;
  episodeEnd: number | null;
  episodeTitle: string | null;
}

/** Look for an embedded SxxEyy or NxNN pattern anywhere in a (already
 *  extension-stripped) filename. Returns null if neither pattern is found. */
export function parseEpisodeFromFilename(base: string): ParsedEpisodeFromFilename | null {
  const normalized = normalizeSeparators(base);

  const sxe = normalized.match(SXXEYY_RE);
  if (sxe && sxe.index !== undefined) {
    const after = normalized.slice(sxe.index + sxe[0].length);
    return {
      season: Number(sxe[1]),
      episode: Number(sxe[2]),
      episodeEnd: sxe[3] ? Number(sxe[3]) : null,
      episodeTitle: cleanEpisodeTitle(after),
    };
  }

  const nxn = normalized.match(NXNN_RE);
  if (nxn && nxn.index !== undefined) {
    const after = normalized.slice(nxn.index + nxn[0].length);
    return {
      season: Number(nxn[1]),
      episode: Number(nxn[2]),
      episodeEnd: null,
      episodeTitle: cleanEpisodeTitle(after),
    };
  }

  return null;
}

export interface ParsedSeasonFolder {
  season: number;
}

/** "Season 01" / "Saison 1" / "S01" / "Specials" → a season number (0 for Specials). */
export function parseSeasonFolder(dirName: string): ParsedSeasonFolder | null {
  const trimmed = dirName.trim();
  if (SPECIALS_RE.test(trimmed)) return { season: 0 };
  const match = trimmed.match(SEASON_FOLDER_RE);
  return match ? { season: Number(match[1]) } : null;
}

export interface ParsedEpisodeFromSeasonFolder {
  episode: number;
  episodeTitle: string | null;
}

/** Fallback used only inside a season folder: the filename itself carries no
 *  SxxEyy/NxNN tag, so the episode number is whatever bare number it starts with. */
export function parseEpisodeFromSeasonFolder(base: string): ParsedEpisodeFromSeasonFolder | null {
  const normalized = normalizeSeparators(base);
  const match = normalized.match(LEADING_EPISODE_NUM_RE);
  if (!match) return null;
  return { episode: Number(match[1]), episodeTitle: cleanEpisodeTitle(normalized.slice(match[0].length)) };
}

/** A loose episode at the library root has no show folder to name the show —
 *  derive one from the filename by cutting at the episode tag
 *  ("Dark.S01E01.mkv" → "Dark") so every loose episode of the same show
 *  groups under ONE show instead of one pseudo-show per file. Falls back to
 *  the whole base name when the tag leads ("S01E01.mkv"). */
function showFolderFromFilename(base: string): string {
  const normalized = normalizeSeparators(base);
  const tag = normalized.match(SXXEYY_RE) ?? normalized.match(NXNN_RE);
  if (tag && tag.index !== undefined && tag.index > 0) {
    const cut = normalizeSeparators(normalized.slice(0, tag.index).replace(/[\s-]+$/, ""));
    if (cut) return cut;
  }
  return base;
}

export interface EpisodeMatch {
  /** Relative (posix) folder that represents the show root — one level above
   *  a "Season NN" folder when there is one, otherwise the episode's own parent. */
  showFolder: string;
  season: number;
  episode: number;
  episodeEnd: number | null;
  episodeTitle: string | null;
}

/**
 * Classify a video file as a TV episode from its path. `dirParts` is the
 * chain of relative directory names from the library root down to (and
 * including) the file's immediate parent; `filename` includes the extension.
 * Returns null when nothing episode-shaped is found — the caller should then
 * treat the file as a movie.
 */
export function matchEpisodePath(dirParts: string[], filename: string): EpisodeMatch | null {
  const base = stripExtension(filename);
  const parentDir = dirParts.length ? dirParts[dirParts.length - 1] : undefined;
  const seasonFolder = parentDir !== undefined ? parseSeasonFolder(parentDir) : null;
  const showDirParts = seasonFolder ? dirParts.slice(0, -1) : dirParts;
  const showFolder = showDirParts.join("/") || showFolderFromFilename(base);

  const fromFilename = parseEpisodeFromFilename(base);
  if (fromFilename) {
    return {
      showFolder,
      season: seasonFolder ? seasonFolder.season : fromFilename.season,
      episode: fromFilename.episode,
      episodeEnd: fromFilename.episodeEnd,
      episodeTitle: fromFilename.episodeTitle,
    };
  }

  if (seasonFolder) {
    const fromFolder = parseEpisodeFromSeasonFolder(base);
    if (fromFolder) {
      return {
        showFolder,
        season: seasonFolder.season,
        episode: fromFolder.episode,
        episodeEnd: null,
        episodeTitle: fromFolder.episodeTitle,
      };
    }
  }

  return null;
}
