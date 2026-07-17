// Shared filename-cleaning helpers used by both the movie and show naming
// parsers (movie titles, show/folder titles and episode titles all go through
// the same dot/underscore normalisation and release-tag stripping). Pure, no
// I/O — safe to unit test directly.

/** Quality/codec/audio/language/edition markers that show up after the real
 *  title in scene-style release names. Matched case-insensitively. */
const RELEASE_TAG_RE =
  /\b(2160p|1080p|720p|480p|BluRay|BDRip|BRRip|WEB-?DL|WEBRip|HDTV|REMUX|x26[45]|h\.?26[45]|HEVC|AV1|10bit|HDR10\+?|DoVi|DV|HLG|DTS(?:-HD)?(?:\.?MA)?|TrueHD|Atmos|DDP?[257]\.1|AAC|AC3|EAC3|OPUS|MULTI|VOSTFR|TRUEFRENCH|VFF?|VFQ|FRENCH|SUBBED|PROPER|REPACK|EXTENDED|UNRATED|IMAX|Directors?\.?Cut)\b/i;

/** A bare 19xx/20xx year, used both as a release-tag cut point and to extract
 *  a movie/show year when no more specific "Title (Year)" pattern matches. */
const YEAR_TAG_RE = /\b(?:19|20)\d{2}\b/;

// Numbered (not named) capture groups — named groups need ES2018+ and this
// project targets ES2017.
const TITLE_YEAR_RE = /^(.+?)[ .(_[]+(19\d{2}|20\d{2})\b/;

// A PARENTHESISED/bracketed year is unambiguous, so the title before it is
// matched greedily — "Blade Runner 2049 (2017)" keeps the bare year inside the
// title instead of the non-greedy TITLE_YEAR_RE stopping at 2049. Tried first;
// non-parenthesised years ("Inception 2010") fall through to TITLE_YEAR_RE.
const TITLE_PAREN_YEAR_RE = /^(.+)[([]((?:19|20)\d{2})[)\]]/;

// Articles stripped for sort-title purposes. "L'" elides into the next word
// with no space (L'Auberge), unlike every other article in the list.
const LEADING_ARTICLES_RE = /^(?:(?:Le|La|Les|The|A|An|Un|Une|Der|Die|Das)\s+|L['’]\s*)/i;

export function normalizeSeparators(name: string): string {
  return name.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

export function stripExtension(filename: string): string {
  // A 2–4 char extension, but NEVER a trailing 4-digit year: this helper also
  // runs on folder names ("Dark.2017", "The.Matrix.1999") that have no real
  // extension, and stripping ".2017" would silently drop the year the parser
  // then needs (there's no per-file year fallback for TV shows). Real
  // video/nfo extensions are never 19xx/20xx.
  return filename.replace(/\.(?!(?:19|20)\d{2}$)[a-z0-9]{2,4}$/i, "");
}

/** Cut a cleaned name at the first release/quality/codec/language tag or a
 *  bare year, whichever comes first — whatever precedes it is the title. */
export function cutAtReleaseTag(normalized: string): string {
  const yearMatch = normalized.match(YEAR_TAG_RE);
  const tagMatch = normalized.match(RELEASE_TAG_RE);
  const indices = [yearMatch?.index, tagMatch?.index].filter((i): i is number => typeof i === "number");
  if (!indices.length) return normalized;
  const cut = Math.min(...indices);
  return cut > 0 ? normalized.slice(0, cut).trim() : normalized;
}

export interface TitleYear {
  title: string;
  year: number | null;
}

/** "Title (Year) ...tags" → { title, year }, falling back to a release-tag cut
 *  (no year) when the year pattern doesn't match at all. */
export function extractTitleYear(normalized: string): TitleYear {
  const paren = normalized.match(TITLE_PAREN_YEAR_RE);
  if (paren?.[1] && paren[2]) {
    const title = normalizeSeparators(paren[1]);
    if (title) return { title, year: Number(paren[2]) };
  }
  const match = normalized.match(TITLE_YEAR_RE);
  if (match?.[1] && match[2]) {
    const title = normalizeSeparators(match[1]);
    if (title) return { title, year: Number(match[2]) };
  }
  const title = normalizeSeparators(cutAtReleaseTag(normalized));
  return { title: title || normalized, year: null };
}

/** Strips a leading article for Netflix-style alphabetical sorting: "The Matrix" → "Matrix". */
export function sortTitle(title: string): string {
  const stripped = title.replace(LEADING_ARTICLES_RE, "").trim();
  return stripped || title;
}
