package local.flix.tv.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import local.flix.tv.ui.components.TvImage
import local.flix.tv.ui.theme.LocalFlixTvColors

@Composable
fun TvDetailScreen(vm: TvViewModel, ui: TvUiState, type: String, id: Int) {
    val colors = LocalFlixTvColors.current
    Box(Modifier.fillMaxSize().background(colors.background)) {
        if (type == "movie") {
            ui.movieDetails[id]?.let { detail ->
                TvMovieDetail(vm, detail.item, detail.files.firstOrNull()?.duration ?: 0.0)
            }
        } else {
            ui.showDetails[id]?.let { detail -> TvShowDetail(vm, ui, detail) }
        }
    }
}

@Composable
private fun TvHeaderArt(vm: TvViewModel, item: CatalogItem, actions: @Composable () -> Unit) {
    val colors = LocalFlixTvColors.current
    Box(Modifier.fillMaxWidth().height(460.dp)) {
        TvImage(vm.api, item.backdropHash ?: item.posterHash, width = 1440, modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().background(Color(0xFF1F1F1F)))
        }
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Color.Transparent, 0.55f to colors.background.copy(alpha = 0.85f), 1f to colors.background)))
        Row(Modifier.align(Alignment.BottomStart).padding(48.dp), verticalAlignment = Alignment.Bottom) {
            Column(Modifier.width(700.dp)) {
                Text(item.title, color = colors.text, fontSize = 34.sp, fontWeight = FontWeight.Black)
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    item.year?.let { Text(it.toString(), color = colors.textMuted, fontSize = 16.sp) }
                    item.contentRating?.let { Text(it, color = colors.textMuted, fontSize = 16.sp) }
                }
                Spacer(Modifier.height(10.dp))
                item.synopsis?.let { Text(it, color = colors.text, fontSize = 15.sp, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                Spacer(Modifier.height(18.dp))
                actions()
            }
        }
    }
}

@Composable
private fun TvActionRow(vm: TvViewModel, type: String, id: Int, onPlay: () -> Unit) {
    val colors = LocalFlixTvColors.current
    val inList = vm.isInMyList(type, id)
    val rating = vm.ratingFor(type, id)
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Surface(onClick = onPlay, colors = ClickableSurfaceDefaults.colors(containerColor = colors.text, focusedContainerColor = colors.accent), shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(4.dp))) {
            Text("▶  Lecture", color = colors.background, fontWeight = FontWeight.Bold, fontSize = 16.sp, modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp))
        }
        Surface(
            onClick = { vm.toggleMyList(type, id) },
            colors = ClickableSurfaceDefaults.colors(containerColor = colors.surface, focusedContainerColor = colors.accent),
            shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(4.dp)),
        ) {
            Text(if (inList) "✓ Ma liste" else "+ Ma liste", color = colors.text, fontSize = 16.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
        }
        Surface(
            onClick = { vm.setRating(type, id, if (rating == 1 || rating == 2) 0 else 1) },
            colors = ClickableSurfaceDefaults.colors(containerColor = colors.surface, focusedContainerColor = colors.accent),
            shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(4.dp)),
        ) {
            Text(if (rating == 1 || rating == 2) "👍 Aimé" else "👍", color = colors.text, fontSize = 16.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
        }
    }
}

@Composable
private fun TvMovieDetail(vm: TvViewModel, item: CatalogItem, duration: Double) {
    TvHeaderArt(vm, item) { TvActionRow(vm, item.type, item.id) { vm.play(item.type, item.id) } }
}

@Composable
private fun TvShowDetail(vm: TvViewModel, ui: TvUiState, show: ShowDetail) {
    var selectedSeason by remember(show.item.id) { mutableStateOf(show.seasons.firstOrNull { it.seasonNumber > 0 }?.seasonNumber ?: show.seasons.firstOrNull()?.seasonNumber ?: 1) }
    val season = show.seasons.firstOrNull { it.seasonNumber == selectedSeason }
    val nextUp = nextUpEpisode(show, ui.userState)
    val colors = LocalFlixTvColors.current

    Column(Modifier.fillMaxSize()) {
        TvHeaderArt(vm, show.item) {
            TvActionRow(vm, "show", show.item.id) {
                val ep = nextUp ?: show.flattenEpisodes().firstOrNull()
                if (ep != null) vm.play("show", show.item.id, ep.id) else vm.play("show", show.item.id)
            }
        }
        Row(Modifier.padding(horizontal = 48.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            show.seasons.forEach { s ->
                val on = s.seasonNumber == selectedSeason
                Surface(
                    onClick = { selectedSeason = s.seasonNumber },
                    colors = ClickableSurfaceDefaults.colors(containerColor = if (on) colors.text else colors.surface, focusedContainerColor = colors.accent),
                    shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(4.dp)),
                ) {
                    Text(
                        if (s.seasonNumber == 0) "Spéciaux" else "Saison ${s.seasonNumber}",
                        color = if (on) colors.background else colors.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                    )
                }
            }
        }
        LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 48.dp)) {
            items(season?.episodes.orEmpty(), key = { it.id }) { ep -> TvEpisodeRow(vm, ui, show.item.id, ep) }
        }
    }
}

@Composable
private fun TvEpisodeRow(vm: TvViewModel, ui: TvUiState, showId: Int, ep: EpisodeDetail) {
    val colors = LocalFlixTvColors.current
    val progress = ui.userState.progress.firstOrNull { it.itemType == "episode" && it.itemId == ep.id }
    Card(
        onClick = { vm.play("show", showId, ep.id, ((progress?.position ?: 0.0) * 1000).toLong()) },
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        shape = CardDefaults.shape(shape = RoundedCornerShape(4.dp)),
        colors = CardDefaults.colors(containerColor = colors.surface, focusedContainerColor = colors.surfaceFocused),
    ) {
        Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(180.dp).aspectRatio(16f / 9f)) {
                TvImage(vm.api, ep.thumbHash, width = 480, modifier = Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize().background(colors.surfaceFocused))
                }
                if (progress != null && progress.ratio > 0.02) {
                    Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Color.White.copy(alpha = 0.3f))) {
                        Box(Modifier.fillMaxWidth(progress.ratio.toFloat()).height(3.dp).background(colors.accent))
                    }
                }
            }
            Spacer(Modifier.width(16.dp))
            Column(Modifier.fillMaxWidth()) {
                Text("${ep.episodeNumber}. ${ep.title ?: "Épisode ${ep.episodeNumber}"}", color = colors.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                ep.synopsis?.let { Text(it, color = colors.textMuted, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
        }
    }
}
