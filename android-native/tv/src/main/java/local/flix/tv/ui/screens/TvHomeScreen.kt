package local.flix.tv.ui.screens

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import local.flix.core.model.CatalogItem
import local.flix.core.model.ProgressSummary
import local.flix.core.model.filterForProfile
import local.flix.tv.ui.TvViewModel
import local.flix.tv.ui.TvUiState
import local.flix.tv.ui.components.MetaChip
import local.flix.tv.ui.components.TvAvatar
import local.flix.tv.ui.components.TvImage
import local.flix.tv.ui.components.metaLine
import local.flix.tv.ui.components.qualityLabel
import local.flix.tv.ui.theme.LocalFlixTvColors

private const val OVERSCAN = 48

// `id` keys the LazyColumn row — NEVER key on the title: the server only
// guarantees row *ids* are unique, two reco rows can share a title (homonym
// seeds → "Parce que vous avez regardé Dune" twice) and a duplicate LazyColumn
// key crashes the whole home screen.
private data class TvRow(val id: String, val title: String, val items: List<CatalogItem>, val continueRow: Boolean = false)

private fun buildRows(ui: TvUiState): List<TvRow> {
    val rows = mutableListOf<TvRow>()
    // The server sends progress PER EPISODE (no per-show dedup — the web
    // client keys on the episode id, we key cards on the top-level item key),
    // so two in-flight episodes of one show map to the same CatalogItem:
    // distinctBy keeps the first (most recent) or the LazyRow key crashes.
    val continueItems = ui.userState.progress.filter { it.ratio in 0.02..0.92 }
    if (continueItems.isNotEmpty()) {
        val items = continueItems.mapNotNull { ui.library.byKey["${it.topType}:${it.topId}"] }.distinctBy { it.key }
        if (items.isNotEmpty()) rows.add(TvRow("continue", "Continuer à regarder", items, continueRow = true))
    }
    if (ui.userState.myList.isNotEmpty()) {
        val items = ui.userState.myList.mapNotNull { ui.library.byKey[it.key] }.filterForProfile(ui.isKids).distinctBy { it.key }
        if (items.isNotEmpty()) rows.add(TvRow("mylist", "Ma liste", items))
    }
    for (row in ui.recommend.rows) {
        val items = row.items.mapNotNull { ui.library.byKey[it.key] }.filterForProfile(ui.isKids).distinctBy { it.key }
        if (items.isNotEmpty()) rows.add(TvRow("reco:${row.id}", row.title, items))
    }
    if (ui.recommend.rows.isEmpty()) {
        if (ui.visibleMovies.isNotEmpty()) rows.add(TvRow("films", "Films", ui.visibleMovies.sortedByDescending { it.addedAt }))
        if (ui.visibleShows.isNotEmpty()) rows.add(TvRow("series", "Séries", ui.visibleShows.sortedByDescending { it.addedAt }))
    }
    return rows
}

private fun pickBillboard(ui: TvUiState): CatalogItem? {
    ui.recommend.billboard?.let { ref -> ui.library.byKey[ref.key]?.let { return it } }
    return (ui.visibleMovies + ui.visibleShows).maxByOrNull { it.addedAt }
}

@Composable
fun TvHomeScreen(vm: TvViewModel, ui: TvUiState) {
    val colors = LocalFlixTvColors.current
    val rows = remember(ui.recommend, ui.userState, ui.library) { buildRows(ui) }
    var focusedItem by remember { mutableStateOf(pickBillboard(ui)) }
    // The billboard art lags the focused card by a debounce: without it, every
    // D-pad step through a row fetches + decodes a full-screen 1440px backdrop
    // (with a fallback-gradient flash on each cache miss) — stuttery on modest
    // TV hardware. collectLatest cancels the pending delay on every new focus,
    // so only a card the user RESTS on becomes the hero.
    var billboardItem by remember { mutableStateOf(focusedItem) }
    LaunchedEffect(Unit) {
        snapshotFlow { focusedItem }.collectLatest { item ->
            if (item !== billboardItem) {
                delay(300)
                billboardItem = item
            }
        }
    }
    val firstCardFocus = remember { FocusRequester() }

    Box(Modifier.fillMaxSize().background(colors.background)) {
        val hero = billboardItem ?: pickBillboard(ui)

        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = OVERSCAN.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            item(key = "hero") {
                if (hero != null) {
                    TvBillboard(vm, hero, Modifier.fillParentMaxHeight(0.64f))
                } else {
                    Spacer(Modifier.height(120.dp))
                }
            }
            itemsIndexed(rows, key = { _, r -> r.id }) { rowIndex, row ->
                TvContentRow(
                    vm, ui, row,
                    firstFocusRequester = if (rowIndex == 0) firstCardFocus else null,
                    onFocusItem = { focusedItem = it },
                )
            }
        }

        TvTopBar(ui)
    }

    LaunchedEffect(rows.isNotEmpty()) {
        if (rows.isNotEmpty()) runCatching { firstCardFocus.requestFocus() }
    }
}

