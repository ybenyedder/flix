// Cache GC phase: sweep the image store, its width-bucketed webp variants, and
// the trickplay cache of anything no longer referenced by the DB, and drop the
// matching `images` rows. Runs last, entirely best-effort: any single failure
// can neither fail the scan nor stop the rest of the sweep.

import fs from "fs";
import path from "path";
import type { Database as DB } from "better-sqlite3";
import { getConfig } from "../../config";
import { createLogger } from "../../logger";

const log = createLogger("scanner");

const IMAGE_HASH_RE = /^[a-f0-9]{40}$/;
const IMAGE_VARIANT_RE = /^([a-f0-9]{40})_\d+\.webp$/;
const TRICKPLAY_ENTRY_RE = /^(\d+)-\d+\.(?:jpg|json)$/;

/** Every (table, column) pair that can hold a reference into the image store.
 *  subtitles.vtt_hash is deliberately NOT here: it addresses the separate
 *  cacheDir/subs VTT cache, never a file in imagesDir. */
const IMAGE_HASH_COLUMNS: [table: string, column: string][] = [
  ["movies", "poster_hash"],
  ["movies", "backdrop_hash"],
  ["movies", "thumb_hash"],
  ["movies", "logo_hash"],
  ["shows", "poster_hash"],
  ["shows", "backdrop_hash"],
  ["shows", "logo_hash"],
  ["seasons", "poster_hash"],
  ["episodes", "thumb_hash"],
];

// Nothing ever deleted from the image store or the trickplay cache before this:
// a replaced poster (new hash) or a removed movie left its files — and its
// `images` row — behind forever, a monotonic datadir leak. Runs at the end of
// every scan, after prune, entirely best-effort: a failure to delete any single
// file can neither fail the scan nor stop the rest of the sweep.
export async function runCacheGc(db: DB): Promise<void> {
  // Never sweep while the background image pass is writing: a hash cached
  // between our reference collection and its *_hash column update would be
  // deleted from under it. The next scan's GC picks the garbage up instead.
  try {
    const { isImagesPassRunning } = await import("../imagesPass");
    if (isImagesPassRunning()) {
      log.info("cache gc skipped: image pass in flight");
      return;
    }
  } catch {
    return; // image pass module unavailable — skip rather than risk racing it
  }

  const { imagesDir, cacheDir } = getConfig();
  const referenced = new Set<string>();
  for (const [table, column] of IMAGE_HASH_COLUMNS) {
    for (const row of db.prepare(`SELECT DISTINCT ${column} AS hash FROM ${table} WHERE ${column} IS NOT NULL`).all() as { hash: string }[]) {
      referenced.add(row.hash);
    }
  }

  let removedRows = 0;
  let removedFiles = 0;
  let failures = 0;
  const rmFile = (abs: string): void => {
    try {
      fs.rmSync(abs, { force: true });
      removedFiles++;
    } catch {
      failures++;
    }
  };

  try {
    const delImage = db.prepare("DELETE FROM images WHERE hash = ?");
    for (const { hash } of db.prepare("SELECT hash FROM images").all() as { hash: string }[]) {
      if (referenced.has(hash)) continue;
      try {
        delImage.run(hash);
        removedRows++;
      } catch {
        failures++;
      }
    }
  } catch {
    failures++;
  }

  // Originals (files named by their bare content hash) + stale atomic-write temps.
  try {
    for (const entry of fs.readdirSync(imagesDir)) {
      if (IMAGE_HASH_RE.test(entry) && !referenced.has(entry)) rmFile(path.join(imagesDir, entry));
      else if (entry.includes(".tmp-")) rmFile(path.join(imagesDir, entry));
    }
  } catch {
    failures++;
  }

  // Width-bucketed webp variants (<hash>_<width>.webp under imagesDir/variants).
  try {
    for (const entry of fs.readdirSync(path.join(imagesDir, "variants"))) {
      const match = entry.match(IMAGE_VARIANT_RE);
      if (match && !referenced.has(match[1])) rmFile(path.join(imagesDir, "variants", entry));
    }
  } catch {
    // variants dir may simply not exist yet
  }

  // Trickplay sprites/metadata of media_files rows that no longer exist.
  try {
    const liveFileIds = new Set((db.prepare("SELECT id FROM media_files").all() as { id: number }[]).map((r) => r.id));
    const trickplayDir = path.join(cacheDir, "trickplay");
    for (const entry of fs.readdirSync(trickplayDir)) {
      const match = entry.match(TRICKPLAY_ENTRY_RE);
      if (match && !liveFileIds.has(Number(match[1]))) rmFile(path.join(trickplayDir, entry));
    }
  } catch {
    // trickplay dir may simply not exist (flag off)
  }

  if (removedRows || removedFiles || failures) {
    log.info("cache gc complete", { removedRows, removedFiles, failures });
  }
}
