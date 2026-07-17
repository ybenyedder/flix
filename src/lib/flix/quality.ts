// Pure helper turning a raw video height into the coarse badge Netflix-style
// cards show (HD/4K), plus HDR. Kept separate from the DTOs so it's trivially
// unit-testable without any DB/fetch involved.

export type QualityLabel = "4K" | "HD" | "SD";

export function qualityLabel(height: number | null | undefined): QualityLabel | null {
  if (!height || height <= 0) return null;
  if (height >= 1800) return "4K";
  if (height >= 720) return "HD";
  return "SD";
}

/** "4,3 Go" / "700 Mo" — French notation, GiB/MiB based, one decimal under
 *  10 Go. Unknown/zero sizes yield "" so callers can just skip the suffix. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const GIB = 1024 ** 3;
  if (bytes >= GIB) {
    const tenth = Math.round((bytes / GIB) * 10) / 10;
    const text = tenth >= 10 || Number.isInteger(tenth) ? String(Math.round(tenth)) : tenth.toFixed(1).replace(".", ",");
    return `${text} Go`;
  }
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} Mo`;
}

/** What a version-picker option needs of a media file — a structural subset
 *  of MediaFileInfo, kept inline so this module stays DTO-import-free. */
export interface VersionFileLike {
  version: string | null;
  size: number;
  streams: { type: string; height: number | null; attachedPic?: boolean }[];
}

/** Option label for the DetailModal version picker: the explicit edition name
 *  when the file has one (« Director's Cut », « 2160p »…), else the coarse
 *  quality badge plus the file size ("4K · 42 Go") so two unnamed versions
 *  stay distinguishable. Attached pictures (cover art muxed as a video
 *  stream) are never the quality source. */
export function versionLabel(file: VersionFileLike, index: number): string {
  if (file.version) return file.version;
  const video = file.streams.find((s) => s.type === "video" && !s.attachedPic);
  const quality = qualityLabel(video?.height) ?? `Version ${index + 1}`;
  const size = formatFileSize(file.size);
  return size ? `${quality} · ${size}` : quality;
}
