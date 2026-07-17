// Content-addressed poster/backdrop/thumb/logo cache. Every image — whatever
// its origin (a Kodi sidecar file, an embedded cover, a generated frame) — is
// written to disk keyed by the SHA-1 of its bytes (automatic de-duplication:
// the same fanart.jpg shared by every episode of a show is stored once), then
// served by /api/images/[hash]. Files are stored without an extension; MIME is
// sniffed from magic bytes at serve time, so one hash always maps to one file.
// Adapted from /home/pc/Documents/auralis_enterprise_grade/src/server/library/art.ts,
// generalised from a single square album-art shape to the four aspect ratios
// (poster 2:3, backdrop/thumb 16:9, logo arbitrary transparent PNG) Flix needs.

import crypto from "crypto";
import fs from "fs";
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import path from "path";
import type SharpNS from "sharp";
import { getConfig } from "../config";
import { getDb } from "../db";

export type ImageKind = "poster" | "backdrop" | "thumb" | "logo";
export type ImageSource = "sidecar" | "embedded" | "generated";

function sha1(data: Buffer): string {
  return crypto.createHash("sha1").update(data).digest("hex");
}

function imagePathFor(hash: string): string {
  return path.join(getConfig().imagesDir, hash);
}

// Lazy, memoised sharp handle — dynamically imported (rather than a static
// top-level import) so a native-module load failure (e.g. an Electron rebuild
// pending after an ABI bump) degrades to "serve originals, skip resizing/accent"
// instead of taking the whole images subsystem down with it.
type SharpFactory = typeof SharpNS;
let sharpFactory: SharpFactory | null | undefined;
export async function getSharp(): Promise<SharpFactory | null> {
  if (sharpFactory !== undefined) return sharpFactory;
  try {
    const mod = await import("sharp");
    sharpFactory = mod.default;
  } catch {
    sharpFactory = null;
  }
  return sharpFactory;
}

async function probeDimensions(buf: Buffer): Promise<{ width: number | null; height: number | null }> {
  const sharp = await getSharp();
  if (!sharp) return { width: null, height: null };
  try {
    const meta = await sharp(buf, { failOn: "none" }).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

/** Persist an image buffer to the cache and register it in `images`. Returns
 *  its content hash, or null if it couldn't be written (empty buffer, disk
 *  error). Safe to call repeatedly with identical bytes — the file write and
 *  the metadata row are both idempotent (INSERT OR IGNORE). */
export async function cacheImageBuffer(data: Buffer, kind: ImageKind, source: ImageSource): Promise<string | null> {
  if (!data || data.length === 0) return null;
  const hash = sha1(data);
  const file = imagePathFor(hash);
  const alreadyCached = fs.existsSync(file);
  if (!alreadyCached) {
    // Write-then-rename: a crash mid-write must never leave a truncated file
    // under the content hash — existsSync would report it cached and the
    // corrupt bytes would be served forever.
    //
    // Temp name is unique per write (pid + random suffix), NOT the bare pid:
    // two concurrent images-pass workers hashing the SAME bytes would otherwise
    // share one temp path, and one's rename would race the other's half-written
    // temp — the loser's write/rename throws and it returns null, silently
    // dropping a co-located entity's image. Both still rename onto the identical
    // immutable final name, so the extra uniqueness is harmless.
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, file);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      return null;
    }
    try {
      const dims = await probeDimensions(data);
      getDb()
        .prepare("INSERT OR IGNORE INTO images (hash, kind, source, width, height) VALUES (?, ?, ?, ?, ?)")
        .run(hash, kind, source, dims.width, dims.height);
    } catch {
      // metadata row is best-effort — the file on disk is what actually serves images
    }
  }
  return hash;
}

const MAX_SIDECAR_BYTES = 25 * 1024 * 1024;

/** Read a local sidecar image file and cache it. Rejects anything absurdly
 *  large — a legitimate poster/fanart has no reason to exceed a few MB. */
export async function cacheImageFile(absPath: string, kind: ImageKind, source: ImageSource): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SIDECAR_BYTES) return null;
    const data = await readFile(absPath);
    return cacheImageBuffer(data, kind, source);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Derive a 2:3 poster from a landscape backdrop frame.
// A generated backdrop already costs one ffmpeg extraction; cropping it to a
// portrait poster in-process (sharp) avoids a second one for every artwork-less
// title. Pure crop-rect maths split out so it's directly unit-tested.
// ---------------------------------------------------------------------------

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The largest 2:3 (portrait) rectangle centred inside a `w`×`h` source. Never
 *  upsizes — the crop always stays within the source, so a 1280×720 backdrop
 *  yields a 480×720 poster rather than a stretched 720×1080 one. */
