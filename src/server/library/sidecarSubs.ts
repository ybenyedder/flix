// External subtitle sidecar detection: "Movie.srt", "Movie.fr.srt",
// "Movie.fre.forced.srt", "Movie.fr.sdh.srt", plus a "Subs/"-style folder
// adjacent to the media file. Pure filesystem read, no network, no shelling out.

import fs from "fs";
import path from "path";

export type SidecarFormat = "subrip" | "webvtt" | "ass" | "vobsub";

const SUB_EXTENSIONS: Record<string, SidecarFormat> = {
  ".srt": "subrip",
  ".vtt": "webvtt",
  ".ass": "ass",
  ".ssa": "ass",
  ".sub": "vobsub",
};

/** Exported for the scanner's changed-directory check: a subtitle dropped into
 *  one of these folders bumps THAT folder's mtime, not the video's parent. */
export const SIDECAR_DIR_NAMES = ["Subs", "subs", "Subtitles", "subtitles"];

/** Exported for the walk phase: editing a subtitle IN PLACE changes the file's
 *  mtime but not its parent directory's (POSIX only bumps a dir's mtime on
 *  entry create/delete/rename), so the walk folds sub-file mtimes into its
 *  per-directory freshness map — without this, an edited .srt would keep
 *  serving its stale cached VTT forever. */
export const SUB_FILE_EXTENSIONS = Object.keys(SUB_EXTENSIONS);

export interface SidecarSubtitle {
  path: string; // absolute
  language: string | null;
  isForced: boolean;
  isSdh: boolean;
  format: SidecarFormat;
}

function buildSidecar(absPath: string, format: SidecarFormat, tags: string[]): SidecarSubtitle {
  let language: string | null = null;
  let isForced = false;
  let isSdh = false;
  for (const tag of tags) {
    if (/^forced$/i.test(tag)) {
      isForced = true;
      continue;
    }
    if (/^sdh$/i.test(tag)) {
      isSdh = true;
      continue;
    }
    if (!language && /^[a-z]{2,3}$/i.test(tag)) language = tag.toLowerCase();
  }
  return { path: absPath, language, isForced, isSdh, format };
}

function scanDir(targetDir: string, baseName: string | null, out: SidecarSubtitle[]): void {
  let entries: string[];
  try {
    // Media-library path resolved at request/scan time, never a build-time
    // dependency — must not be statically traced by Next's file tracer.
    entries = fs.readdirSync(/*turbopackIgnore: true*/ targetDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    const format = SUB_EXTENSIONS[ext];
    if (!format) continue;
    const stem = entry.slice(0, entry.length - ext.length);

    let tags: string[];
    if (baseName !== null) {
      // Directly next to the video: only names sharing its basename qualify
      // ("Movie.srt", "Movie.fr.srt"), everything after the shared prefix is tags.
      if (stem !== baseName && !stem.startsWith(`${baseName}.`)) continue;
      tags = stem === baseName ? [] : stem.slice(baseName.length + 1).split(".").filter(Boolean);
    } else {
      // A dedicated Subs/ folder: no shared basename to strip, the whole stem is tags.
      tags = stem.split(".").filter(Boolean);
    }
    out.push(buildSidecar(path.join(targetDir, entry), format, tags));
  }
}

/** Find every external subtitle file associated with a media file: same-name
 *  siblings in its own folder, plus anything in an adjacent Subs/ folder. */
export function findSidecarSubtitles(mediaAbsPath: string): SidecarSubtitle[] {
  const dir = path.dirname(mediaAbsPath);
  const baseName = path.basename(mediaAbsPath, path.extname(mediaAbsPath));
  const out: SidecarSubtitle[] = [];
  scanDir(dir, baseName, out);
  for (const sub of SIDECAR_DIR_NAMES) scanDir(path.join(dir, sub), null, out);
  return out;
}
