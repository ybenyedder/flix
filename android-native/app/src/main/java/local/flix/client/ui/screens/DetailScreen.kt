package local.flix.client.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.ThumbDown
import androidx.compose.material.icons.filled.ThumbUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import local.flix.client.ui.AppViewModel
import local.flix.client.ui.UiState
import local.flix.client.ui.components.FlixImage
import local.flix.client.ui.components.formatDuration
import local.flix.client.ui.theme.LocalFlixColors
import local.flix.core.model.EpisodeDetail
import local.flix.core.model.SeasonDetail
import local.flix.core.model.flattenEpisodes
import local.flix.core.model.nextUpEpisode

@Composable
fun DetailScreen(vm: AppViewModel, ui: UiState, type: String, id: Int) {
    val colors = LocalFlixColors.current
    Box(Modifier.fillMaxSize().background(colors.background)) {
        LazyColumn(Modifier.fillMaxSize()) {
            item {
                if (type == "movie") {
                    val detail = ui.movieDetails[id]
                    if (detail != null) MovieHeader(vm, detail.item, detail.files.firstOrNull()?.duration ?: 0.0, detail.files.firstOrNull()?.id)
                } else {
                    val detail = ui.showDetails[id]
                    if (detail != null) {
                        ShowHeader(vm, ui, detail)
                    }
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
        Row(
            Modifier.statusBarsPadding().padding(12.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f))
                .clickable { vm.back() }.padding(8.dp),
        ) {
            Icon(Icons.Filled.ArrowBack, "Retour", tint = Color.White, modifier = Modifier.size(22.dp))
        }
    }
}

@Composable
private fun MovieHeader(vm: AppViewModel, item: local.flix.core.model.CatalogItem, duration: Double, fileId: Int?) {
    val colors = LocalFlixColors.current
    Column {
        Box(Modifier.fillMaxWidth().aspectRatio(0.9f)) {
            FlixImage(vm.api, item.backdropHash ?: item.posterHash, width = 1440, modifier = Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize().background(Color(0xFF1F1F1F)))
            }
            Box(
                Modifier.fillMaxSize().background(
                    Brush.verticalGradient(0f to Color.Transparent, 0.7f to colors.background.copy(alpha = 0.9f), 1f to colors.background),
                ),
            )
            Column(Modifier.align(Alignment.BottomStart).padding(16.dp)) {
                Text(item.title, color = colors.text, fontSize = 24.sp, fontWeight = FontWeight.Black)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    item.year?.let { Text(it.toString(), color = colors.textMuted, fontSize = 13.sp) }
                    if (duration > 0) Text(formatDuration(duration), color = colors.textMuted, fontSize = 13.sp)
                    item.contentRating?.let { Text(it, color = colors.textMuted, fontSize = 13.sp) }
                }
            }
        }
        ActionRow(vm, item.type, item.id, onPlay = { vm.play(item.type, item.id) })
        InfoBody(item)
    }
}

