import { getSnapshot, getSnapshotEtag } from "@/server/library/repository";
import { getScanProgress } from "@/server/library/scanner";
import { ensureLibraryReady } from "@/server/bootstrap";
import { getRequestUser } from "@/server/auth";
import { checkAuth, ifNoneMatchHits, json } from "@/server/http";
import { filterForProfile } from "@/lib/flix/kids";
import { createLogger } from "@/server/logger";

const log = createLogger("api:library");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = checkAuth(request);
  if (denied) return denied;

  ensureLibraryReady();
  try {
    const user = getRequestUser(request);
    const isKids = user?.is_kids === 1;
    // The weak validator must carry the kids flag: the body below differs per
    // profile kind, so a kids 304 must never validate an adult body cached by
    // an intermediary (or a previously-adult browser cache after a profile
    // switch on the same machine).
    const etag = isKids ? getSnapshotEtag().replace(/"$/, `-k"`) : getSnapshotEtag();
    const scan = getScanProgress();
    // While a scan is in flight the snapshot mutates faster than the coarse
    // ETag signals, and the client polls this endpoint for live progress — so
    // only honour conditional requests when no scan is running.
    if (scan.status !== "scanning" && ifNoneMatchHits(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-cache" } });
    }

    const snapshot = getSnapshot();
    // KIDS GATE — enforced server-side, not just in the client. The memoised
    // snapshot is shared by every profile, so a kids profile gets a filtered
    // COPY (never a mutation of the cached object — same reason search/route.ts
    // filters into fresh arrays). Counts follow the filtered lists so the
    // response doesn't reveal how many adult titles were hidden; the client's
    // filterForProfile then becomes defense in depth instead of the only gate.
    let body = snapshot;
    if (isKids) {
      const movies = filterForProfile(snapshot.movies, true);
      const shows = filterForProfile(snapshot.shows, true);
      body = {
        ...snapshot,
        movies,
        shows,
        countMovies: movies.length,
        countShows: shows.length,
        countEpisodes: shows.reduce((n, s) => n + s.episodeCount, 0),
      };
    }
    // The absolute media path is operator-level information — the admin-gated
    // routes (/api/library/source, /api/admin/settings) deliberately withhold
    // it from regular profiles, so this endpoint must not hand it out either.
    const isAdmin = user?.is_admin === 1;
    const res = json({ ...body, ...(isAdmin ? {} : { mediaDir: "" }), scan });
    res.headers.set("ETag", etag);
    res.headers.set("Cache-Control", "private, no-cache");
    return res;
  } catch (error) {
    // Log the real error (may contain filesystem paths) server-side only.
    log.error("library read failed", { error: error instanceof Error ? error.message : String(error) });
    return json({ movies: [], shows: [], mediaDir: "", scannedAt: null, countMovies: 0, countShows: 0, countEpisodes: 0, error: "Library read failed" }, { status: 500 });
  }
}