export function posterCropRect(w: number, h: number): CropRect {
  // 2:3 ⇒ width/height = 2/3. `w*3 >= h*2` means the source is wider than 2:3
  // (the usual landscape case) so its HEIGHT is the binding dimension.
  if (w * 3 >= h * 2) {
    const cropW = Math.min(w, Math.round((h * 2) / 3));
    return { left: Math.max(0, Math.round((w - cropW) / 2)), top: 0, width: cropW, height: h };
  }
  const cropH = Math.min(h, Math.round((w * 3) / 2));
  return { left: 0, top: Math.max(0, Math.round((h - cropH) / 2)), width: w, height: cropH };
}

/** Crop an in-memory (landscape) image buffer to a centred 2:3 poster. Returns
 *  null when sharp is unavailable or the buffer isn't a decodable image — the
 *  caller then falls back to a dedicated ffmpeg poster extraction. */
export async function cropToPosterAspect(buf: Buffer): Promise<Buffer | null> {
  const sharp = await getSharp();
  if (!sharp) return null;
  try {
    const meta = await sharp(buf, { failOn: "none" }).metadata();
    if (!meta.width || !meta.height) return null;
    const rect = posterCropRect(meta.width, meta.height);
    return await sharp(buf, { failOn: "none" }).extract(rect).jpeg({ quality: 85 }).toBuffer();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Kodi-style sidecar image discovery.
// ---------------------------------------------------------------------------
const POSTER_NAMES = ["poster.jpg", "poster.jpeg", "poster.png", "folder.jpg", "folder.jpeg", "folder.png", "cover.jpg", "cover.jpeg", "cover.png"];
const BACKDROP_NAMES = ["fanart.jpg", "fanart.jpeg", "fanart.png", "backdrop.jpg", "background.jpg"];
const LOGO_NAMES = ["clearlogo.png", "logo.png"];

function firstExistingFile(dir: string, names: string[]): string | null {
  for (const name of names) {
    // Media-library paths are resolved at scan time from the configured
    // mediaDir, never a build-time dependency — must not be statically
    // traced by Next's file tracer.
    const candidate = path.join(/*turbopackIgnore: true*/ dir, name);
    try {
      const stat = fs.statSync(/*turbopackIgnore: true*/ candidate);
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_SIDECAR_BYTES) return candidate;
    } catch {
      // not present — keep looking
    }
  }
  return null;
}

export interface SidecarImages {
  poster: string | null;
  backdrop: string | null;
  logo: string | null;
  thumb: string | null;
}

/**
 * Kodi-style sidecar lookup for a single directory, in priority order:
 * "<basename>-poster.jpg" > poster.jpg > folder.jpg > cover.jpg for the
 * poster, fanart.jpg for the backdrop, logo/clearlogo.png for the logo, and
 * (when a basename is given) "<basename>-thumb.jpg" for an episode thumb.
 * Pass `basename` = the media file's own name without extension for a
 * per-file lookup (movie folder, episode folder); pass null for a folder-level
 * lookup where no single file owns the name (show/season root).
 */
export function findSidecarImages(dir: string, basename: string | null): SidecarImages {
  const posterNames = basename ? [`${basename}-poster.jpg`, `${basename}-poster.png`, ...POSTER_NAMES] : POSTER_NAMES;
  const thumbNames = basename ? [`${basename}-thumb.jpg`, `${basename}-thumb.png`] : [];
  return {
    poster: firstExistingFile(dir, posterNames),
    backdrop: firstExistingFile(dir, BACKDROP_NAMES),
    logo: firstExistingFile(dir, LOGO_NAMES),
    thumb: thumbNames.length ? firstExistingFile(dir, thumbNames) : null,
  };
}

/** Kodi season poster convention: "season01-poster.jpg" (zero-padded) sitting
 *  at the SHOW's root folder; "season-specials-poster.jpg" for season 0. */
export function findSeasonPoster(showDir: string, seasonNumber: number): string | null {
  const names = seasonNumber === 0 ? ["season-specials-poster.jpg", "season00-poster.jpg"] : [`season${String(seasonNumber).padStart(2, "0")}-poster.jpg`];
  return firstExistingFile(showDir, names);
}

// ---------------------------------------------------------------------------
// Serving: MIME sniff, width-bucket webp variants, in-memory LRU.
// ---------------------------------------------------------------------------

/** Detect a raster image MIME type from the leading bytes of a buffer. */
export function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF89a" || buf.toString("ascii", 0, 6) === "GIF87a")) return "image/gif";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return "application/octet-stream";
}

export interface CachedImage {
  buffer: Buffer;
  contentType: string;
}

const HASH_RE = /^[a-f0-9]{40}$/;

/** Read a cached image file and detect its content type from magic bytes. */
export async function readCachedImage(hash: string): Promise<CachedImage | null> {
  if (!HASH_RE.test(hash)) return null;
  ensureAccentFor(hash); // backfill the accent palette lazily (no-op once cached)
  let buffer: Buffer;
  try {
    buffer = await readFile(imagePathFor(hash));
  } catch {
    return null;
  }
  return { buffer, contentType: sniffImageMime(buffer) };
}

