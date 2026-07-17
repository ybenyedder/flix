// Request lifecycle (src/server/arr/requests.ts) with a stubbed *arr client:
// the add payload shape, dedupe, the "already added" attach path, the delete
// permission matrix, and reconcile transitions (downloading → importing →
// available once a matching library row appears). Plus the route guards
// (kids → 403, CSRF on POST). Isolated temp data dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flix-arr-requests-test-"));
process.env.FLIX_DATA_DIR = tmp;
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

type ArrClientApi = import("../src/server/arr/requests").ArrClientApi;

function makeClient(overrides: Partial<ArrClientApi> = {}): ArrClientApi {
  return {
    radarrLookupByTmdbId: async (id) => ({ id: 0, tmdbId: id, title: "Movie", year: 2020 }),
    sonarrLookup: async () => [{ id: 0, tvdbId: 111, title: "Serie", year: 2019 }],
    radarrQualityProfiles: async () => [{ id: 1, name: "HD" }],
    radarrRootFolders: async () => [{ path: "/data/movies" }],
    sonarrQualityProfiles: async () => [{ id: 1, name: "HD" }],
    sonarrRootFolders: async () => [{ path: "/data/shows" }],
    radarrAddMovie: async () => ({ id: 42 }),
    sonarrAddSeries: async () => ({ id: 55 }),
    radarrGetMovie: async () => null,
    sonarrGetSeries: async () => null,
    radarrGetMovieByTmdbId: async () => null,
    sonarrGetSeriesByTvdbId: async () => null,
    radarrQueue: async () => [],
    sonarrQueue: async () => [],
    radarrRemoveQueueItem: async () => {},
    sonarrRemoveQueueItem: async () => {},
    radarrSearchMovie: async () => {},
    sonarrSearchSeries: async () => {},
    radarrReleaseSearch: async () => [],
    radarrGrabRelease: async () => {},
    radarrDeleteMovie: async () => {},
    applyBalancedProfile: async () => true,
    ...overrides,
  };
}

async function setup() {
  const { getDb } = await import("../src/server/db");
  const { ensureAuth } = await import("../src/server/auth");
  const arrConfig = await import("../src/server/arr/config");
  const requests = await import("../src/server/arr/requests");
  ensureAuth();
  const db = getDb();
  db.prepare("DELETE FROM arr_requests").run();
  db.prepare("DELETE FROM media_files").run();
  db.prepare("DELETE FROM movies").run();
  db.prepare("DELETE FROM shows").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'arr.%'").run();
  arrConfig.setArrEnabled(true);
  requests.__resetPoller();
  return { db, requests, arrConfig };
}

test("createRequest (movie): builds the add payload and inserts a searching row", async () => {
  const { db, requests } = await setup();
  let captured: Record<string, unknown> | null = null;
  let addCount = 0;
  requests.__setArrClient(
    makeClient({
      radarrLookupByTmdbId: async (id) => ({ id: 0, tmdbId: id, title: "Test Movie", year: 2020, images: [{ coverType: "poster", remoteUrl: "https://image.tmdb.org/x.jpg" }] }),
      radarrAddMovie: async (p) => {
        captured = p;
        addCount++;
        return { id: 42 };
      },
    }),
  );

  const res = await requests.createRequest(1, { mediaType: "movie", tmdbId: 603 });
  assert.equal(res.ok, true);
  assert.equal(res.request?.status, "searching");
  assert.equal(res.request?.title, "Test Movie");
  assert.match(res.request?.posterUrl ?? "", /^\/api\/arr\/poster\?u=/);

  assert.ok(captured);
  assert.equal((captured as Record<string, unknown>).qualityProfileId, 1);
  assert.equal((captured as Record<string, unknown>).rootFolderPath, "/data/movies");
  assert.equal((captured as Record<string, unknown>).monitored, true);
  assert.deepEqual((captured as Record<string, unknown>).addOptions, { searchForMovie: true });

  const row = db.prepare("SELECT arr_id, status FROM arr_requests WHERE tmdb_id = 603").get() as { arr_id: number; status: string };
  assert.equal(row.arr_id, 42);
  assert.equal(row.status, "searching");
  assert.equal(addCount, 1);

  requests.__resetPoller();
});

