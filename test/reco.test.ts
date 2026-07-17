// Phase 7 taste engine tests: the pure content-similarity model
// (src/lib/flix/reco.ts) plus the feedback-driven engine
// (src/server/reco/engine.ts) against a real temporary SQLite database —
// signal weighting, genre generalisation, hard dislike exclusion, temporal
// decay, the kids content gate on every output, and becauseYouWatched's
// "never a seen item" guarantee. Isolated temp data dir, same pattern as
// state.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DB } from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flix-reco-test-"));
process.env.FLIX_DATA_DIR = tmp;
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const DAY = 86_400_000;

let nextUserId = 1;
function freshUser(): number {
  return nextUserId++;
}

interface MovieOpts {
  title: string;
  genres?: string[];
  year?: number;
  duration?: number;
  contentRating?: string | null;
  studio?: string | null;
  actors?: string[];
  addedAt?: number;
}

function addMovie(db: DB, opts: MovieOpts): number {
  const info = db
    .prepare(
      `INSERT INTO movies (title, sort_title, year, duration, genres, actors, directors, studio, content_rating, folder, added_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
    )
    .run(
      opts.title,
      opts.title.toLowerCase(),
      opts.year ?? 2020,
      opts.duration ?? 6000,
      JSON.stringify(opts.genres ?? []),
      JSON.stringify((opts.actors ?? []).map((name) => ({ name, role: null }))),
      opts.studio ?? null,
      opts.contentRating ?? null,
      `/tmp/reco-test/${opts.title}-${Math.random()}`,
      opts.addedAt ?? Date.now(),
    );
  return Number(info.lastInsertRowid);
}

interface ShowOpts {
  title: string;
  genres?: string[];
  year?: number;
  contentRating?: string | null;
  addedAt?: number;
}

function addShow(db: DB, opts: ShowOpts): number {
  const info = db
    .prepare(
      `INSERT INTO shows (title, sort_title, year, genres, actors, studio, content_rating, folder, added_at)
       VALUES (?, ?, ?, ?, '[]', NULL, ?, ?, ?)`,
    )
    .run(opts.title, opts.title.toLowerCase(), opts.year ?? 2020, JSON.stringify(opts.genres ?? []), opts.contentRating ?? null, `/tmp/reco-test/${opts.title}-${Math.random()}`, opts.addedAt ?? Date.now());
  return Number(info.lastInsertRowid);
}

function getOrCreateSeason(db: DB, showId: number): number {
  const existing = db.prepare("SELECT id FROM seasons WHERE show_id = ? AND season_number = 1").get(showId) as { id: number } | undefined;
  if (existing) return existing.id;
  return Number(db.prepare("INSERT INTO seasons (show_id, season_number) VALUES (?, 1)").run(showId).lastInsertRowid);
}

function addEpisode(db: DB, showId: number, episodeNumber: number, duration = 1500): number {
  const seasonId = getOrCreateSeason(db, showId);
  const info = db
    .prepare("INSERT INTO episodes (show_id, season_id, episode_number, duration, added_at) VALUES (?, ?, ?, ?, ?)")
    .run(showId, seasonId, episodeNumber, duration, Date.now());
  return Number(info.lastInsertRowid);
}

function addWatchEvent(
  db: DB,
  userId: number,
  opts: { itemType: "movie" | "episode"; itemId: number; topType: "movie" | "show"; topId: number; kind: "complete" | "abandon"; ratio: number; createdAt: number },
): void {
  db.prepare(
    "INSERT INTO watch_events (user_id, item_type, item_id, top_type, top_id, kind, ratio, seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
  ).run(userId, opts.itemType, opts.itemId, opts.topType, opts.topId, opts.kind, opts.ratio, opts.createdAt);
}

function addRating(db: DB, userId: number, itemType: "movie" | "show", itemId: number, value: number, createdAt = Date.now()): void {
  db.prepare("INSERT INTO ratings (user_id, item_type, item_id, value, created_at) VALUES (?, ?, ?, ?, ?)").run(userId, itemType, itemId, value, createdAt);
}

function addMyList(db: DB, userId: number, itemType: "movie" | "show", itemId: number, createdAt = Date.now()): void {
  db.prepare("INSERT INTO my_list (user_id, item_type, item_id, created_at) VALUES (?, ?, ?, ?)").run(userId, itemType, itemId, createdAt);
}

async function mods() {
  const db = (await import("../src/server/db")).getDb();
  const engine = await import("../src/server/reco/engine");
  return { db, ...engine };
}

// ---------------------------------------------------------------------------
// Pure content-similarity model (src/lib/flix/reco.ts) — no DB.
// ---------------------------------------------------------------------------

test("contentSimilarity: identical items score higher than items sharing nothing", async () => {
  const { buildFeatures, contentSimilarity } = await import("../src/lib/flix/reco");
  const a = buildFeatures({ type: "movie", genres: ["Action", "Sci-Fi"], year: 2010, durationSeconds: 7200, people: ["Alice", "Bob"], studio: "Acme" });
  const b = buildFeatures({ type: "movie", genres: ["Action", "Sci-Fi"], year: 2011, durationSeconds: 7100, people: ["Alice", "Carol"], studio: "Acme" });
  const c = buildFeatures({ type: "movie", genres: ["Romance"], year: 1955, durationSeconds: 3600, people: ["Zed"], studio: "Other" });
  assert.ok(contentSimilarity(a, b) > contentSimilarity(a, c), "close-genre/close-decade/shared-studio item scores higher");
  assert.ok(contentSimilarity(a, b) > 0.6);
  assert.ok(contentSimilarity(a, c) < 0.3);
});

test("contentSimilarity: missing decade/duration neutralises that axis rather than penalising it", async () => {
  const { buildFeatures, contentSimilarity } = await import("../src/lib/flix/reco");
  const withYear = buildFeatures({ type: "movie", genres: ["Drama"], year: 2000, durationSeconds: 6000, people: [], studio: null });
  const noYear = buildFeatures({ type: "movie", genres: ["Drama"], year: null, durationSeconds: null, people: [], studio: null });
  const sim = contentSimilarity(withYear, noYear);
  // Genres match fully (0.55), decade/duration both neutral at 0.5 (0.15*0.5+0.10*0.5), no people/studio overlap.
  assert.ok(Math.abs(sim - (0.55 + 0.15 * 0.5 + 0.1 * 0.5)) < 1e-9);
});

test("matchPercent: 0 score maps to 50%, and the badge stays within [0,100]", async () => {
  const { matchPercent } = await import("../src/lib/flix/reco");
  assert.equal(matchPercent(0), 50);
  assert.ok(matchPercent(10) <= 100);
  assert.ok(matchPercent(-10) >= 0);
  assert.ok(matchPercent(1) > 50);
  assert.ok(matchPercent(-1) < 50);
});

// ---------------------------------------------------------------------------
// Engine — cold start
// ---------------------------------------------------------------------------

test("cold start: every non-excluded item is scored, profile carries no signal", async () => {
  const { db, scoreAll, recommend } = await mods();
  const user = freshUser();
  const m = addMovie(db, { title: `Cold ${user}`, genres: ["Drama"] });
  const scores = scoreAll(user, false);
  assert.ok(scores.has(`movie:${m}`));
  const ranked = recommend(user, false, 500);
  assert.ok(ranked.some((r) => r.type === "movie" && r.id === m));
});

// ---------------------------------------------------------------------------
// Genre generalisation from a single abandon
// ---------------------------------------------------------------------------

test("an early abandon of one action title lowers OTHER, never-watched action titles vs an unrelated genre", async () => {
  const { db, invalidateReco, scoreAll } = await mods();
  const user = freshUser();
  const abandoned = addMovie(db, { title: `Abandoned Action ${user}`, genres: ["Action"] });
  const otherAction = addMovie(db, { title: `Other Action ${user}`, genres: ["Action"] });
  const unrelatedComedy = addMovie(db, { title: `Unrelated Comedy ${user}`, genres: ["Comedy"] });

  addWatchEvent(db, user, { itemType: "movie", itemId: abandoned, topType: "movie", topId: abandoned, kind: "abandon", ratio: 0.05, createdAt: Date.now() });
  invalidateReco(user);

  const scores = scoreAll(user, false);
  const actionScore = scores.get(`movie:${otherAction}`) ?? 0;
  const comedyScore = scores.get(`movie:${unrelatedComedy}`) ?? 0;
  assert.ok(actionScore < comedyScore, "the unseen same-genre title cools down relative to the unrelated one");
});

// ---------------------------------------------------------------------------
// Hard exclusions and boosts
// ---------------------------------------------------------------------------

test("a thumbs-down permanently excludes an item, even backdated far in the past", async () => {
  const { db, invalidateReco, scoreAll, recommend } = await mods();
  const user = freshUser();
  const disliked = addMovie(db, { title: `Disliked ${user}`, genres: ["Horror"] });
  addRating(db, user, "movie", disliked, -1, Date.now() - 1000 * DAY);
  invalidateReco(user);

  const scores = scoreAll(user, false);
  assert.ok(!scores.has(`movie:${disliked}`), "disliked item never gets a score at all");
  const ranked = recommend(user, false, 500);
  assert.ok(!ranked.some((r) => r.type === "movie" && r.id === disliked));
});

test("a thumbs-up and a my-list add both boost a title's score above a neutral one", async () => {
  const { db, invalidateReco, scoreAll } = await mods();
  const user = freshUser();
  const liked = addMovie(db, { title: `Liked ${user}`, genres: ["Fantasy-A"] });
  const listed = addMovie(db, { title: `Listed ${user}`, genres: ["Fantasy-B"] });
  const neutral = addMovie(db, { title: `Neutral ${user}`, genres: ["Fantasy-C"] });
  addRating(db, user, "movie", liked, 1);
  addMyList(db, user, "movie", listed);
  invalidateReco(user);

  const scores = scoreAll(user, false);
  const neutralScore = scores.get(`movie:${neutral}`) ?? 0;
  assert.ok((scores.get(`movie:${liked}`) ?? 0) > neutralScore, "thumbs-up boosts above neutral");
  assert.ok((scores.get(`movie:${listed}`) ?? 0) > neutralScore, "my-list boosts above neutral");
});

test("'love it' (rating 2) boosts a title's score more than a plain thumbs-up", async () => {
  const { db, invalidateReco, scoreAll } = await mods();
  const user = freshUser();
  const loved = addMovie(db, { title: `Loved ${user}`, genres: ["Musical-A"] });
  const liked = addMovie(db, { title: `LikedPlain ${user}`, genres: ["Musical-B"] });
  addRating(db, user, "movie", loved, 2);
  addRating(db, user, "movie", liked, 1);
  invalidateReco(user);

  const scores = scoreAll(user, false);
  assert.ok((scores.get(`movie:${loved}`) ?? 0) > (scores.get(`movie:${liked}`) ?? 0));
});

// ---------------------------------------------------------------------------
// Temporal decay
// ---------------------------------------------------------------------------

test("temporal decay: a recent completion outweighs an identical but old one", async () => {
  const { db, invalidateReco, scoreAll } = await mods();
  const user = freshUser();
  // Distinct genres so the content axis doesn't itself become the deciding
  // factor — this isolates the direct + genre-affinity axes, both decay-driven.
  const recent = addMovie(db, { title: `Recent ${user}`, genres: [`Mystery-Recent-${user}`] });
  const old = addMovie(db, { title: `Old ${user}`, genres: [`Mystery-Old-${user}`] });

  addWatchEvent(db, user, { itemType: "movie", itemId: recent, topType: "movie", topId: recent, kind: "complete", ratio: 1, createdAt: Date.now() });
  addWatchEvent(db, user, { itemType: "movie", itemId: old, topType: "movie", topId: old, kind: "complete", ratio: 1, createdAt: Date.now() - 300 * DAY });
  invalidateReco(user);

  const scores = scoreAll(user, false);
  const recentScore = scores.get(`movie:${recent}`) ?? 0;
  const oldScore = scores.get(`movie:${old}`) ?? 0;
  assert.ok(recentScore > oldScore, "the fresh signal scores higher than the heavily-decayed one");
  assert.ok(recentScore - oldScore > 0.3, "the gap is substantial, not just noise");
});

test("an event past the 365-day window contributes no weight at all", async () => {
  const { db, invalidateReco, scoreAll } = await mods();
  const user = freshUser();
  const stale = addMovie(db, { title: `VeryStale ${user}`, genres: [`Western-${user}`] });
  addWatchEvent(db, user, { itemType: "movie", itemId: stale, topType: "movie", topId: stale, kind: "complete", ratio: 1, createdAt: Date.now() - 400 * DAY });
  invalidateReco(user);

  const scores = scoreAll(user, false);
  // Seen (so no explore bonus), no in-window signal, isolated genre → score
  // should sit right around the axes' zero point.
  assert.ok(Math.abs(scores.get(`movie:${stale}`) ?? 0) < 0.05);
});

// ---------------------------------------------------------------------------
// Kids content gate — applies to every engine output
// ---------------------------------------------------------------------------

test("topTen excludes adult content for a kids profile but includes it otherwise", async () => {
  const { db, invalidateReco, topTen } = await mods();
  const user = freshUser();
  const adult = addMovie(db, { title: `AdultTop ${user}`, contentRating: "R" });
  const kidsafe = addMovie(db, { title: `KidsafeTop ${user}`, contentRating: "PG" });
  addWatchEvent(db, user, { itemType: "movie", itemId: adult, topType: "movie", topId: adult, kind: "complete", ratio: 1, createdAt: Date.now() });
  addWatchEvent(db, user, { itemType: "movie", itemId: kidsafe, topType: "movie", topId: kidsafe, kind: "complete", ratio: 1, createdAt: Date.now() });
  invalidateReco(user);

  const openTop = topTen("movie", false);
  assert.ok(openTop.some((r) => r.id === adult), "non-kids sees the adult title in Top 10");

  const kidsTop = topTen("movie", true);
  assert.ok(!kidsTop.some((r) => r.id === adult), "kids profile never sees the adult title in Top 10");
  assert.ok(kidsTop.some((r) => r.id === kidsafe), "kids profile still sees the PG title");
});

test("kids gate applies to recommend(), genreRows() and scoreAll() as well, not just topTen", async () => {
  const { db, invalidateReco, recommend, genreRows, scoreAll } = await mods();
  const user = freshUser();
  const adult = addMovie(db, { title: `AdultGeneral ${user}`, genres: ["ThrillerKidsTest"], contentRating: "TV-MA" });
  const kidsafe = addMovie(db, { title: `KidsafeGeneral ${user}`, genres: ["ThrillerKidsTest"], contentRating: "PG" });
  addRating(db, user, "movie", adult, 1);
  addRating(db, user, "movie", kidsafe, 1);
  invalidateReco(user);

  assert.ok(!scoreAll(user, true).has(`movie:${adult}`));
  assert.ok(scoreAll(user, true).has(`movie:${kidsafe}`));

  assert.ok(!recommend(user, true, 1000).some((r) => r.id === adult));
  for (const row of genreRows(user, true)) assert.ok(!row.items.some((i) => i.id === adult));
});

// ---------------------------------------------------------------------------
// becauseYouWatched
// ---------------------------------------------------------------------------

test("becauseYouWatched never recommends an item the user has already seen, and excludes the seed itself", async () => {
  const { db, invalidateReco, becauseYouWatched } = await mods();
  const user = freshUser();
  const seed = addMovie(db, { title: `Seed ${user}`, genres: ["Thriller"], year: 2015 });
  const alsoSeen = addMovie(db, { title: `AlsoSeen ${user}`, genres: ["Thriller"], year: 2016 });
  const neverSeen = addMovie(db, { title: `NeverSeen ${user}`, genres: ["Thriller"], year: 2015 });

  addWatchEvent(db, user, { itemType: "movie", itemId: seed, topType: "movie", topId: seed, kind: "complete", ratio: 1, createdAt: Date.now() });
  addWatchEvent(db, user, { itemType: "movie", itemId: alsoSeen, topType: "movie", topId: alsoSeen, kind: "complete", ratio: 0.9, createdAt: Date.now() - DAY });
  invalidateReco(user);

  const rows = becauseYouWatched(user, false);
  const seedRow = rows.find((r) => r.seedType === "movie" && r.seedId === seed);
  assert.ok(seedRow, "the completed movie became a seed row");
  if (!seedRow) return;
  assert.ok(!seedRow.items.some((i) => i.id === seed), "the seed never recommends itself");
  assert.ok(!seedRow.items.some((i) => i.id === alsoSeen), "an already-watched title is never suggested");
  assert.ok(seedRow.items.some((i) => i.id === neverSeen), "a similar, unseen title is suggested");
});

test("becauseYouWatched applies the kids gate to its candidate items", async () => {
  const { db, invalidateReco, becauseYouWatched } = await mods();
  const user = freshUser();
  const seed = addMovie(db, { title: `KidsSeed ${user}`, genres: ["Adventure"], year: 2018 });
  const adultSimilar = addMovie(db, { title: `KidsAdultSimilar ${user}`, genres: ["Adventure"], year: 2018, contentRating: "R" });
  addWatchEvent(db, user, { itemType: "movie", itemId: seed, topType: "movie", topId: seed, kind: "complete", ratio: 1, createdAt: Date.now() });
  invalidateReco(user);

  const rows = becauseYouWatched(user, true);
  const seedRow = rows.find((r) => r.seedId === seed);
  if (seedRow) assert.ok(!seedRow.items.some((i) => i.id === adultSimilar));
});

// ---------------------------------------------------------------------------
// Shows: binge bonus + episode credits its show
// ---------------------------------------------------------------------------

test("bingeing several episodes of a show in one sitting boosts that show's score", async () => {
  const { db, invalidateReco, scoreAll } = await mods();
  const user = freshUser();
  const bingedShow = addShow(db, { title: `Binged ${user}`, genres: ["Sitcom-A"] });
  const casualShow = addShow(db, { title: `Casual ${user}`, genres: ["Sitcom-B"] });
  const e1 = addEpisode(db, bingedShow, 1);
  const e2 = addEpisode(db, bingedShow, 2);
  const e3 = addEpisode(db, bingedShow, 3);
  const casualEp = addEpisode(db, casualShow, 1);

  const now = Date.now();
  addWatchEvent(db, user, { itemType: "episode", itemId: e1, topType: "show", topId: bingedShow, kind: "complete", ratio: 1, createdAt: now });
  addWatchEvent(db, user, { itemType: "episode", itemId: e2, topType: "show", topId: bingedShow, kind: "complete", ratio: 1, createdAt: now + 20 * 60_000 });
  addWatchEvent(db, user, { itemType: "episode", itemId: e3, topType: "show", topId: bingedShow, kind: "complete", ratio: 1, createdAt: now + 40 * 60_000 });
  addWatchEvent(db, user, { itemType: "episode", itemId: casualEp, topType: "show", topId: casualShow, kind: "complete", ratio: 1, createdAt: now });
  invalidateReco(user);

  const scores = scoreAll(user, false);
  assert.ok((scores.get(`show:${bingedShow}`) ?? 0) > (scores.get(`show:${casualShow}`) ?? 0), "binged show outranks the single-episode one");
});

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

test("invalidateReco makes a freshly-written signal visible immediately, without waiting for the cache TTL", async () => {
  const { db, invalidateReco, scoreAll } = await mods();
  const user = freshUser();
  const target = addMovie(db, { title: `CacheTarget ${user}`, genres: ["Noir"] });

  const before = scoreAll(user, false).get(`movie:${target}`) ?? 0;
  addRating(db, user, "movie", target, 2);
  invalidateReco(user);
  const after = scoreAll(user, false).get(`movie:${target}`) ?? 0;
  assert.ok(after > before, "the new rating is reflected right after invalidateReco, not after a 2.5s wait");
});
