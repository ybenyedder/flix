// Path safety helpers for the streaming/subtitle layer. Every filesystem access
// derived from a client-supplied path (a media_files.filepath from the DB, which
// is itself scanner-controlled, but still validated defensively) goes through
// resolveLibraryPath/resolveRealLibraryPath, which guarantee the result stays
// inside the media root. Adapted from
// /home/pc/Documents/auralis_enterprise_grade/src/server/paths.ts.

import fs from "fs";
import path from "path";
import { getConfig } from "./config";
import { VIDEO_EXTENSIONS as VIDEO_EXTENSION_LIST } from "@/lib/flix/videoFormats";

// Membership test built from the shared, client-safe extension list so the
// upload UI, the scanner and this guard can never drift apart on what counts
// as a video. Behaviour is identical to the previous inline literal set.
const VIDEO_EXTENSIONS = new Set<string>(VIDEO_EXTENSION_LIST);

/** Resolve a library-relative path to an absolute path, or null if it escapes the root. */
export function resolveLibraryPath(relativePath: string): string | null {
  const root = getConfig().mediaDir;
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

/**
 * Resolve a library-relative path and verify its *real* (symlink-followed) location
 * still lives inside the media root. The lexical {@link resolveLibraryPath} guard
 * blocks `..` traversal, but a symlink inside the library can point outside it; this
 * follows the link with realpath and re-checks containment to stop exfiltration.
 * Returns null if the path escapes the root or the file does not exist.
 */
export async function resolveRealLibraryPath(relativePath: string): Promise<string | null> {
  const lexicalPath = resolveLibraryPath(relativePath);
  if (!lexicalPath) return null;

  try {
    const root = await fs.promises.realpath(/*turbopackIgnore: true*/ getConfig().mediaDir);
    const real = await fs.promises.realpath(/*turbopackIgnore: true*/ lexicalPath);
    const relative = path.relative(root, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return real;
  } catch {
    // realpath throws on a missing file (ENOENT) or broken symlink — treat as absent.
    return null;
  }
}

/**
 * Same containment guarantee as {@link resolveRealLibraryPath}, but for a path
 * that is already ABSOLUTE (e.g. `subtitles.external_path`, recorded by the
 * scanner as an absolute filesystem path rather than a library-relative one).
 * Re-derives a mediaDir-relative path first so the exact same realpath
 * containment check applies — a sidecar subtitle is just as capable of being a
 * symlink escape as the media file it rides along with.
 */
export async function resolveRealAbsolutePath(absPath: string): Promise<string | null> {
  const relative = path.relative(getConfig().mediaDir, absPath);
  return resolveRealLibraryPath(relative);
}

export function isSupportedVideoPath(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Canonical container id derived from the file extension — used to match
 *  against a client's declared `ClientCaps.containers`. Deliberately extension-based
 *  rather than ffprobe's `format_name` (which reports comma-separated demuxer
 *  aliases like "mov,mp4,m4a,3gp,3g2,mj2" — not a single stable identifier, and
 *  webm/mkv share the same matroska demuxer name despite being different
 *  containers as far as browser support is concerned). */
export function videoContainerId(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "mp4";
    case ".mkv":
      return "mkv";
    case ".webm":
      return "webm";
    case ".mov":
      return "mov";
    case ".avi":
      return "avi";
    case ".ts":
    case ".m2ts":
      return "ts";
    case ".wmv":
      return "wmv";
    case ".flv":
      return "flv";
    case ".ogv":
      return "ogg";
    default:
      return "unknown";
  }
}

export function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".mkv":
      return "video/x-matroska";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".avi":
      return "video/x-msvideo";
    case ".ts":
    case ".m2ts":
      return "video/mp2t";
    case ".wmv":
      return "video/x-ms-wmv";
    case ".flv":
      return "video/x-flv";
    case ".ogv":
      return "video/ogg";
    default:
      return "application/octet-stream";
  }
}