test("createRequest (movie, fr): adds without a blind search and grabs the French release", async () => {
  const { requests } = await setup();
  let payload: Record<string, unknown> | null = null;
  let grabbedGuid: string | null = null;
  let plainSearched = false;
  let resolveGrab: () => void = () => {};
  const grabbed = new Promise<void>((r) => (resolveGrab = r));
  requests.__setArrClient(
    makeClient({
      radarrLookupByTmdbId: async (id) => ({ id: 0, tmdbId: id, title: "Cap", year: 2011 }),
      radarrAddMovie: async (p) => {
        payload = p;
        return { id: 77 };
      },
      radarrGetMovie: async () => ({ id: 77, hasFile: false }),
      radarrQueue: async () => [],
      radarrReleaseSearch: async () => [
        { guid: "g-vo", indexerId: 3, title: "Cap.2011.2160p.BluRay.x265-VO", seeders: 5, quality: { quality: { name: "Bluray-2160p", resolution: 2160 } } },
        { guid: "g-fr", indexerId: 3, title: "Cap.2011.Multi.2160p.BluRay.x265-DDR", seeders: 5, quality: { quality: { name: "Bluray-2160p", resolution: 2160 } } },
      ],
      radarrGrabRelease: async (guid) => {
        grabbedGuid = guid;
        resolveGrab();
      },
      radarrSearchMovie: async () => {
        plainSearched = true;
      },
    }),
  );

  const res = await requests.createRequest(1, { mediaType: "movie", tmdbId: 1771, language: "fr" });
  assert.equal(res.ok, true);
  assert.ok(payload);
  assert.deepEqual((payload as Record<string, unknown>).addOptions, { searchForMovie: false });

  await Promise.race([grabbed, new Promise((_, reject) => setTimeout(() => reject(new Error("grab never fired")), 2000))]);
  assert.equal(grabbedGuid, "g-fr"); // the MULTi release, not the VO one
  assert.equal(plainSearched, false); // a strong FR match means no fallback search
  requests.__resetPoller();
});