// Posters (2:3), backdrops/thumbs (16:9) and logos (arbitrary) each keep their
// own aspect ratio — unlike Auralis's square album art, variants here resize
// by WIDTH only (no crop), so a single bucket set suits every image kind.
export const IMAGE_VARIANT_SIZES = [240, 480, 960, 1440] as const;
const VARIANT_SET = new Set<number>(IMAGE_VARIANT_SIZES);

const MEM_MAX = 256;
const memCache = new Map<string, CachedImage>();
function memGet(key: string): CachedImage | undefined {
  const v = memCache.get(key);
  if (v) {
    memCache.delete(key);
    memCache.set(key, v);
  }
  return v;
}
function memSet(key: string, img: CachedImage): void {
  memCache.set(key, img);
  if (memCache.size > MEM_MAX) {
    const oldest = memCache.keys().next().value;
    if (oldest !== undefined) memCache.delete(oldest);
  }
}

/**
 * Read (or lazily generate + cache) a width-bucketed webp variant. Unknown
 * widths fall back to the full-resolution original, as does any sharp
 * failure, so a request always gets a usable image back.
 */
export async function readImageVariant(hash: string, width: number): Promise<CachedImage | null> {
  if (!HASH_RE.test(hash)) return null;
  ensureAccentFor(hash);
  if (!VARIANT_SET.has(width)) return readCachedImage(hash);

  const key = `${hash}_${width}`;
  const hit = memGet(key);
  if (hit) return hit;

  const variantDir = path.join(getConfig().imagesDir, "variants");
  const variantFile = path.join(variantDir, `${key}.webp`);
  try {
    const buffer = await readFile(variantFile);
    const img: CachedImage = { buffer, contentType: "image/webp" };
    memSet(key, img);
    return img;
  } catch {
    // not generated yet
  }

  const original = await readCachedImage(hash);
  if (!original) return null;

  const sharp = await getSharp();
  if (!sharp) return original; // graceful: serve the original untouched

  try {
    const out = await sharp(original.buffer, { failOn: "none" })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
    const img: CachedImage = { buffer: out, contentType: "image/webp" };
    memSet(key, img);
    // Write-then-rename into the content-addressed variant name (mirrors
    // cacheImageBuffer / cacheVtt / the HLS temp_file pattern): a crash
    // mid-write must never leave a truncated .webp that the readFile above would
    // then serve forever. rename is atomic, so a reader sees either no file or
    // the whole one, never a partial. Best-effort cleanup of the temp on failure.
    const variantTmp = `${variantFile}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    mkdir(variantDir, { recursive: true })
      .then(() => writeFile(variantTmp, out))
      .then(() => rename(variantTmp, variantFile))
      .catch(() => {
        try {
          fs.rmSync(variantTmp, { force: true });
        } catch {
          /* cache write best-effort */
        }
      });
    return img;
  } catch {
    return original;
  }
}

// ---------------------------------------------------------------------------
// Dominant-colour accent, stored directly on the `images` row (unlike Auralis's
// separate art_colors table — one image is only ever one hash here). Lazily
// extracted the first time an image is served, so an existing cache backfills
// as the user browses.
// ---------------------------------------------------------------------------

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}
function toHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((x) => clampByte(x).toString(16).padStart(2, "0")).join("");
}
/** [base, shadow, highlight] from a dominant RGB — the shape hero gradients use. */
export function paletteFromRgb(r: number, g: number, b: number): string {
  const base = toHex(r, g, b);
  const shadow = toHex(r * 0.42, g * 0.42, b * 0.42);
  const highlight = toHex(r + (255 - r) * 0.4, g + (255 - g) * 0.4, b + (255 - b) * 0.4);
  return `${base},${shadow},${highlight}`;
}

async function extractAccent(buffer: Buffer): Promise<string | null> {
  const sharp = await getSharp();
  if (!sharp) return null;
  try {
    const { dominant } = await sharp(buffer, { failOn: "none" }).stats();
    if (!dominant) return null;
    return paletteFromRgb(dominant.r, dominant.g, dominant.b);
  } catch {
    return null;
  }
}

/** Ensure the `images` row for `hash` has an accent palette. Fire-and-forget;
 *  self-throttles on the existing-accent check and reads the original file
 *  directly (no recursion into readCachedImage). A missing accent never blocks
 *  serving the image itself. */
export function ensureAccentFor(hash: string): void {
  if (!HASH_RE.test(hash)) return;
  void (async () => {
    try {
      const db = getDb();
      const row = db.prepare("SELECT accent FROM images WHERE hash = ?").get(hash) as { accent: string | null } | undefined;
      if (!row || row.accent) return;
      const buffer = await readFile(imagePathFor(hash)).catch(() => null);
      if (!buffer) return;
      const accent = await extractAccent(buffer);
      if (accent) db.prepare("UPDATE images SET accent = ? WHERE hash = ?").run(accent, hash);
    } catch {
      /* best effort */
    }
  })();
}
