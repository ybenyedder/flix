"use client";

// Client-side naming helpers for the drag-and-drop upload flow. The pure
// parsers below live in the scanner (src/server/library/naming*) but have no
// node/I-O imports, so they bundle safely into the browser — re-exported here
// to keep the server path out of component imports. The path builders mirror
// src/server/upload/targets.ts closely enough for a live rename preview; the
// server re-derives and re-validates the real target, so this stays advisory.

export { parseMovieName } from "@/server/library/namingMovies";
export { matchEpisodePath, parseEpisodeFromFilename } from "@/server/library/namingShows";

import { parseMovieName } from "@/server/library/namingMovies";
import { matchEpisodePath } from "@/server/library/namingShows";

/** Lowercased extension including the leading dot ("Movie.MKV" → ".mkv"), or "" if none. */
export function fileExt(filename: string): string {
  const m = filename.match(/\.[a-z0-9]{2,4}$/i);
  return m ? m[0].toLowerCase() : "";
}

function stripExt(filename: string): string {
  return filename.replace(/\.[a-z0-9]{2,4}$/i, "");
}

/** Same rules as the server's sanitizeSegment: drop path/Windows-reserved
 *  characters and control chars, neutralise `..`, trim leading dots and
 *  trailing dots/spaces, collapse whitespace. Returns "" when nothing survives. */
export function sanitizeSegment(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\.\.+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
}

function pad2(n: number): string {
  return String(Math.max(0, Math.trunc(n))).padStart(2, "0");
}

function titleWithYear(title: string, year: number | null): string {
  const t = sanitizeSegment(title) || "Sans titre";
  return year ? `${t} (${year})` : t;
}

export type UploadDestination = { kind: "movie"; title: string; year: number | null } | { kind: "episode"; show: string; showYear: number | null; season: number };

/** Best-effort prefill from a dropped filename: an SxxEyy/NxNN tag → a series
 *  destination with season/episode filled; otherwise a movie with title/year. */
export interface DroppedGuess {
  destination: UploadDestination;
  /** Episode number when the drop parsed as a series (drives the outgoing filename). */
  episode: number | null;
}

export function guessDestination(filename: string): DroppedGuess {
  const episodeMatch = matchEpisodePath([], filename);
  if (episodeMatch) {
    const parsedShow = parseMovieName(episodeMatch.showFolder);
    return {
      destination: { kind: "episode", show: parsedShow.title, showYear: parsedShow.year, season: episodeMatch.season },
      episode: episodeMatch.episode,
    };
  }
  const movie = parseMovieName(filename);
  return { destination: { kind: "movie", title: movie.title, year: movie.year }, episode: null };
}

/** The filename Flix will actually store for an episode. When the original name
 *  already carries an SxxEyy/NxNN tag it is kept verbatim (the scanner reads it
 *  directly); otherwise we prefix `SxxEyy - ` from the form so the file lands in
 *  its Season folder AND classifies with the right episode number. */
export function buildEpisodeFilename(originalFilename: string, season: number, episode: number): string {
  const ext = fileExt(originalFilename);
  const base = sanitizeSegment(stripExt(originalFilename));
  const hasTag = matchEpisodePath([], originalFilename) !== null;
  if (hasTag) {
    return `${base || "episode"}${ext}`;
  }
  const tag = `S${pad2(season)}E${pad2(episode)}`;
  return `${tag}${base ? ` - ${base}` : ""}${ext}`;
}

/** Advisory library-relative path preview for a movie: movies/Titre (Année)/Titre (Année).ext */
export function movieRelPreview(title: string, year: number | null, ext: string): string {
  const folder = titleWithYear(title, year);
  return `movies/${folder}/${folder}${ext}`;
}

/** Advisory library-relative path preview for an episode: shows/Nom (Année)/Season NN/<filename> */
export function episodeRelPreview(show: string, showYear: number | null, season: number, outgoingFilename: string): string {
  const folder = titleWithYear(show, showYear);
  const safeFile = `${sanitizeSegment(stripExt(outgoingFilename)) || "episode"}${fileExt(outgoingFilename)}`;
  return `shows/${folder}/Season ${pad2(season)}/${safeFile}`;
}