test("createRequest (movie, fr): no French release → request fails with a clear message, nothing grabbed", async () => {
  const { db, requests } = await setup();
  let grabbed = false;
  let searched = false;
  let deleteCalled = false;
  requests.__setArrClient(
    makeClient({
      radarrLookupByTmdbId: async (id) => ({ id: 0, tmdbId: id, title: "Cap", year: 2011 }),
      radarrAddMovie: async () => ({ id: 88 }),
      radarrGetMovie: async () => ({ id: 88, hasFile: false }),
      radarrQueue: async () => [],
      // Only VO releases exist — no MULTi/FRENCH title.
      radarrReleaseSearch: async () => [
        { guid: "vo1", indexerId: 3, title: "Cap.2011.1080p.BluRay.x264-SPARKS", seeders: 10, quality: { quality: { name: "Bluray-1080p", resolution: 1080 } } },
      ],
      radarrGrabRelease: async () => {
        grabbed = true;
      },
      radarrDeleteMovie: async () => {
        deleteCalled = true;
      },
      radarrSearchMovie: async () => {
        searched = true;
      },
    }),
  );

  const res = await requests.createRequest(1, { mediaType: "movie", tmdbId: 1771, language: "fr" });
  assert.equal(res.ok, true);
  assert.ok(res.request);
  const reqId = res.request.id;

  // The grab runs in the background; wait for it to reach the terminal state.
  let row: { status: string; error: string | null } | undefined;
  for (let i = 0; i < 50; i++) {
    row = db.prepare("SELECT status, error FROM arr_requests WHERE id = ?").get(reqId) as { status: string; error: string | null } | undefined;
    if (row?.status === "failed") break;
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(row?.status, "failed");
  assert.match(row?.error ?? "", /aucune version fran/i);
  assert.equal(grabbed, false); // no VO grabbed
  assert.equal(searched, false); // no normal-search fallback for FR
  assert.equal(deleteCalled, true); // the orphan movie was removed from Radarr
  requests.__resetPoller();
});

test("createRequest (movie, quality 1080p): adds without blind search and grabs the 1080p release", async () => {
  const { requests } = await setup();
  let payload: Record<string, unknown> | null = null;
  let grabbedGuid: string | null = null;
  let resolveGrab: () => void = () => {};
  const grabbed = new Promise<void>((r) => (resolveGrab = r));
  requests.__setArrClient(
    makeClient({
      radarrLookupByTmdbId: async (id) => ({ id: 0, tmdbId: id, title: "Cap", year: 2011 }),
      radarrAddMovie: async (p) => {
        payload = p;
        return { id: 99 };
      },
      radarrGetMovie: async () => ({ id: 99, hasFile: false }),
      radarrQueue: async () => [],
      radarrReleaseSearch: async () => [
        { guid: "g-4k", indexerId: 3, title: "Cap.2011.2160p.BluRay.x265", seeders: 80, quality: { quality: { name: "Bluray-2160p", resolution: 2160 } } },
        { guid: "g-1080", indexerId: 3, title: "Cap.2011.1080p.BluRay.x264", seeders: 8, quality: { quality: { name: "Bluray-1080p", resolution: 1080 } } },
      ],
      radarrGrabRelease: async (guid) => {
        grabbedGuid = guid;
        resolveGrab();
      },
    }),
  );

  const res = await requests.createRequest(1, { mediaType: "movie", tmdbId: 1771, quality: "1080p" });
  assert.equal(res.ok, true);
  assert.ok(payload);
  assert.deepEqual((payload as Record<string, unknown>).addOptions, { searchForMovie: false });

  await Promise.race([grabbed, new Promise((_, reject) => setTimeout(() => reject(new Error("grab never fired")), 2000))]);
  assert.equal(grabbedGuid, "g-1080"); // the 1080p one, not the higher-seeded 4K
  requests.__resetPoller();
});

test("getReleaseOptions: adds the movie, searches, returns real availability", async () => {
  const { requests } = await setup();
  let added = false;
  requests.__setArrClient(
    makeClient({
      radarrLookupByTmdbId: async (id) => ({ id: 0, tmdbId: id, title: "Cap", year: 2011 }),
      radarrAddMovie: async () => {
        added = true;
        return { id: 77 };
      },
      radarrReleaseSearch: async () => [
        { guid: "g-multi", indexerId: 3, title: "Cap.2011.Multi.2160p.BluRay.x265-DDR", seeders: 30, size: 20_000_000_000, quality: { quality: { name: "Bluray-2160p", resolution: 2160 } } },
        { guid: "g-vo", indexerId: 3, title: "Cap.2011.1080p.BluRay.x264", seeders: 50, size: 8_000_000_000, quality: { quality: { name: "Bluray-1080p", resolution: 1080 } } },
      ],
    }),
  );
  const res = await requests.getReleaseOptions(1771);
  assert.equal(res.ok, true);
  assert.equal(added, true);
  assert.ok(res.options);
  assert.equal(res.options.wasAdded, true);
  assert.equal(res.options.arrId, 77);
  assert.deepEqual(
    res.options.languages.map((l) => l.language).sort(),
    ["fr", "vo"], // Multi provides FR, Multi+1080p provide VO
  );
  requests.__resetPoller();
});

test("getReleaseOptions: retries a transient 'injoignable' then succeeds", async () => {
  const { requests } = await setup();
  const { ArrError } = await import("../src/server/arr/client");
  let lookupCalls = 0;
  requests.__setArrClient(
    makeClient({
      radarrLookupByTmdbId: async (id) => {
        lookupCalls++;
        if (lookupCalls === 1) throw new ArrError("radarr", "radarr injoignable"); // transient blip
        return { id: 0, tmdbId: id, title: "Cap", year: 2011 };
      },
      radarrAddMovie: async () => ({ id: 77 }),
      radarrReleaseSearch: async () => [{ guid: "g", indexerId: 3, title: "Cap.2011.1080p.x264", seeders: 5, quality: { quality: { name: "Bluray-1080p", resolution: 1080 } } }],
    }),
  );
  const res = await requests.getReleaseOptions(1771);
  assert.equal(res.ok, true); // recovered on retry instead of surfacing « injoignable »
  assert.ok(lookupCalls >= 2);
  requests.__resetPoller();
});

test("grabChosenRelease: grabs the picked release and inserts a searching row", async () => {
  const { db, requests } = await setup();
  let grabbed: string | null = null;
  requests.__setArrClient(
    makeClient({
      radarrLookupByTmdbId: async (id) => ({ id: 5, tmdbId: id, title: "Cap", year: 2011 }),
      radarrGrabRelease: async (guid) => {
        grabbed = guid;
      },
    }),
  );
  const res = await requests.grabChosenRelease(1, { tmdbId: 1771, arrId: 5, guid: "g-multi", indexerId: 3 });
  assert.equal(res.ok, true);
  assert.equal(grabbed, "g-multi");
  const row = db.prepare("SELECT status, arr_id FROM arr_requests WHERE tmdb_id = 1771").get() as { status: string; arr_id: number };
  assert.equal(row.status, "searching");
  assert.equal(row.arr_id, 5);
  requests.__resetPoller();
});

test("cancelReleaseBrowse: removes an added, idle, request-less movie only", async () => {
  const { requests } = await setup();
  let deleted: number | null = null;
  requests.__setArrClient(
    makeClient({
      radarrGetMovie: async (id) => ({ id, hasFile: false }),
      radarrQueue: async () => [],
      radarrDeleteMovie: async (id) => {
        deleted = id;
      },
    }),
  );
  await requests.cancelReleaseBrowse({ arrId: 88, wasAdded: true });
  assert.equal(deleted, 88);

  deleted = null;
  await requests.cancelReleaseBrowse({ arrId: 88, wasAdded: false }); // pre-existing movie → keep
  assert.equal(deleted, null);
  requests.__resetPoller();
});

test("createRequest (movie): dedupes an active request instead of re-adding", async () => {
  const { requests } = await setup();
  let addCount = 0;
  requests.__setArrClient(
    makeClient({
      radarrLookupByTmdbId: async (id) => ({ id: 0, tmdbId: id, title: "Dup Movie", year: 2020 }),
      radarrAddMovie: async () => {
        addCount++;
        return { id: 7 };
      },
    }),
  );
  const first = await requests.createRequest(1, { mediaType: "movie", tmdbId: 900 });
  const second = await requests.createRequest(2, { mediaType: "movie", tmdbId: 900 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.request?.id, first.request?.id); // same row
  assert.equal(addCount, 1); // Radarr add only once
  requests.__resetPoller();
});

test("createRequest (movie): attaches to the existing entity on a 400 'already added'", async () => {
  const { db, requests } = await setup();
  const { ArrError } = await import("../src/server/arr/client");
  requests.__setArrClient(
    makeClient({
      radarrLookupByTmdbId: async (id) => ({ id: 99, tmdbId: id, title: "Existing Movie", year: 2018 }), // already in Radarr (id set)
      radarrAddMovie: async () => {
        throw new ArrError("radarr", "This movie has already been added", 400);
      },
    }),
  );
  const res = await requests.createRequest(1, { mediaType: "movie", tmdbId: 500 });
  assert.equal(res.ok, true);
  const row = db.prepare("SELECT arr_id FROM arr_requests WHERE tmdb_id = 500").get() as { arr_id: number };
  assert.equal(row.arr_id, 99); // took the id from the lookup
  requests.__resetPoller();
});

// Radarr's `movie/lookup/tmdb` returns `id: null` even for movies it already
// has, so the attach must resolve the entity with an explicit by-tmdbId query
// (regression: « Demander » on an already-added movie surfaced Radarr's raw
// "This movie has already been added" and created no request).
test("createRequest (movie): attaches via explicit tmdbId query when the lookup has no id", async () => {
  const { db, requests } = await setup();
  const { ArrError } = await import("../src/server/arr/client");
  let searched = false;
  requests.__setArrClient(
    makeClient({
      radarrLookupByTmdbId: async (id) => ({ id: null as unknown as number, tmdbId: id, title: "Agent Carter", year: 2013 }),
      radarrAddMovie: async () => {
        throw new ArrError("radarr", "This movie has already been added", 400);
      },
      radarrGetMovieByTmdbId: async () => ({ id: 6, tmdbId: 211387, title: "Agent Carter", year: 2013, hasFile: false }),
      // The entity is mid-download: no fresh search must be kicked.
      radarrQueue: async () => [{ movieId: 6, status: "downloading", size: 100, sizeleft: 80 }],
      radarrSearchMovie: async () => {
        searched = true;
      },
    }),
  );
  const res = await requests.createRequest(1, { mediaType: "movie", tmdbId: 211387 });
  assert.equal(res.ok, true);
  const row = db.prepare("SELECT arr_id, status FROM arr_requests WHERE tmdb_id = 211387").get() as { arr_id: number; status: string };
  assert.equal(row.arr_id, 6); // resolved through the explicit query
  assert.equal(searched, false, "an active download must not be re-searched");
  requests.__resetPoller();
});

test("createRequest (movie): attaching to an idle entity kicks a fresh search", async () => {
  const { requests } = await setup();
  const { ArrError } = await import("../src/server/arr/client");
  let searchedId: number | null = null;
  requests.__setArrClient(
    makeClient({
      radarrLookupByTmdbId: async (id) => ({ id: null as unknown as number, tmdbId: id, title: "Idle Movie", year: 2010 }),
      radarrAddMovie: async () => {
        throw new ArrError("radarr", "This movie has already been added", 400);
      },
      radarrGetMovieByTmdbId: async () => ({ id: 12, tmdbId: 600, title: "Idle Movie", year: 2010 }),
      radarrGetMovie: async () => ({ id: 12, hasFile: false }),
      radarrQueue: async () => [], // idle: nothing queued, no file
      radarrSearchMovie: async (id) => {
        searchedId = id;
      },
    }),
  );
  const res = await requests.createRequest(1, { mediaType: "movie", tmdbId: 600 });
  assert.equal(res.ok, true);
  assert.equal(searchedId, 12, "idle attach must trigger a search");
  requests.__resetPoller();
});

test("createRequest (movie): a 400 for a movie truly absent from Radarr stays an error", async () => {
  const { db, requests } = await setup();
  const { ArrError } = await import("../src/server/arr/client");
  requests.__setArrClient(
    makeClient({
      radarrLookupByTmdbId: async (id) => ({ id: null as unknown as number, tmdbId: id, title: "Broken Movie", year: 2000 }),
      radarrAddMovie: async () => {
        throw new ArrError("radarr", "Root folder path '/oops' is invalid", 400);
      },
      radarrGetMovieByTmdbId: async () => null, // not in Radarr → nothing to attach to
    }),
  );
  const res = await requests.createRequest(1, { mediaType: "movie", tmdbId: 601 });
  assert.equal(res.ok, false);
  assert.equal(res.error, "Root folder path '/oops' is invalid");
  const row = db.prepare("SELECT COUNT(*) AS n FROM arr_requests WHERE tmdb_id = 601").get() as { n: number };
  assert.equal(row.n, 0);
  requests.__resetPoller();
});

test("createRequest (show): attaches via explicit tvdbId query when the lookup has no id", async () => {
  const { db, requests } = await setup();
  const { ArrError } = await import("../src/server/arr/client");
  let searchedId: number | null = null;
  requests.__setArrClient(
    makeClient({
      sonarrLookup: async () => [{ id: null as unknown as number, tvdbId: 281485, title: "Agent Carter", year: 2015 }],
      sonarrAddSeries: async () => {
        throw new ArrError("sonarr", "This series has already been added", 400);
      },
      sonarrGetSeriesByTvdbId: async () => ({ id: 9, tvdbId: 281485, title: "Agent Carter", year: 2015 }),
      sonarrGetSeries: async () => ({ id: 9, statistics: { episodeFileCount: 0 } }),
      sonarrQueue: async () => [],
      sonarrSearchSeries: async (id) => {
        searchedId = id;
      },
    }),
  );
  const res = await requests.createRequest(1, { mediaType: "show", tvdbId: 281485 });
  assert.equal(res.ok, true);
  const row = db.prepare("SELECT arr_id FROM arr_requests WHERE tvdb_id = 281485").get() as { arr_id: number };
  assert.equal(row.arr_id, 9);
  assert.equal(searchedId, 9, "idle attach must trigger a series search");
  requests.__resetPoller();
});

test("deleteRequest: admin any, owner until available, others denied", async () => {
  const { db, requests } = await setup();
  const now = Date.now();
  const mk = (userId: number, status: string) =>
    Number(
      db
        .prepare("INSERT INTO arr_requests (user_id, media_type, tmdb_id, title, status, created_at, updated_at) VALUES (?, 'movie', ?, 'X', ?, ?, ?)")
        .run(userId, now + Math.random(), status, now, now).lastInsertRowid,
    );

  const ownerActive = mk(10, "downloading");
  const ownerAvailable = mk(10, "available");
  const otherActive = mk(10, "searching");

  // Non-owner, non-admin → denied.
  assert.equal(requests.deleteRequest(ownerActive, { id: 20, isAdmin: false }).ok, false);
  // Owner while active → allowed.
  assert.equal(requests.deleteRequest(ownerActive, { id: 10, isAdmin: false }).ok, true);
  // Owner but available → denied.
  assert.equal(requests.deleteRequest(ownerAvailable, { id: 10, isAdmin: false }).ok, false);
  // Admin → allowed even when available.
  assert.equal(requests.deleteRequest(ownerAvailable, { id: 99, isAdmin: true }).ok, true);
  // Admin on someone else's active → allowed.
  assert.equal(requests.deleteRequest(otherActive, { id: 99, isAdmin: true }).ok, true);
  // Missing row → 404.
  assert.equal(requests.deleteRequest(123456, { id: 99, isAdmin: true }).status, 404);
});

test("reconcile: downloading → importing → available once a matching library file appears", async () => {
  const { db, requests } = await setup();
  const now = Date.now();
  db.prepare("INSERT INTO arr_requests (user_id, media_type, tmdb_id, title, year, arr_id, status, created_at, updated_at) VALUES (1,'movie',700,'Recon Movie',2021,7,'searching',?,?)").run(now, now);

  // Phase 1: active download → downloading with progress.
  requests.__setArrClient(
    makeClient({
      radarrQueue: async () => [{ movieId: 7, status: "downloading", size: 100, sizeleft: 40 }],
      radarrGetMovie: async () => ({ id: 7, hasFile: false }),
    }),
  );
  await requests.reconcile();
  let row = db.prepare("SELECT status, progress, library_item_id FROM arr_requests WHERE arr_id = 7").get() as { status: string; progress: number; library_item_id: number | null };
  assert.equal(row.status, "downloading");
  assert.equal(row.progress, 60);

  // Phase 2: Radarr imported the file, not yet matched in Flix → importing.
  requests.__setArrClient(
    makeClient({
      radarrQueue: async () => [],
      radarrGetMovie: async () => ({ id: 7, hasFile: true, movieFile: { relativePath: "Recon Movie (2021)/Recon Movie (2021).mkv" } }),
    }),
  );
  await requests.reconcile();
  row = db.prepare("SELECT status, progress, library_item_id FROM arr_requests WHERE arr_id = 7").get() as { status: string; progress: number; library_item_id: number | null };
  assert.equal(row.status, "importing");

  // Phase 3: the file lands in the library (scanner) → available, linked.
  const movieId = Number(db.prepare("INSERT INTO movies (title, sort_title, year, folder) VALUES ('Recon Movie','recon movie',2021,'Recon Movie (2021)')").run().lastInsertRowid);
  db.prepare("INSERT INTO media_files (movie_id, filepath, size, mtime) VALUES (?, 'Recon Movie (2021)/Recon Movie (2021).mkv', 1000, 0)").run(movieId);
  await requests.reconcile();
  row = db.prepare("SELECT status, progress, library_item_id FROM arr_requests WHERE arr_id = 7").get() as { status: string; progress: number; library_item_id: number | null };
  assert.equal(row.status, "available");
  assert.equal(row.library_item_id, movieId);

  requests.__resetPoller();
});

test("stall watchdog: a download stuck at 0% past the threshold falls back to balanced + re-searches", async () => {
  const { db, requests } = await setup();
  const now = Date.now();
  db.prepare("INSERT INTO arr_requests (user_id, media_type, tmdb_id, title, year, arr_id, status, progress, created_at, updated_at) VALUES (1,'movie',800,'Stuck Movie',2021,8,'downloading',0,?,?)").run(now, now);

  let balancedFor: number | null = null;
  let removedQueueId: number | null = null;
  let searchedMovieId: number | null = null;
  // A stalled queue item: downloading, 0% (size≈sizeleft), warning status.
  const stalledClient = () =>
    makeClient({
      radarrQueue: async () => [{ id: 555, movieId: 8, status: "warning", trackedDownloadStatus: "warning", size: 1000, sizeleft: 999 }],
      radarrGetMovie: async () => ({ id: 8, hasFile: false, qualityProfileId: 1 }),
      applyBalancedProfile: async (_svc, id) => {
        balancedFor = id;
        return true;
      },
      radarrRemoveQueueItem: async (qid) => {
        removedQueueId = qid;
      },
      radarrSearchMovie: async (mid) => {
        searchedMovieId = mid;
      },
    });

  // Pass 1: first time we see the stall → clock starts, NO fallback yet.
  requests.__setArrClient(stalledClient());
  await requests.reconcile();
  let row = db.prepare("SELECT status, stalled_since, quality_fallback FROM arr_requests WHERE arr_id = 8").get() as {
    status: string;
    stalled_since: number | null;
    quality_fallback: number;
  };
  assert.equal(row.status, "downloading");
  assert.ok(row.stalled_since, "stalled_since should be set on the first stalled pass");
  assert.equal(row.quality_fallback, 0);
  assert.equal(balancedFor, null, "no fallback within the window");

  // Backdate the stall to 11 minutes ago so the next pass is past the 10-min threshold.
  db.prepare("UPDATE arr_requests SET stalled_since = ? WHERE arr_id = 8").run(Date.now() - 11 * 60_000);

  // Pass 2: stall outlasted the window → fallback fires.
  requests.__setArrClient(stalledClient());
  await requests.reconcile();
  row = db.prepare("SELECT status, stalled_since, quality_fallback FROM arr_requests WHERE arr_id = 8").get() as {
    status: string;
    stalled_since: number | null;
    quality_fallback: number;
  };
  assert.equal(balancedFor, 1, "quality profile retuned to balanced");
  assert.equal(removedQueueId, 555, "stuck download blocklisted + removed");
  assert.equal(searchedMovieId, 8, "a fresh search was triggered");
  assert.equal(row.status, "searching");
  assert.equal(row.stalled_since, null);
  assert.equal(row.quality_fallback, 1);

  requests.__resetPoller();
});

test("route guards: kids → 403 on GET/POST, CSRF enforced on POST", async () => {
  const { requests } = await setup();
  requests.__setArrClient(makeClient());
  const { createUser, getUserByName, createSessionToken } = await import("../src/server/auth");
  const { GET, POST } = await import("../src/app/api/arr/requests/route");

  assert.equal(createUser("arrkid", "kidpass123", { isKids: true }).ok, true);
  const kid = getUserByName("arrkid");
  assert.ok(kid);
  const kidToken = createSessionToken(kid.id);

  // Kids GET → 403.
  const getRes = await GET(new Request("http://localhost:4247/api/arr/requests", { headers: { authorization: `Bearer ${kidToken}` } }));
  assert.equal(getRes.status, 403);

  // Kids POST (bearer, CSRF-exempt) → 403.
  const kidPost = await POST(
    new Request("http://localhost:4247/api/arr/requests", {
      method: "POST",
      headers: { authorization: `Bearer ${kidToken}`, "content-type": "application/json" },
      body: JSON.stringify({ mediaType: "movie", tmdbId: 1 }),
    }),
  );
  assert.equal(kidPost.status, 403);

  // Cookie-authed POST with no Origin/Referer → CSRF 403 (before auth).
  const csrfPost = await POST(
    new Request("http://localhost:4247/api/arr/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaType: "movie", tmdbId: 1 }),
    }),
  );
  assert.equal(csrfPost.status, 403);

  requests.__resetPoller();
});
