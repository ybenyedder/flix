// Pure helpers for the *arr integration — no I/O, no DB, no network. Kept
// dependency-free so the request lifecycle logic (the part most likely to be
// wrong) is exhaustively unit-tested in test/arr-statusmap.test.ts.

export type RequestStatus = "requested" | "searching" | "downloading" | "importing" | "available" | "failed";

/** A request status is "active" while the poller must keep reconciling it — a
 *  terminal status (available/failed) is left alone. */
export function isActiveStatus(status: RequestStatus): boolean {
  return status !== "available" && status !== "failed";
}

/** Download progress as a 0..100 integer from a queue item's size/sizeleft.
 *  Guards the size==0 case (arr reports 0/0 briefly right after a grab). */
export function queueProgress(size: number | null | undefined, sizeleft: number | null | undefined): number {
  const total = typeof size === "number" && size > 0 ? size : 0;
  if (total === 0) return 0;
  const left = typeof sizeleft === "number" && sizeleft >= 0 ? sizeleft : 0;
  const pct = ((total - left) / total) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** Loose shape of a Radarr/Sonarr queue record (only the fields we read). */
export interface QueueItem {
  status?: string; // queued | downloading | completed | failed | warning | paused | delay
  trackedDownloadState?: string; // downloading | importPending | importing | imported | failedPending | failed
  trackedDownloadStatus?: string; // ok | warning | error
  size?: number;
  sizeleft?: number;
  errorMessage?: string;
}

export interface StatusResult {
  status: RequestStatus;
  progress: number;
  error?: string;
}

function queueError(item: QueueItem): string | null {
  const state = (item.trackedDownloadState ?? "").toLowerCase();
  const status = (item.status ?? "").toLowerCase();
  const trackedStatus = (item.trackedDownloadStatus ?? "").toLowerCase();
  if (status === "failed" || state === "failed" || state === "failedpending") {
    return item.errorMessage?.trim() || "Le téléchargement a échoué";
  }
  // A warning with an explicit message is treated as a soft failure so the user
  // isn't left staring at an eternally "downloading" row (stalled, no seeders…).
  if (trackedStatus === "error") return item.errorMessage?.trim() || "Erreur du client de téléchargement";
  return null;
}

function isImporting(item: QueueItem): boolean {
  const state = (item.trackedDownloadState ?? "").toLowerCase();
  const status = (item.status ?? "").toLowerCase();
  return state === "importpending" || state === "importing" || state === "imported" || status === "completed";
}

/** Map a movie request's world (its Radarr queue item, whether Radarr already
 *  has the file, and whether Flix has matched it into the library) to a status. */
export function mapMovieStatus(input: { queueItem?: QueueItem | null; hasFile?: boolean; libraryMatched?: boolean }): StatusResult {
  // Matched into the Flix library — the end state, regardless of what arr says.
  if (input.libraryMatched) return { status: "available", progress: 100 };

  const item = input.queueItem;
  if (item) {
    const err = queueError(item);
    if (err) return { status: "failed", progress: queueProgress(item.size, item.sizeleft), error: err };
    if (isImporting(item)) return { status: "importing", progress: 100 };
    return { status: "downloading", progress: queueProgress(item.size, item.sizeleft) };
  }

  // No queue item: either Radarr already imported the file (waiting for Flix's
  // watcher to rescan and match it) or it's still hunting for a release.
  if (input.hasFile) return { status: "importing", progress: 100 };
  return { status: "searching", progress: 0 };
}

/** Map a show request. Sonarr requests are monitored series: `episodeFileCount`
 *  standing in for movie `hasFile` (any episode landed → we're importing). */
export function mapShowStatus(input: { queueItem?: QueueItem | null; episodeFileCount?: number; libraryMatched?: boolean }): StatusResult {
  if (input.libraryMatched) return { status: "available", progress: 100 };

  const item = input.queueItem;
  if (item) {
    const err = queueError(item);
    if (err) return { status: "failed", progress: queueProgress(item.size, item.sizeleft), error: err };
    if (isImporting(item)) return { status: "importing", progress: 100 };
    return { status: "downloading", progress: queueProgress(item.size, item.sizeleft) };
  }

  if ((input.episodeFileCount ?? 0) > 0) return { status: "importing", progress: 100 };
  return { status: "searching", progress: 0 };
}

// --- stall watchdog (pure) ---------------------------------------------------

/** How long a download may sit at ~0% before Flix falls back to balanced. */
export const DEFAULT_STALL_MINUTES = 10;
/** A download counts as "stuck at 0%" while its progress stays at/under this. */
export const STALL_PROGRESS_CEILING = 2;

/** Is this queue item a download that's stuck near 0%? True when it's actively
 *  "downloading" (not importing/failed), progress is still ≤ the ceiling, AND it
 *  has NOT advanced since the previous pass (`prevProgress`) — the shape of a
 *  dead/poorly-seeded release. The no-advance check matters: a large download
 *  crawling up slowly still counts as alive and must not be killed, whereas one
 *  frozen at the same low % is the real stall we fall back from. */
export function isStalledDownload(item: QueueItem | null | undefined, progress: number, prevProgress: number): boolean {
  if (!item) return false;
  if (isImporting(item)) return false;
  if (queueError(item)) return false; // already a hard failure — handled elsewhere
  if (progress > STALL_PROGRESS_CEILING) return false;
  return progress <= prevProgress; // no forward movement since last pass
}

export interface StallDecision {
  /** New value for the request's stalled_since (null clears it). */
  stalledSince: number | null;
  /** Trigger the one-time balanced fallback now. */
  fallback: boolean;
}

/** Decide the stall bookkeeping for one reconcile pass. Pure so the timing logic
 *  is unit-tested without the DB/clock. `stalled` is isStalledDownload's result,
 *  `prevSince` the stored stalled_since, `alreadyFellBack` the quality_fallback
 *  flag. Sets the clock on the first stalled pass, clears it once the download
 *  advances, and fires the fallback once the stall outlasts `thresholdMs`. */
export function stallDecision(input: {
  stalled: boolean;
  prevSince: number | null;
  alreadyFellBack: boolean;
  now: number;
  thresholdMs: number;
}): StallDecision {
  if (!input.stalled) return { stalledSince: null, fallback: false };
  const since = input.prevSince ?? input.now;
  const fallback = !input.alreadyFellBack && input.now - since >= input.thresholdMs;
  return { stalledSince: since, fallback };
}

// --- title matching ----------------------------------------------------------

/** Normalise a title for fuzzy library matching: lowercase, strip diacritics,
 *  drop punctuation, collapse whitespace. "Amélie: Le Fabuleux Destin" and
 *  "amelie le fabuleux destin" compare equal. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whether two catalogue entries plausibly refer to the same title. Year, when
 *  both are known, must match within one (release-year vs. metadata drift). */
export function titlesMatch(a: { title: string; year?: number | null }, b: { title: string; year?: number | null }): boolean {
  if (normalizeTitle(a.title) !== normalizeTitle(b.title)) return false;
  if (typeof a.year === "number" && typeof b.year === "number") return Math.abs(a.year - b.year) <= 1;
  return true;
}

// --- poster proxy allowlist --------------------------------------------------

// Remote poster hosts the arr lookup endpoints hand back. The proxy
// (/api/arr/poster) refuses anything else, so a compromised/malicious arr
// response can't turn Flix into an open SSRF relay.
const ALLOWED_POSTER_HOSTS = new Set(["image.tmdb.org", "artworks.thetvdb.com", "assets.fanart.tv"]);

/** True only for an https URL whose host is exactly one of the allowed CDNs.
 *  Rejects http, userinfo (`user@evil`), and look-alike suffixes
 *  (`image.tmdb.org.evil.com`) — hostname is compared by exact set membership. */
export function isAllowedPosterUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return ALLOWED_POSTER_HOSTS.has(url.hostname);
}
