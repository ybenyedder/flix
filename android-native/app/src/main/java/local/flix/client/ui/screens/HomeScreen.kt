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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import local.flix.client.ui.components.ProfileAvatar
import local.flix.client.ui.theme.LocalFlixColors
import local.flix.core.model.CatalogItem
import local.flix.core.model.ProgressSummary
import local.flix.core.model.filterForProfile

@Composable
fun HomeScreen(vm: AppViewModel, ui: UiState) {
    val colors = LocalFlixColors.current
    val rows = buildHomeRows(ui)
    val billboard = pickBillboard(ui)

    LazyColumn(Modifier.fillMaxSize().background(colors.background)) {
        item {
            Box {
                if (billboard != null) BillboardHero(vm, ui, billboard) else Spacer(Modifier.height(1.dp))
                Header(vm, ui, transparentOverlay = billboard != null)
            }
        }
        items(rows) { row ->
            ContentRow(vm, ui, row)
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

private data class HomeRow(val title: String, val items: List<CatalogItem>, val continueRow: Boolean = false)

private fun buildHomeRows(ui: UiState): List<HomeRow> {
    val rows = mutableListOf<HomeRow>()

    // The server sends progress PER EPISODE (no per-show dedup), so two
    // in-flight episodes of one show map to the same CatalogItem — distinctBy
    // keeps the first, or the LazyRow key (`it.key`) crashes the home screen.
    val continueItems = ui.userState.progress.filter { it.ratio in 0.02..0.92 }
    if (continueItems.isNotEmpty()) {
        val items = continueItems.mapNotNull { ui.library.byKey["${it.topType}:${it.topId}"] }.distinctBy { it.key }
        if (items.isNotEmpty()) rows.add(HomeRow("Continuer à regarder", items, continueRow = true))
    }

    if (ui.userState.myList.isNotEmpty()) {
        val items = ui.userState.myList.mapNotNull { ui.library.byKey[it.key] }.filterForProfile(ui.isKids).distinctBy { it.key }
        if (items.isNotEmpty()) rows.add(HomeRow("Ma liste", items))
    }

    for (row in ui.recommend.rows) {
        val items = row.items.mapNotNull { ui.library.byKey[it.key] }.filterForProfile(ui.isKids).distinctBy { it.key }
        if (items.isNotEmpty()) rows.add(HomeRow(row.title, items))
    }

    if (ui.recommend.rows.isEmpty()) {
        if (ui.visibleMovies.isNotEmpty()) rows.add(HomeRow("Films", ui.visibleMovies.sortedByDescending { it.addedAt }))
        if (ui.visibleShows.isNotEmpty()) rows.add(HomeRow("Séries", ui.visibleShows.sortedByDescending { it.addedAt }))
    }
    return rows
}

private fun pickBillboard(ui: UiState): CatalogItem? {
    ui.recommend.billboard?.let { ref -> ui.library.byKey[ref.key]?.let { return it } }
    return (ui.visibleMovies + ui.visibleShows).maxByOrNull { it.addedAt }
}

@Composable
private fun Header(vm: AppViewModel, ui: UiState, transparentOverlay: Boolean) {
    val colors = LocalFlixColors.current
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (!transparentOverlay) Modifier.background(colors.background) else Modifier)
            .statusBarsPadding()
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("FLIX", color = colors.accent, fontSize = 20.sp, fontWeight = FontWeight.Black)
        Spacer(Modifier.weight(1f))
        Icon(Icons.Filled.Search, "Rechercher", tint = colors.text, modifier = Modifier.size(24.dp).clickable { vm.navigate(local.flix.client.ui.Screen.Search) })
        Spacer(Modifier.width(16.dp))
        ProfileAvatar(ui.avatar, ui.username ?: "?", 28, onClick = { vm.logout() })
    }
}

@Composable
private fun BillboardHero(vm: AppViewModel, ui: UiState, item: CatalogItem) {
    Box(Modifier.fillMaxWidth().aspectRatio(0.68f)) {
        FlixImage(vm.api, item.backdropHash ?: item.posterHash, width = 1440, modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().background(Color(0xFF1F1F1F)))
        }
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    0f to Color.Transparent,
                    0.5f to Color.Transparent,
                    0.75f to Color(0xFF141414).copy(alpha = 0.85f),
                    1f to Color(0xFF141414),
                ),
            ),
        )
        Column(Modifier.align(Alignment.BottomStart).padding(20.dp).fillMaxWidth()) {
            Text(
                item.title, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Black,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(6.dp))
            item.synopsis?.let {
                Text(it, color = Color.White.copy(alpha = 0.85f), fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(
                    Modifier.clip(RoundedCornerShape(4.dp)).background(Color.White)
                        .clickable { vm.play(item.type, item.id) }
                        .padding(horizontal = 20.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.PlayArrow, null, tint = Color.Black, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Lecture", color = Color.Black, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                }
                Row(
                    Modifier.clip(RoundedCornerShape(4.dp)).background(Color.White.copy(alpha = 0.25f))
                        .clickable { vm.openDetail(item.type, item.id) }
                        .padding(horizontal = 20.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.Info, null, tint = Color.White, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Infos", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                }
            }
        }
    }
}

@Composable
private fun ContentRow(vm: AppViewModel, ui: UiState, row: HomeRow) {
    val colors = LocalFlixColors.current
    Column(Modifier.padding(top = 18.dp)) {
        Text(row.title, color = colors.text, fontSize = 16.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 16.dp, bottom = 10.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp)) {
            items(row.items, key = { it.key }) { item ->
                val progress = ui.userState.progress.firstOrNull { "${it.topType}:${it.topId}" == item.key }
                if (row.continueRow) ContinueCard(vm, item, progress) else PosterCard(vm, ui, item, progress)
            }
        }
    }
}

private const val POSTER_W = 118
private const val POSTER_H = 177 // 2:3

@Composable
private fun PosterCard(vm: AppViewModel, ui: UiState, item: CatalogItem, progress: ProgressSummary?) {
    val colors = LocalFlixColors.current
    val match = ui.recommend.matchScores[item.key]
    Column(
        Modifier.width(POSTER_W.dp).clickable {
            // Only resume UNFINISHED progress: a watched row has position ==
            // duration server-side, so "resuming" it would start on the last
            // millisecond, fire STATE_ENDED instantly and log a bogus
            // "complete" watch event (plus auto-advance). Watched → detail.
            if (progress != null && !progress.watched) vm.play(progress.topType, progress.topId, if (progress.itemType == "episode") progress.itemId else null, (progress.position * 1000).toLong())
            else vm.openDetail(item.type, item.id)
        },
    ) {
        Box(Modifier.width(POSTER_W.dp).height(POSTER_H.dp).clip(RoundedCornerShape(6.dp))) {
            // Prefer the vertical 2:3 poster ("cover"), fall back to a cropped
            // backdrop/thumb, then to a gradient carrying the title so a card is
            // never an empty grey box.
            FlixImage(vm.api, item.posterHash ?: item.backdropHash ?: item.thumbHash, width = 480, modifier = Modifier.fillMaxSize()) {
                Box(
                    Modifier.fillMaxSize().background(Brush.linearGradient(listOf(colors.surfaceHover, colors.surface))),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(item.title, color = colors.textMuted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 3, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.padding(8.dp))
                }
            }
            qualityBadgeLabel(item.qualityHeight, item.qualityHdr)?.let { q ->
                Box(Modifier.align(Alignment.TopEnd).padding(5.dp).clip(RoundedCornerShape(3.dp)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 5.dp, vertical = 1.dp)) {
                    Text(q, color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
                }
            }
            if (progress != null && progress.ratio > 0.02) {
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Color.Black.copy(alpha = 0.4f))) {
                    Box(Modifier.fillMaxWidth(progress.ratio.toFloat()).height(3.dp).background(colors.accent))
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(item.title, color = colors.text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (match != null) {
            Text("$match% pertinent", color = colors.accentHover2(), fontSize = 10.sp, maxLines = 1)
        } else {
            val meta = listOfNotNull(item.year?.toString(), if (item.isMovie) null else item.seasonCount?.let { "$it saison${if (it > 1) "s" else ""}" }).joinToString(" · ")
            if (meta.isNotBlank()) Text(meta, color = colors.textFaint, fontSize = 10.sp, maxLines = 1)
        }
    }
}

private const val LAND_W = 260

@Composable
private fun ContinueCard(vm: AppViewModel, item: CatalogItem, progress: ProgressSummary?) {
    val colors = LocalFlixColors.current
    Column(
        Modifier.width(LAND_W.dp).clickable {
            if (progress != null && !progress.watched) vm.play(progress.topType, progress.topId, if (progress.itemType == "episode") progress.itemId else null, (progress.position * 1000).toLong())
            else vm.openDetail(item.type, item.id)
        },
    ) {
        Box(Modifier.width(LAND_W.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(6.dp))) {
            FlixImage(vm.api, item.thumbHash ?: item.backdropHash ?: item.posterHash, width = 480, modifier = Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize().background(colors.surfaceHover))
            }
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.55f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.6f))))
            Box(Modifier.align(Alignment.Center).size(44.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.PlayArrow, null, tint = Color.White, modifier = Modifier.size(26.dp))
            }
            if (progress != null && progress.ratio > 0.02) {
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Color.Black.copy(alpha = 0.4f))) {
                    Box(Modifier.fillMaxWidth(progress.ratio.toFloat()).height(3.dp).background(colors.accent))
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(item.title, color = colors.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

private fun qualityBadgeLabel(height: Int?, hdr: Boolean): String? {
    val res = when {
        height == null -> null
        height >= 2000 -> "4K"
        height >= 1000 -> "HD"
        else -> null
    }
    return when {
        res != null && hdr -> "$res·HDR"
        res != null -> res
        hdr -> "HDR"
        else -> null
    }
}

// Netflix's match-% green reads too close to the accent red — a small local
// tint keeps it legible without adding another named color to FlixColors.
private fun local.flix.client.ui.theme.FlixColors.accentHover2(): Color = Color(0xFF46D369)
