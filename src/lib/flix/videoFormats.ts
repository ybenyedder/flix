// The single source of truth for which container extensions Flix treats as
// playable video. Kept here — a pure module with NO node imports — so it can be
// shared by server code (the scanner, the path guard, the upload manager) AND
// client components (the drag-and-drop upload UI) without dragging `fs`/`path`
// into a browser bundle. Extensions are lowercased and include the leading dot.
export const VIDEO_EXTENSIONS: readonly string[] = [
  ".mkv",
  ".mp4",
  ".m4v",
  ".webm",
  ".avi",
  ".mov",
  ".ts",
  ".m2ts",
  ".wmv",
  ".flv",
  ".ogv",
];