@Composable
private fun ShowHeader(vm: AppViewModel, ui: UiState, show: local.flix.core.model.ShowDetail) {
    val colors = LocalFlixColors.current
    var selectedSeason by remember(show.item.id) { mutableStateOf(show.seasons.firstOrNull { it.seasonNumber > 0 }?.seasonNumber ?: show.seasons.firstOrNull()?.seasonNumber ?: 1) }
    val season = show.seasons.firstOrNull { it.seasonNumber == selectedSeason }
    val nextUp = nextUpEpisode(show, ui.userState)

    Column {
        Box(Modifier.fillMaxWidth().aspectRatio(0.9f)) {
            FlixImage(vm.api, show.item.backdropHash ?: show.item.posterHash, width = 1440, modifier = Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize().background(Color(0xFF1F1F1F)))
            }
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Color.Transparent, 0.7f to colors.background.copy(alpha = 0.9f), 1f to colors.background)))
            Column(Modifier.align(Alignment.BottomStart).padding(16.dp)) {
                Text(show.item.title, color = colors.text, fontSize = 24.sp, fontWeight = FontWeight.Black)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    show.item.year?.let { Text(it.toString(), color = colors.textMuted, fontSize = 13.sp) }
                    show.item.seasonCount?.let { Text("$it saisons", color = colors.textMuted, fontSize = 13.sp) }
                }
            }
        }
        ActionRow(
            vm, show.item.type, show.item.id,
            onPlay = {
                val ep = nextUp ?: show.flattenFirst()
                if (ep != null) vm.play("show", show.item.id, ep.id) else vm.play("show", show.item.id)
            },
        )
        InfoBody(show.item)

        Spacer(Modifier.height(12.dp))
        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            show.seasons.forEach { s ->
                val on = s.seasonNumber == selectedSeason
                Box(
                    Modifier.clip(RoundedCornerShape(4.dp)).background(if (on) colors.text else colors.surface)
                        .clickable { selectedSeason = s.seasonNumber }
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                ) {
                    Text(
                        if (s.seasonNumber == 0) "Spéciaux" else "Saison ${s.seasonNumber}",
                        color = if (on) colors.background else colors.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        season?.episodes?.forEach { ep ->
            EpisodeRow(vm, ui, show.item.id, ep)
        }
    }
}

private fun local.flix.core.model.ShowDetail.flattenFirst(): EpisodeDetail? = flattenEpisodes().firstOrNull()

@Composable
private fun EpisodeRow(vm: AppViewModel, ui: UiState, showId: Int, ep: EpisodeDetail) {
    val colors = LocalFlixColors.current
    val progress = ui.userState.progress.firstOrNull { it.itemType == "episode" && it.itemId == ep.id }
    Row(
        Modifier.fillMaxWidth().clickable { vm.play("show", showId, ep.id, ((progress?.position ?: 0.0) * 1000).toLong()) }
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(120.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(4.dp))) {
            FlixImage(vm.api, ep.thumbHash, width = 480, modifier = Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize().background(Color(0xFF232323)))
            }
            if (progress != null && progress.ratio > 0.02) {
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Color.White.copy(alpha = 0.3f))) {
                    Box(Modifier.fillMaxWidth(progress.ratio.toFloat()).height(3.dp).background(colors.accent))
                }
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("${ep.episodeNumber}. ${ep.title ?: "Épisode ${ep.episodeNumber}"}", color = colors.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (ep.duration > 0) Text(formatDuration(ep.duration), color = colors.textMuted, fontSize = 11.sp)
            ep.synopsis?.let { Text(it, color = colors.textMuted, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        Icon(Icons.Filled.PlayArrow, "Lecture", tint = colors.text, modifier = Modifier.size(28.dp))
    }
}

@Composable
private fun ActionRow(vm: AppViewModel, type: String, id: Int, onPlay: () -> Unit) {
    val colors = LocalFlixColors.current
    val inList = vm.isInMyList(type, id)
    val rating = vm.ratingFor(type, id)
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).clip(RoundedCornerShape(4.dp)).background(colors.text).clickable { onPlay() }.padding(vertical = 11.dp),
            horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.PlayArrow, null, tint = colors.background, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(6.dp))
            Text("Lecture", color = colors.background, fontWeight = FontWeight.Bold, fontSize = 14.sp)
        }
        IconChip(if (inList) Icons.Filled.Check else Icons.Filled.Add, active = inList) { vm.toggleMyList(type, id) }
        IconChip(Icons.Filled.ThumbUp, active = rating == 1 || rating == 2) { vm.setRating(type, id, if (rating == 1 || rating == 2) 0 else 1) }
        IconChip(Icons.Filled.ThumbDown, active = rating == -1) { vm.setRating(type, id, if (rating == -1) 0 else -1) }
    }
}

@Composable
private fun IconChip(icon: androidx.compose.ui.graphics.vector.ImageVector, active: Boolean, onClick: () -> Unit) {
    val colors = LocalFlixColors.current
    Box(
        Modifier.size(42.dp).clip(CircleShape).background(if (active) colors.text else colors.surfaceHover).clickable { onClick() },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = if (active) colors.background else colors.text, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun InfoBody(item: local.flix.core.model.CatalogItem) {
    val colors = LocalFlixColors.current
    Column(Modifier.padding(horizontal = 16.dp)) {
        item.synopsis?.let { Text(it, color = colors.text, fontSize = 13.5.sp, lineHeight = 19.sp) }
        Spacer(Modifier.height(10.dp))
        if (item.genres.isNotEmpty()) {
            Text("Genres : ${item.genres.joinToString(", ")}", color = colors.textMuted, fontSize = 12.sp)
        }
        if (item.actors.isNotEmpty()) {
            Text("Avec : ${item.actors.take(6).joinToString(", ") { it.name }}", color = colors.textMuted, fontSize = 12.sp)
        }
        if (item.directors.isNotEmpty()) {
            Text("Réalisation : ${item.directors.joinToString(", ")}", color = colors.textMuted, fontSize = 12.sp)
        }
    }
}
