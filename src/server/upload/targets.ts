// Pure (I/O only in renameOnConflict) helpers that turn an admin's declared
// destination — a movie title/year, or a show + season + dropped filename —
// into the library-relative path the scanner will later classify. Every path
// segment is run through sanitizeSegment so a hostile or messy title can never
// break out of its folder or produce a name the filesystem/scanner rejects.
//
// The layouts here are deliberately the exact shapes parseMovieName /
// matchEpisodePath expect, so a freshly uploaded file classifies correctly on
// the very next scan (asserted in test/upload-targets.test.ts).

import fs from "fs";
import path from "path";

// Windows/Samba reserved device names — a bare segment equal to one of these
// (with or without an extension) is unusable on those hosts, so we prefix it.
const RESERVED_NAMES = new Set<string>([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

// Non-whitespace control characters (incl. DEL). Tab/newline/CR/FF/VT are left
// for the \s+ collapse to turn into a single space rather than being deleted.
const CONTROL_CHARS_RE = /[\x00-\x08\x0e-\x1f\x7f]/g;
const FORBIDDEN_CHARS_RE = /[/\\:*?"<>|]/g;

/**
 * Make a single path segment safe for every filesystem we care about:
 *  - strips the Windows/Unix-forbidden characters `/ \ : * ? " < > |`,
 *  - strips ASCII control characters (incl. DEL),
 *  - collapses any whitespace run to a single space,
 *  - strips leading dots (which also neutralises `.`, `..` and hidden-file
 *    segments) and trailing dots/spaces (Windows forbids both),
 *  - neutralises reserved device names.
 * Returns "" when nothing usable survives — the caller MUST treat an empty
 * result as an invalid name.
 */
export function sanitizeSegment(name: string): string {
  if (typeof name !== "string") return "";
  let s = name.normalize("NFC");
  s = s.replace(FORBIDDEN_CHARS_RE, "");
  s = s.replace(CONTROL_CHARS_RE, "");
  // Collapse whitespace (turns any tabs/newlines into a single space), then
  // peel leading dots/space and trailing dot/space.
  s = s.replace(/\s+/g, " ");
  s = s.replace(/^[.\s]+/, "");
  s = s.replace(/[.\s]+$/, "");
  if (!s) return "";
  // Reserved on the whole name OR on the stem before the first dot ("CON.txt").
  const firstDot = s.indexOf(".");
  const stem = firstDot === -1 ? s : s.slice(0, firstDot);
  if (RESERVED_NAMES.has(s.toLowerCase()) || RESERVED_NAMES.has(stem.toLowerCase())) {
    return `_${s}`;
  }
  return s;
}

/** Lowercase an extension and guarantee a single leading dot; returns "" for a
 *  segment that carries no usable extension. */
export function normalizeExt(ext: string): string {
  const cleaned = ext.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned ? `.${cleaned}` : "";
}

function movieFolderName(title: string, year: number | null): string {
  const safeTitle = sanitizeSegment(title);
  if (!safeTitle) throw new Error("Titre de film invalide");
  return year ? `${safeTitle} (${year})` : safeTitle;
}

/**
 * `movies/Titre (Année)/Titre (Année).ext` — or, with no year,
 * `movies/Titre/Titre.ext`. The folder name and the file basename are
 * identical so parseMovieName reads the same title/year off either.
 */
export function movieTargetRel(title: string, year: number | null, ext: string): string {
  const folder = movieFolderName(title, year);
  const extension = normalizeExt(ext);
  if (!extension) throw new Error("Extension de fichier invalide");
  return `movies/${folder}/${folder}${extension}`;
}

/**
 * `shows/Nom (Année)/Season NN/<filename>`. The dropped filename is kept as-is
 * (it carries the SxxEyy tag matchEpisodePath needs) apart from a basename
 * sanitize; its extension is preserved and lowercased.
 */
export function episodeTargetRel(show: string, showYear: number | null, season: number, filename: string): string {
  const safeShow = sanitizeSegment(show);
  if (!safeShow) throw new Error("Nom de série invalide");
  if (!Number.isInteger(season) || season < 0) throw new Error("Numéro de saison invalide");

  const showFolder = showYear ? `${safeShow} (${showYear})` : safeShow;
  const seasonFolder = `Season ${String(season).padStart(2, "0")}`;
  const safeFile = sanitizeFilename(filename);
  return `shows/${showFolder}/${seasonFolder}/${safeFile}`;
}

/** Sanitize a filename's basename while preserving (and lowercasing) its
 *  extension. Throws when nothing usable is left of the basename. */
export function sanitizeFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const hasExt = dot > 0; // dot at index 0 is a dotfile, not an extension
  const rawBase = hasExt ? filename.slice(0, dot) : filename;
  const rawExt = hasExt ? filename.slice(dot) : "";
  const base = sanitizeSegment(rawBase);
  if (!base) throw new Error("Nom de fichier invalide");
  return `${base}${normalizeExt(rawExt)}`;
}

/**
 * Given an ABSOLUTE target path that already exists, return the first free
 * sibling with ` (2)`, ` (3)`… inserted before the extension. Returns the input
 * untouched when it is free. Both input and output are absolute paths.
 */
export function renameOnConflict(absPath: string): string {
  if (!fs.existsSync(absPath)) return absPath;
  const dir = path.dirname(absPath);
  const ext = path.extname(absPath);
  const base = path.basename(absPath, ext);
  for (let n = 2; n < 10_000; n++) {
    const candidate = path.join(dir, `${base} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Trop de fichiers en conflit à cet emplacement");
}
