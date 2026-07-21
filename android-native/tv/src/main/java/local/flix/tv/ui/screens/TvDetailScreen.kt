package local.flix.tv.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import local.flix.core.model.CatalogItem
import local.flix.core.model.EpisodeDetail
import local.flix.core.model.ShowDetail
import local.flix.core.model.flattenEpisodes
import local.flix.core.model.nextUpEpisode
import local.flix.tv.ui.TvUiState
import local.flix.tv.ui.TvViewModel
import local.flix.tv.ui.components.MetaChip
import local.flix.tv.ui.components.TvImage
import local.flix.tv.ui.components.metaLine
import local.flix.tv.ui.theme.LocalFlixTvColors

private const val OVERSCAN = 48

@Composable
fun TvDetailScreen(vm: TvViewModel, ui: TvUiState, type: String, id: Int) {
    val colors = LocalFlixTvColors.current
    Box(Modifier.fillMaxSize().background(colors.background)) {
        if (type == "movie") {
            ui.movieDetails[id]?.let { detail -> TvMovieDetail(vm, ui, detail.item) }
        } else {
            ui.showDetails[id]?.let { detail -> TvShowDetail(vm, ui, detail) }
        }
    }
}

@Composable
private fun TvHeaderArt(vm: TvViewModel, item: CatalogItem, matchPct: Int? = null, actions: @Composable () -> Unit) {
    val colors = LocalFlixTvColors.current
    Box(Modifier.fillMaxWidth().height(480.dp)) {
        TvImage(vm.api, item.backdropHash ?: item.posterHash ?: item.thumbHash, width = 1440, modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(colors.surface, colors.background))))
        }
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to colors.background, 0.35f to colors.background.copy(alpha = 0.7f), 0.8f to Color.Transparent)))
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Color.Transparent, 0.5f to Color.Transparent, 1f to colors.background)))

        Row(Modifier.align(Alignment.BottomStart).padding(OVERSCAN.dp), verticalAlignment = Alignment.Bottom) {
            // The vertical poster ("cover") next to the details — the shape the
            // user expects from a streaming app.
            Box(Modifier.width(190.dp).height(285.dp).clip(RoundedCornerShape(10.dp))) {
                TvImage(vm.api, item.posterHash ?: item.backdropHash, width = 480, modifier = Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize().background(colors.surfaceFocused))
                }
            }
            Spacer(Modifier.width(28.dp))
            Column(Modifier.width(720.dp)) {
                val logo = item.logoHash
                if (logo != null) {
                    TvImage(vm.api, logo, width = 960, modifier = Modifier.fillMaxWidth(0.72f).height(90.dp), contentScale = androidx.compose.ui.layout.ContentScale.Fit) {
                        Text(item.title, color = colors.text, fontSize = 38.sp, fontWeight = FontWeight.Black)
                    }
                } else {
                    Text(item.title, color = colors.text, fontSize = 38.sp, fontWeight = FontWeight.Black, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (matchPct != null && matchPct > 0) {
                        Text("Recommandé à $matchPct %", color = colors.positive, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                    }
                    metaLine(item).forEach { MetaChip(it) }
                }
                if (item.genres.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    Text(item.genres.take(4).joinToString("  •  "), color = colors.textFaint, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                }
                item.synopsis?.let {
                    Spacer(Modifier.height(12.dp))
                    Text(it, color = colors.textMuted, fontSize = 15.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, lineHeight = 21.sp)
                }
                Spacer(Modifier.height(20.dp))
                actions()
            }
        }
    }
}

@Composable
private fun TvActionButton(label: String, primary: Boolean, onClick: () -> Unit) {
    val colors = LocalFlixTvColors.current
    Surface(
        onClick = onClick,
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (primary) colors.text else colors.chip,
            focusedContainerColor = colors.accent,
        ),
        shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(6.dp)),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
    ) {
        Text(
            label,
            color = if (primary) colors.background else colors.text,
            fontWeight = FontWeight.Bold,
            fontSize = 16.sp,
            modifier = Modifier.padding(horizontal = 24.dp, vertical = 13.dp),
        )
    }
}

