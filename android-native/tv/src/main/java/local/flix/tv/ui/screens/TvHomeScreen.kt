package local.flix.tv.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import local.flix.core.model.CatalogItem
import local.flix.core.model.ProgressSummary
import local.flix.core.model.filterForProfile
import local.flix.tv.ui.TvViewModel
import local.flix.tv.ui.TvUiState
import local.flix.tv.ui.components.TvImage
import local.flix.tv.ui.theme.LocalFlixTvColors

private data class TvRow(val title: String, val items: List<CatalogItem>)

private fun buildRows(ui: TvUiState): List<TvRow> {
    val rows = mutableListOf<TvRow>()
    val continueItems = ui.userState.progress.filter { it.ratio in 0.02..0.92 }
    if (continueItems.isNotEmpty()) {
        rows.add(TvRow("Continuer à regarder", continueItems.mapNotNull { ui.library.byKey["${it.topType}:${it.topId}"] }))
    }
    if (ui.userState.myList.isNotEmpty()) {
        val items = ui.userState.myList.mapNotNull { ui.library.byKey[it.key] }.filterForProfile(ui.isKids)
        if (items.isNotEmpty()) rows.add(TvRow("Ma liste", items))
    }
    for (row in ui.recommend.rows) {
        val items = row.items.mapNotNull { ui.library.byKey[it.key] }.filterForProfile(ui.isKids)
        if (items.isNotEmpty()) rows.add(TvRow(row.title, items))
    }
    if (ui.recommend.rows.isEmpty()) {
        if (ui.visibleMovies.isNotEmpty()) rows.add(TvRow("Films", ui.visibleMovies.sortedByDescending { it.addedAt }))
        if (ui.visibleShows.isNotEmpty()) rows.add(TvRow("Séries", ui.visibleShows.sortedByDescending { it.addedAt }))
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
    val firstCardFocus = remember { FocusRequester() }

    Box(Modifier.fillMaxSize().background(colors.background)) {
        (focusedItem ?: pickBillboard(ui))?.let { hero -> TvBillboard(vm, hero) }

        Column(Modifier.fillMaxSize()) {
            Spacer(Modifier.weight(1f))
            LazyColumn(Modifier.fillMaxWidth().height(340.dp), contentPadding = PaddingValues(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                itemsIndexed(rows) { rowIndex, row ->
                    TvContentRow(
                        vm, ui, row.title, row.items,
                        firstFocusRequester = if (rowIndex == 0) firstCardFocus else null,
                        onFocusItem = { focusedItem = it },
                    )
                }
            }
        }
    }

    LaunchedEffect(Unit) {
        runCatching { firstCardFocus.requestFocus() }
    }
}

@Composable
private fun TvBillboard(vm: TvViewModel, item: CatalogItem) {
    Box(Modifier.fillMaxWidth().height(560.dp)) {
        TvImage(vm.api, item.backdropHash ?: item.posterHash, width = 1440, modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().background(Color(0xFF1F1F1F)))
        }
        Box(
            Modifier.fillMaxSize().background(
                Brush.horizontalGradient(0f to Color(0xFF141414), 0.35f to Color(0xFF141414).copy(alpha = 0.6f), 0.7f to Color.Transparent),
            ),
        )
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Color.Transparent, 0.6f to Color.Transparent, 1f to Color(0xFF141414))))
        Column(Modifier.align(Alignment.BottomStart).padding(48.dp).width(600.dp)) {
            Text(item.title, color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(10.dp))
            item.synopsis?.let { Text(it, color = Color.White.copy(alpha = 0.85f), fontSize = 16.sp, maxLines = 3, overflow = TextOverflow.Ellipsis) }
        }
    }
}

@Composable
private fun TvContentRow(
    vm: TvViewModel,
    ui: TvUiState,
    title: String,
    items: List<CatalogItem>,
    firstFocusRequester: FocusRequester?,
    onFocusItem: (CatalogItem) -> Unit,
) {
    val colors = LocalFlixTvColors.current
    Column {
        Text(title, color = colors.text, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 48.dp, bottom = 8.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(horizontal = 48.dp)) {
            items(items, key = { it.key }) { catalogItem ->
                val progress = ui.userState.progress.firstOrNull { "${it.topType}:${it.topId}" == catalogItem.key }
                val isFirst = items.indexOf(catalogItem) == 0
                TvMediaCard(
                    vm, ui, catalogItem, progress,
                    modifier = if (isFirst && firstFocusRequester != null) Modifier.focusRequester(firstFocusRequester) else Modifier,
                    onFocus = { onFocusItem(catalogItem) },
                )
            }
        }
    }
}

@Composable
private fun TvMediaCard(vm: TvViewModel, ui: TvUiState, item: CatalogItem, progress: ProgressSummary?, modifier: Modifier = Modifier, onFocus: () -> Unit) {
    val colors = LocalFlixTvColors.current
    Card(
        onClick = {
            if (progress != null) vm.play(progress.topType, progress.topId, if (progress.itemType == "episode") progress.itemId else null, (progress.position * 1000).toLong())
            else vm.openDetail(item.type, item.id)
        },
        modifier = modifier.width(220.dp).onFocusEvent { if (it) onFocus() },
        shape = CardDefaults.shape(shape = RoundedCornerShape(4.dp)),
        border = CardDefaults.border(focusedBorder = Border(androidx.compose.foundation.BorderStroke(3.dp, Color.White), shape = RoundedCornerShape(4.dp))),
        scale = CardDefaults.scale(focusedScale = 1.08f),
    ) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f)) {
            TvImage(vm.api, item.backdropHash ?: item.posterHash, width = 480, modifier = Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize().background(colors.surfaceFocused), contentAlignment = Alignment.Center) {
                    Text(item.title, color = colors.textMuted, fontSize = 12.sp, maxLines = 2, modifier = Modifier.padding(6.dp))
                }
            }
            if (progress != null && progress.ratio > 0.02) {
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(4.dp).background(Color.White.copy(alpha = 0.3f))) {
                    Box(Modifier.fillMaxWidth(progress.ratio.toFloat()).height(4.dp).background(colors.accent))
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(8.dp)) {
            Text(item.title, color = colors.text, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

private fun Modifier.onFocusEvent(onChanged: (Boolean) -> Unit): Modifier =
    this.onFocusChanged { onChanged(it.isFocused) }
