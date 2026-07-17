import { getSnapshot, getSnapshotEtag } from "@/server/library/repository";
import { getScanProgress } from "@/server/library/scanner";
import { ensureLibraryReady } from "@/server/bootstrap";
import { getRequestUser } from "@/server/auth";
import { checkAuth, ifNoneMatchHits, json } from "@/server/http";
import { createLogger } from "@/server/logger";

const log = createLogger("api:library");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = checkAuth(request);
  if (denied) return denied;

  ensureLibraryReady();
  try {
    const etag = getSnapshotEtag();
    const scan = getScanProgress();
    // While a scan is in flight the snapshot mutates faster than the coarse
    // ETag signals, and the client polls this endpoint for live progress — so
    // only honour conditional requests when no scan is running.
    if (scan.status !== "scanning" && ifNoneMatchHits(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-cache" } });
    }

    const snapshot = getSnapshot();
    // The absolute media path is operator-level information — the admin-gated
    // routes (/api/library/source, /api/admin/settings) deliberately withhold
    // it from regular profiles, so this endpoint must not hand it out either.
    const isAdmin = getRequestUser(request)?.is_admin === 1;
    const res = json({ ...snapshot, ...(isAdmin ? {} : { mediaDir: "" }), scan });
    res.headers.set("ETag", etag);
    res.headers.set("Cache-Control", "private, no-cache");
    return res;
  } catch (error) {
    // Log the real error (may contain filesystem paths) server-side only.
    log.error("library read failed", { error: error instanceof Error ? error.message : String(error) });
    return json({ movies: [], shows: [], mediaDir: "", scannedAt: null, countMovies: 0, countShows: 0, countEpisodes: 0, error: "Library read failed" }, { status: 500 });
  }
}