@Composable
private fun TvActionRow(vm: TvViewModel, type: String, id: Int, playLabel: String, onPlay: () -> Unit) {
    val inList = vm.isInMyList(type, id)
    val rating = vm.ratingFor(type, id)
    val liked = rating == 1 || rating == 2
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        TvActionButton("▶  $playLabel", primary = true, onClick = onPlay)
        TvActionButton(if (inList) "✓  Ma liste" else "+  Ma liste", primary = false) { vm.toggleMyList(type, id) }
        TvActionButton(if (liked) "👍  Aimé" else "👍", primary = false) { vm.setRating(type, id, if (liked) 0 else 1) }
    }
}

@Composable
private fun TvMovieDetail(vm: TvViewModel, ui: TvUiState, item: CatalogItem) {
    // Same resume semantics as the home-screen cards: a mid-watched movie must
    // resume from its saved position, not silently restart at 0:00.
    val progress = ui.userState.progress.firstOrNull { it.itemType == "movie" && it.itemId == item.id && !it.watched && it.ratio in 0.02..0.92 }
    LazyColumn(Modifier.fillMaxSize()) {
        item(key = "header") {
            TvHeaderArt(vm, item, matchPct = ui.recommend.matchScores[item.key]) {
                TvActionRow(vm, item.type, item.id, if (progress != null) "Reprendre" else "Lecture") {
                    vm.play(item.type, item.id, resumeMs = ((progress?.position ?: 0.0) * 1000).toLong())
                }
            }
        }
        item(key = "similar") { TvSimilarRow(vm, ui, item) }
        item(key = "tail") { Spacer(Modifier.height(OVERSCAN.dp)) }
    }
}

@Composable
private fun TvShowDetail(vm: TvViewModel, ui: TvUiState, show: ShowDetail) {
    var selectedSeason by remember(show.item.id) { mutableStateOf(show.seasons.firstOrNull { it.seasonNumber > 0 }?.seasonNumber ?: show.seasons.firstOrNull()?.seasonNumber ?: 1) }
    val season = show.seasons.firstOrNull { it.seasonNumber == selectedSeason }
    val nextUp = nextUpEpisode(show, ui.userState)
    val colors = LocalFlixTvColors.current

    LazyColumn(Modifier.fillMaxSize()) {
        item(key = "header") {
            TvHeaderArt(vm, show.item, matchPct = ui.recommend.matchScores[show.item.key]) {
                val playLabel = if (nextUp != null) "Reprendre" else "Lecture"
                TvActionRow(vm, "show", show.item.id, playLabel) {
                    val ep = nextUp ?: show.flattenEpisodes().firstOrNull()
                    if (ep != null) {
                        // "Reprendre" must actually resume: nextUpEpisode can
                        // return an episode already IN PROGRESS — starting it
                        // at 0:00 would lose the position the home-screen card
                        // and the episode rows below both restore correctly.
                        val progress = ui.userState.progress.firstOrNull { it.itemType == "episode" && it.itemId == ep.id && !it.watched }
                        vm.play("show", show.item.id, ep.id, ((progress?.position ?: 0.0) * 1000).toLong())
                    } else {
                        vm.play("show", show.item.id)
                    }
                }
            }
        }
        item(key = "seasons") {
            Row(Modifier.padding(horizontal = OVERSCAN.dp, vertical = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                show.seasons.forEach { s ->
                    val on = s.seasonNumber == selectedSeason
                    Surface(
                        onClick = { selectedSeason = s.seasonNumber },
                        colors = ClickableSurfaceDefaults.colors(containerColor = if (on) colors.text else colors.chip, focusedContainerColor = colors.accent),
                        shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(6.dp)),
                        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
                    ) {
                        Text(
                            if (s.seasonNumber == 0) "Spéciaux" else "Saison ${s.seasonNumber}",
                            color = if (on) colors.background else colors.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp),
                        )
                    }
                }
            }
        }
        items(season?.episodes.orEmpty(), key = { it.id }) { ep -> TvEpisodeRow(vm, ui, show.item.id, ep) }
        item(key = "similar") { TvSimilarRow(vm, ui, show.item) }
        item(key = "tail") { Spacer(Modifier.height(OVERSCAN.dp)) }
    }
}

