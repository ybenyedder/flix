// Shared Node-to-web file streaming for the byte-serving playback routes
// (/api/stream/<fileId> direct play and /api/play/session/<id>/<asset> HLS
// segments), so the two never drift apart on the stream-teardown handling.

import fs from "fs";
import { Readable } from "stream";

// Seeking a <video> constantly aborts an in-flight range request and issues a
// new one — completely normal, and exactly what a scrubbed/skipped playhead
// does. When that abort races with `Readable.toWeb()`'s own teardown of the
// underlying fs stream, Node can end up calling a web-stream controller
// method a second time (a known Readable.toWeb interop edge case), which
// throws an uncaught `ERR_INVALID_STATE` from deep inside stream plumbing —
// after the route has already returned its response, so there's no request
// left to catch it at. Node treats a stream's 'error' event with no listener
// as fatal by default, which is what turns "client hung up mid-range-request"
// (routine) into an uncaught exception (noisy, though Next's runtime
// swallows it without crashing). A no-op listener defuses that.
export function toWebStream(nodeStream: fs.ReadStream): ReadableStream {
  nodeStream.on("error", () => {
    /* client aborted mid-stream (seek/close) — not an error worth surfacing */
  });
  return Readable.toWeb(nodeStream) as unknown as ReadableStream;
}

/** Open `filePath` and return a web ReadableStream over it (optionally over a
 *  byte range), or null when the file can't be opened. `fs.createReadStream`
 *  opens lazily, so a file deleted between a route's stat() and the first read
 *  (a session directory purged by the idle sweeper, a library file replaced
 *  mid-request) would only surface as a stream error AFTER the response
 *  headers were already sent — opening the fd eagerly here turns that race
 *  into a clean 404 from the caller instead. */
export async function openWebFileStream(filePath: string, range?: { start: number; end: number }): Promise<ReadableStream | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, "r");
  } catch {
    return null;
  }
  // autoClose (default) closes the handle when the stream ends or errors.
  return toWebStream(handle.createReadStream(range ? { start: range.start, end: range.end } : {}));
}
