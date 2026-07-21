package local.flix.core.model

// Pure, UI-framework-free helpers shared between :app and :tv. Ported 1:1
// from the web client's equivalents so the native apps behave identically.

/** Mirrors src/lib/flix/kids.ts — a deliberately conservative content-rating
 *  gate. GET /api/library is user-independent by design (same catalogue for
 *  every profile), so a kids profile browsing/searching client-side must
 *  apply this filter itself, same as the web client's BrowseView/SearchView. */
private val ADULT_MARKERS = setOf(
    "R", "NC-17", "NC17", "X", "XXX", "AO", "TV-MA", "R18", "18+", "-18", "18",
    "INTERDIT AUX MOINS DE 18 ANS",
)
private val TEEN_MARKER = Regex("\\b1[68]\\b")

fun isAllowedForKids(contentRating: String?): Boolean {
    val normalized = contentRating?.trim()?.uppercase().orEmpty()
    if (normalized.isEmpty()) return true
    if (normalized in ADULT_MARKERS) return false
    if (TEEN_MARKER.containsMatchIn(normalized)) return false
    return true
}

fun List<CatalogItem>.filterForProfile(isKids: Boolean): List<CatalogItem> =
    if (!isKids) this else filter { isAllowedForKids(it.contentRating) }

/** Flattened episode list in season/episode order — the ordering next-up and
 *  the "S2 : É4" progress labels rely on. */
fun ShowDetail.flattenEpisodes(): List<EpisodeDetail> =
    seasons.sortedBy { it.seasonNumber }.flatMap { s -> s.episodes.sortedBy { it.episodeNumber } }

/** The episode a "Continuer"/next-up card should offer for this show: the one
 *  right after the last-watched episode, or the furthest in-progress episode,
 *  or simply the first episode of the series if nothing has been watched yet. */
fun nextUpEpisode(show: ShowDetail, userState: UserState): EpisodeDetail? {
    val all = show.flattenEpisodes()
    if (all.isEmpty()) return null
    val progressByEpisode = userState.progress.filter { it.itemType == "episode" }.associateBy { it.itemId }
    val watchedIds = progressByEpisode.filterValues { it.watched }.keys
    val lastWatchedIdx = all.indexOfLast { it.id in watchedIds }
    if (lastWatchedIdx in 0 until all.lastIndex) return all[lastWatchedIdx + 1]
    val inProgress = all.firstOrNull { e -> progressByEpisode[e.id]?.let { !it.watched && it.position > 0 } == true }
    if (inProgress != null) return inProgress
    if (lastWatchedIdx == all.lastIndex) return null // series fully watched
    return all.first()
}

/** "72% de correspondance"-style badge value, resolved from RecommendResult.matchScores. */
fun matchScoreFor(matchScores: Map<String, Int>, item: CatalogItem): Int? = matchScores[item.key]

// ---- resume semantics (ported 1:1 from src/lib/flix/playerLogic.ts) ---------
// Kept identical to the web player so every client resumes at exactly the same
// spot: a few seconds of lead-in before the stored position, a 30s floor (don't
// "resume" something barely started) and a 92% ceiling (past that it's finished
// — start fresh). Previously the native clients passed the raw stored position,
// which diverged from the web (no lead-in, no floor) and — worse — the mobile
// detail buttons passed nothing at all, silently restarting at 0:00.

const val WATCHED_RATIO = 0.92
const val RESUME_MIN_POSITION = 30.0 // seconds
const val RESUME_BACK_SECONDS = 5.0

/** Where to actually resume playback from (seconds): a few seconds before the
 *  stored position, but only when there IS a meaningful stored position and the
 *  item isn't already effectively finished. Under 30s in, or past the watched
 *  threshold, returns 0 — a fresh play, not a resume. */
fun computeResumeStart(position: Double, duration: Double): Double {
    if (position <= RESUME_MIN_POSITION) return 0.0
    val ratio = if (duration > 0) position / duration else 0.0
    if (ratio >= WATCHED_RATIO) return 0.0
    return maxOf(0.0, position - RESUME_BACK_SECONDS)
}

/** Resume offset for this progress row, in ms — the value handed to ExoPlayer
 *  as a start position. A `watched` row resumes at 0: replaying a finished
 *  title must start over, not land on its final millisecond (which would fire
 *  STATE_ENDED instantly and log a bogus "complete" watch event). */
fun ProgressSummary.resumeMs(): Long =
    if (watched) 0L else (computeResumeStart(position, duration) * 1000).toLong()

/** Whether a show's primary button should read "Reprendre": the user has
 *  started the series (some episode watched or in progress) and it isn't fully
 *  watched yet. A never-started series, or one already finished, reads
 *  "Lecture" (a first watch / a rewatch from episode 1) — even though the
 *  button then legitimately jumps to the next-up episode. */
fun showHasResume(show: ShowDetail, userState: UserState): Boolean {
    val epIds = show.flattenEpisodes().map { it.id }.toSet()
    val rows = userState.progress.filter { it.itemType == "episode" && it.itemId in epIds }
    val anyStarted = rows.any { it.watched || it.position > 5.0 }
    val anyUnwatched = show.flattenEpisodes().any { ep -> rows.firstOrNull { it.itemId == ep.id }?.watched != true }
    return anyStarted && anyUnwatched
}