// --- top bar ----------------------------------------------------------------

@Composable
private fun TvTopBar(ui: TvUiState) {
    val colors = LocalFlixTvColors.current
    Box(
        Modifier
            .fillMaxWidth()
            .height(96.dp)
            .background(Brush.verticalGradient(0f to colors.background.copy(alpha = 0.85f), 1f to Color.Transparent)),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = OVERSCAN.dp, vertical = 22.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("FLIX", color = colors.accent, fontSize = 30.sp, fontWeight = FontWeight.Black)
            Spacer(Modifier.weight(1f))
            ui.username?.let { name ->
                Text(name, color = colors.textMuted, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(end = 12.dp))
            }
            TvAvatar(ui.avatar, ui.username ?: "?", 40)
        }
    }
}

// --- billboard --------------------------------------------------------------

@Composable
private fun TvBillboard(vm: TvViewModel, item: CatalogItem, modifier: Modifier = Modifier) {
    val colors = LocalFlixTvColors.current
    Box(modifier.fillMaxWidth()) {
        TvImage(vm.api, item.backdropHash ?: item.posterHash ?: item.thumbHash, width = 1440, modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(colors.surface, colors.background))))
        }
        // Left-to-right scrim keeps the text column legible over bright art…
        Box(
            Modifier.fillMaxSize().background(
                Brush.horizontalGradient(0f to colors.background, 0.30f to colors.background.copy(alpha = 0.75f), 0.75f to Color.Transparent),
            ),
        )
        // …and a bottom scrim melts the artwork into the rows band below.
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(0f to Color.Transparent, 0.55f to Color.Transparent, 1f to colors.background),
            ),
        )
        Column(Modifier.align(Alignment.BottomStart).padding(start = OVERSCAN.dp, end = OVERSCAN.dp, bottom = 20.dp).fillMaxWidth(0.6f)) {
            // Prefer the title logo artwork when the release ships one — it's the
            // most "cinema" element and matches the poster/backdrop look.
            val logo = item.logoHash
            if (logo != null) {
                TvImage(
                    vm.api, logo, width = 960,
                    modifier = Modifier.fillMaxWidth(0.7f).height(96.dp),
                    contentScale = androidx.compose.ui.layout.ContentScale.Fit,
                ) { TvBillboardTitle(item.title) }
            } else {
                TvBillboardTitle(item.title)
            }
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                metaLine(item).forEach { MetaChip(it) }
            }
            item.synopsis?.let {
                Spacer(Modifier.height(14.dp))
                Text(it, color = colors.textMuted, fontSize = 16.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 22.sp)
            }
            if (item.genres.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Text(item.genres.take(3).joinToString("  •  "), color = colors.textFaint, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun TvBillboardTitle(title: String) {
    Text(title, color = Color.White, fontSize = 46.sp, fontWeight = FontWeight.Black, maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 50.sp)
}

// --- rows -------------------------------------------------------------------

@Composable
private fun TvContentRow(
    vm: TvViewModel,
    ui: TvUiState,
    row: TvRow,
    firstFocusRequester: FocusRequester?,
    onFocusItem: (CatalogItem) -> Unit,
) {
    val colors = LocalFlixTvColors.current
    Column {
        Text(
            row.title,
            color = colors.text,
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(start = OVERSCAN.dp, bottom = 10.dp),
        )
        LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp), contentPadding = PaddingValues(horizontal = OVERSCAN.dp)) {
            items(row.items, key = { it.key }) { catalogItem ->
                val progress = ui.userState.progress.firstOrNull { "${it.topType}:${it.topId}" == catalogItem.key }
                val isFirst = catalogItem === row.items.first()
                val focusMod = if (isFirst && firstFocusRequester != null) Modifier.focusRequester(firstFocusRequester) else Modifier
                if (row.continueRow) {
                    TvContinueCard(vm, catalogItem, progress, focusMod) { onFocusItem(catalogItem) }
                } else {
                    TvPosterCard(vm, catalogItem, progress, focusMod) { onFocusItem(catalogItem) }
                }
            }
        }
    }
}

private const val POSTER_W = 132
private const val POSTER_H = 198 // 2:3

