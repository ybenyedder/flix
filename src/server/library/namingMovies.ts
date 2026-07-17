// Pure movie filename/foldername parser — no I/O, fully unit-testable. The
// scanner feeds it a folder name and/or a bare filename (extension included or
// not) and gets back a best-effort title + year.

import { normalizeSeparators, stripExtension, extractTitleYear, sortTitle, type TitleYear } from "./namingCommon";

export type ParsedMovieName = TitleYear;

export { sortTitle };

/**
 * Parse a movie title/year out of a single name (folder or file basename).
 * "Inception (2010) 1080p x265" → { title: "Inception", year: 2010 }.
 * "Amadeus" (no tags at all) → { title: "Amadeus", year: null }.
 */
export function parseMovieName(name: string): ParsedMovieName {
  return extractTitleYear(normalizeSeparators(stripExtension(name)));
}
