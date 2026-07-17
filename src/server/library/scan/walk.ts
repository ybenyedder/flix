// Directory walk phase of the library scanner. Crawls the media root and
// returns every playable video plus the metadata the incremental scan needs
// (sizes, mtimes, per-directory mtimes, and whether the crawl was truncated or
// hit unreadable subtrees). Extracted from scanner.ts, which orchestrates the
// phases; this module owns no shared scan state.

import fs from "fs";
import path from "path";
import { getConfig } from "../../config";
import { createLogger } from "../../logger";
import { VIDEO_EXTENSIONS as VIDEO_EXTENSION_LIST } from "@/lib/flix/videoFormats";

const log = createLogger("scanner");

// The playable-container allowlist lives in one place (videoFormats.ts, shared
// with the path guard and the upload manager); build a Set here for O(1) lookup.
const VIDEO_EXTENSIONS = new Set(VIDEO_EXTENSION_LIST);
const SAMPLE_RE = /\bsample\b/i;

export interface WalkedVideo {
  abs: string;
  rel: string; // posix, relative to mediaDir
  size: number;
  mtime: number;
  dirParts: string[]; // posix relative dir segments, e.g. ["Dark (2017)", "Season 01"]
  filename: string;
}

export interface WalkResult {
  videos: WalkedVideo[];
  /** I/O failures that hid part of a tree that may still exist (EACCES, EIO,
   *  …) — NOT plain ENOENT (a vanished entry / broken symlink really is gone).
   *  Any non-zero count makes the prune phase unsafe and it is skipped. */
  walkErrors: number;
  /** The walk stopped at maxScanFiles — unvisited files must not be pruned. */
  truncated: boolean;
  /** mtime (ms) of every directory visited, keyed by posix relative path ("" =
   *  root) — lets the sidecar refresh detect "a file was dropped in here since
   *  the last scan" without a second stat pass. */
  dirMtimes: Map<string, number>;
}

// Async walk: readdir/stat via promises so the directory crawl yields to the
// event loop between I/O ops instead of blocking it for the whole tree.
//
// Symlinks are followed (grafting other disks/folders into the library via
// links is common self-hosting practice; a Dirent from withFileTypes reports a
// symlink as neither directory nor file, so without an explicit stat() they'd
// be silently invisible) — but only when the target's realpath stays INSIDE
// the media root. That mirrors the containment policy resolveRealLibraryPath
// (src/server/paths.ts) enforces at stream time: a link escaping the root
// would be indexed but never served (404 on play), so it's skipped up front.
export async function walk(root: string): Promise<WalkResult> {
  const { maxScanFiles, maxScanDepth } = getConfig();
  const out: WalkedVideo[] = [];
  const dirMtimes = new Map<string, number>();

  // An EXISTING but unreadable subtree (unmounted sub-mount, NFS EIO, EACCES)
  // must not read as "those files were deleted": every non-ENOENT walk failure
  // is counted so runScan() can refuse to prune. First occurrence of each
  // errno is logged; the rest just count.
  let walkErrors = 0;
  const warnedCodes = new Set<string>();
  const recordWalkError = (op: string, target: string, error: unknown): void => {
    const code = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    if (code === "ENOENT") return; // genuinely gone — pruning it stays correct
    walkErrors++;
    if (!warnedCodes.has(code)) {
      warnedCodes.add(code);
      log.warn("walk error — part of the library may be unreadable", { op, code, path: target });
    }
  };

  let rootReal: string;
  try {
    rootReal = await fs.promises.realpath(root);
  } catch (error) {
    // missing/unreadable root — same "empty library" degradation as before,
    // but an unREADABLE root also blocks the prune phase via walkErrors.
    recordWalkError("realpath", root, error);
    return { videos: out, walkErrors, truncated: false, dirMtimes };
  }
  const staysInRoot = (real: string): boolean => {
    const relative = path.relative(rootReal, real);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  };

  // Realpaths of every directory already descended into — never re-enter one,
  // so a link cycle (a symlink pointing at an ancestor) can't loop the walk,
  // and two links to the same target can't double-index its files.
  const visitedDirs = new Set<string>();

  const recurse = async (dir: string, dirParts: string[], depth: number): Promise<void> => {
    if (out.length >= maxScanFiles || depth > maxScanDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      recordWalkError("readdir", dir, error);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let linkStat: fs.Stats | null = null;
      if (entry.isSymbolicLink()) {
        try {
          linkStat = await fs.promises.stat(abs); // follows the link
        } catch (error) {
          recordWalkError("stat", abs, error); // ENOENT = broken symlink: benign, not counted
          continue;
        }
        isDir = linkStat.isDirectory();
        isFile = linkStat.isFile();
      }

      if (isDir) {
        await enterDirectory(abs, [...dirParts, entry.name], depth + 1);
        if (out.length >= maxScanFiles) return;
        continue;
      }
      if (!isFile) continue;
      if (!VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (SAMPLE_RE.test(entry.name)) continue;
      // Same containment policy as directories: a symlinked video whose real
      // location escapes the root would be unplayable — don't index it.
      if (linkStat) {
        try {
          if (!staysInRoot(await fs.promises.realpath(abs))) continue;
        } catch (error) {
          recordWalkError("realpath", abs, error);
          continue;
        }
      }
      let stat = linkStat;
      if (!stat) {
        try {
          stat = await fs.promises.stat(abs);
        } catch (error) {
          recordWalkError("stat", abs, error);
          continue;
        }
      }
      out.push({
        abs,
        rel: [...dirParts, entry.name].join("/"),
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs),
        dirParts,
        filename: entry.name,
      });
      if (out.length >= maxScanFiles) return;
    }
  };

  // Containment + cycle guard live here so plain AND symlinked directories go
  // through the exact same checks before descent.
  const enterDirectory = async (abs: string, dirParts: string[], depth: number): Promise<void> => {
    let real: string;
    try {
      real = await fs.promises.realpath(abs);
    } catch (error) {
      recordWalkError("realpath", abs, error); // ENOENT = vanished between readdir and descent
      return;
    }
    if (!staysInRoot(real) || visitedDirs.has(real)) return;
    visitedDirs.add(real);
    try {
      dirMtimes.set(dirParts.join("/"), Math.floor((await fs.promises.stat(abs)).mtimeMs));
    } catch {
      // mtime unavailable — the sidecar refresh just skips this directory
    }
    await recurse(abs, dirParts, depth);
  };

  await enterDirectory(root, [], 0);
  return { videos: out, walkErrors, truncated: out.length >= maxScanFiles, dirMtimes };
}