@Composable
private fun TvPosterCard(vm: TvViewModel, item: CatalogItem, progress: ProgressSummary?, modifier: Modifier = Modifier, onFocus: () -> Unit) {
    val colors = LocalFlixTvColors.current
    var focused by remember { mutableStateOf(false) }
    val captionAlpha by animateFloatAsState(if (focused) 1f else 0.7f, label = "caption")

    Card(
        onClick = {
            if (progress != null && !progress.watched) {
                vm.play(progress.topType, progress.topId, if (progress.itemType == "episode") progress.itemId else null, (progress.position * 1000).toLong())
            } else {
                vm.openDetail(item.type, item.id)
            }
        },
        modifier = modifier.width(POSTER_W.dp).onFocusChanged { focused = it.isFocused; if (it.isFocused) onFocus() },
        shape = CardDefaults.shape(shape = RoundedCornerShape(8.dp)),
        border = CardDefaults.border(focusedBorder = Border(BorderStroke(3.dp, Color.White), shape = RoundedCornerShape(8.dp))),
        scale = CardDefaults.scale(focusedScale = 1.09f),
        colors = CardDefaults.colors(containerColor = colors.surface, focusedContainerColor = colors.surface),
    ) {
        Column {
            Box(Modifier.width(POSTER_W.dp).height(POSTER_H.dp)) {
                // Prefer the real 2:3 poster ("cover"); fall back to a cropped
                // backdrop/thumb, and finally to a branded gradient carrying the
                // title so a card is never an empty grey box.
                TvImage(vm.api, item.posterHash ?: item.backdropHash ?: item.thumbHash, width = 480, modifier = Modifier.fillMaxSize()) {
                    ArtFallback(item.title)
                }
                qualityLabel(item.qualityHeight, item.qualityHdr)?.let { q ->
                    Box(Modifier.align(Alignment.TopEnd).padding(6.dp).clip(RoundedCornerShape(4.dp)).background(Color.Black.copy(alpha = 0.65f)).padding(horizontal = 6.dp, vertical = 2.dp)) {
                        Text(q, color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                    }
                }
                if (isNew(item)) {
                    Box(Modifier.align(Alignment.TopStart).padding(6.dp).clip(RoundedCornerShape(4.dp)).background(colors.accent).padding(horizontal = 6.dp, vertical = 2.dp)) {
                        Text("NOUVEAU", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Black)
                    }
                }
                if (progress != null && progress.ratio > 0.02) {
                    Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(4.dp).background(Color.Black.copy(alpha = 0.4f))) {
                        Box(Modifier.fillMaxWidth(progress.ratio.toFloat()).height(4.dp).background(colors.accent))
                    }
                }
            }
            Column(Modifier.width(POSTER_W.dp).padding(horizontal = 4.dp, vertical = 6.dp).alpha(captionAlpha)) {
                Text(item.title, color = colors.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(metaLine(item).take(2).joinToString(" · "), color = colors.textFaint, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

private const val LAND_W = 268
private const val LAND_H = 151 // 16:9

@Composable
private fun TvContinueCard(vm: TvViewModel, item: CatalogItem, progress: ProgressSummary?, modifier: Modifier = Modifier, onFocus: () -> Unit) {
    val colors = LocalFlixTvColors.current
    Card(
        onClick = {
            if (progress != null && !progress.watched) {
                vm.play(progress.topType, progress.topId, if (progress.itemType == "episode") progress.itemId else null, (progress.position * 1000).toLong())
            } else {
                vm.openDetail(item.type, item.id)
            }
        },
        modifier = modifier.width(LAND_W.dp).onFocusChanged { if (it.isFocused) onFocus() },
        shape = CardDefaults.shape(shape = RoundedCornerShape(8.dp)),
        border = CardDefaults.border(focusedBorder = Border(BorderStroke(3.dp, Color.White), shape = RoundedCornerShape(8.dp))),
        scale = CardDefaults.scale(focusedScale = 1.07f),
        colors = CardDefaults.colors(containerColor = colors.surface, focusedContainerColor = colors.surface),
    ) {
        Column {
            Box(Modifier.width(LAND_W.dp).height(LAND_H.dp)) {
                TvImage(vm.api, item.thumbHash ?: item.backdropHash ?: item.posterHash, width = 480, modifier = Modifier.fillMaxSize()) {
                    ArtFallback(item.title)
                }
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.5f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.7f))))
                Box(Modifier.align(Alignment.Center).size(46.dp).clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                    Text("▶", color = Color.White, fontSize = 20.sp)
                }
                if (progress != null && progress.ratio > 0.02) {
                    Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(4.dp).background(Color.Black.copy(alpha = 0.4f))) {
                        Box(Modifier.fillMaxWidth(progress.ratio.toFloat()).height(4.dp).background(colors.accent))
                    }
                }
            }
            Column(Modifier.width(LAND_W.dp).padding(horizontal = 10.dp, vertical = 8.dp)) {
                Text(item.title, color = colors.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Reprendre la lecture", color = colors.textFaint, fontSize = 11.sp)
            }
        }
    }
}

@Composable
private fun ArtFallback(title: String) {
    val colors = LocalFlixTvColors.current
    Box(
        Modifier.fillMaxSize().background(Brush.linearGradient(listOf(colors.surfaceFocused, colors.surface))),
        contentAlignment = Alignment.Center,
    ) {
        Text(title, color = colors.textMuted, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(10.dp))
    }
}

// Recent addition (~14 days). currentTimeMillis is fine at app runtime.
private fun isNew(item: CatalogItem): Boolean = item.addedAt > 0 && System.currentTimeMillis() - item.addedAt < 14L * 24 * 60 * 60 * 1000