// --- similar titles ----------------------------------------------------------

/** Netflix's « Titres similaires » : ranked by shared-genre count (then
 *  recency) against the whole visible catalogue — the same signal the web's
 *  relatedItems() uses. Pure client-side, nothing to fetch. */
private fun similarItems(item: CatalogItem, ui: TvUiState, limit: Int = 15): List<CatalogItem> {
    val pool = (ui.visibleMovies + ui.visibleShows).filter { it.key != item.key }
    if (item.genres.isEmpty()) return pool.sortedByDescending { it.addedAt }.take(limit)
    return pool
        .map { c -> c to c.genres.count { it in item.genres } }
        .filter { it.second > 0 }
        .sortedWith(compareByDescending<Pair<CatalogItem, Int>> { it.second }.thenByDescending { it.first.addedAt })
        .map { it.first }
        .take(limit)
}

@Composable
private fun TvSimilarRow(vm: TvViewModel, ui: TvUiState, item: CatalogItem) {
    val colors = LocalFlixTvColors.current
    val similar = remember(item.key, ui.library, ui.isKids) { similarItems(item, ui) }
    if (similar.isEmpty()) return
    Column(Modifier.padding(top = 10.dp)) {
        Text(
            "Titres similaires",
            color = colors.text,
            fontSize = 17.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(start = OVERSCAN.dp, bottom = 2.dp),
        )
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = PaddingValues(start = OVERSCAN.dp, end = OVERSCAN.dp, top = 8.dp, bottom = 8.dp),
        ) {
            items(similar, key = { it.key }) { s ->
                // progress=null → the tile always opens the detail sheet, the
                // right move in a discovery row.
                TvTile(vm, s, null, false) {}
            }
        }
    }
}

@Composable
private fun TvEpisodeRow(vm: TvViewModel, ui: TvUiState, showId: Int, ep: EpisodeDetail) {
    val colors = LocalFlixTvColors.current
    val progress = ui.userState.progress.firstOrNull { it.itemType == "episode" && it.itemId == ep.id }
    Card(
        onClick = { vm.play("show", showId, ep.id, ((progress?.position ?: 0.0) * 1000).toLong()) },
        modifier = Modifier.fillMaxWidth().padding(horizontal = OVERSCAN.dp, vertical = 5.dp),
        shape = CardDefaults.shape(shape = RoundedCornerShape(8.dp)),
        border = CardDefaults.border(focusedBorder = Border(BorderStroke(2.dp, Color.White), shape = RoundedCornerShape(8.dp))),
        colors = CardDefaults.colors(containerColor = colors.surface, focusedContainerColor = colors.surfaceFocused),
    ) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(200.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(6.dp))) {
                TvImage(vm.api, ep.thumbHash, width = 480, modifier = Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize().background(colors.surfaceFocused))
                }
                if (progress != null && progress.ratio > 0.02) {
                    Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Color.Black.copy(alpha = 0.4f))) {
                        Box(Modifier.fillMaxWidth(progress.ratio.toFloat()).height(3.dp).background(colors.accent))
                    }
                }
            }
            Spacer(Modifier.width(18.dp))
            Column(Modifier.fillMaxWidth()) {
                Text("${ep.episodeNumber}. ${ep.title ?: "Épisode ${ep.episodeNumber}"}", color = colors.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                ep.synopsis?.let {
                    Spacer(Modifier.height(4.dp))
                    Text(it, color = colors.textMuted, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 18.sp)
                }
            }
        }
    }
}
