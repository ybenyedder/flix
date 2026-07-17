// Shared filesystem helper for the scan phases. Both the upsert phase (sidecar
// image freshness) and the NFO pass need the mtime of an arbitrary file, with a
// missing/unreadable file treated as "no mtime" rather than an error.

import fs from "fs";

export function statMtime(p: string): number | null {
  try {
    return Math.floor(fs.statSync(p).mtimeMs);
  } catch {
    return null;
  }
}
