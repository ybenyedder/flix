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
