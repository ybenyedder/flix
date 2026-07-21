@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package local.flix.tv.ui.screens

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tv
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import local.flix.core.model.CatalogItem
import local.flix.core.model.ProgressSummary
import local.flix.core.model.filterForProfile
import local.flix.tv.ui.TvTab
import local.flix.tv.ui.TvUiState
import local.flix.tv.ui.TvViewModel
import local.flix.tv.ui.components.TvAvatar
import local.flix.tv.ui.components.TvImage
import local.flix.tv.ui.components.metaLine
import local.flix.tv.ui.theme.LocalFlixTvColors

// Netflix-TV layout constants: content clears the collapsed nav rail, the
// rows band owns the bottom of the screen, the pinned hero the top.
private val CONTENT_START = 60.dp
private const val BAND_FRACTION = 0.46f
private const val TILE_W = 196
private const val TILE_H = 110 // 16:9, Netflix landscape boxart

// `id` keys the LazyColumn row — NEVER key on the title: the server only
// guarantees row *ids* are unique, two reco rows can share a title (homonym
// seeds → "Parce que vous avez regardé Dune" twice) and a duplicate LazyColumn
// key crashes the whole home screen.
private data class TvRow(
    val id: String,
    val title: String,
    val items: List<CatalogItem>,
    val continueRow: Boolean = false,
    val topTen: Boolean = false,
)

// --- row builders ------------------------------------------------------------

private fun buildRows(ui: TvUiState): List<TvRow> = when (ui.tab) {
    TvTab.HOME -> buildHomeRows(ui)
    TvTab.SERIES -> buildCatalogRows(ui.visibleShows, "series", "Séries récemment ajoutées")
    TvTab.MOVIES -> buildCatalogRows(ui.visibleMovies, "films", "Films récemment ajoutés")
    TvTab.MY_LIST -> buildMyListRows(ui)
    TvTab.SEARCH -> emptyList() // search renders its own layout, never rows
}

private fun buildHomeRows(ui: TvUiState): List<TvRow> {
    val rows = mutableListOf<TvRow>()
    // Cross-row dedup: a title shown once on the page never reappears in a
    // LATER reco row ("Notre sélection" and "À découvrir" used to overlap).
    // Continuer/Ma liste are user-curated so they keep their full contents,
    // but they seed `seen` so reco rows don't echo them either.
    val seen = mutableSetOf<String>()
    // The server sends progress PER EPISODE (no per-show dedup — the web
    // client keys on the episode id, we key cards on the top-level item key),
    // so two in-flight episodes of one show map to the same CatalogItem:
    // distinctBy keeps the first (most recent) or the LazyRow key crashes.
    val continueItems = ui.userState.progress.filter { it.ratio in 0.02..0.92 }
    if (continueItems.isNotEmpty()) {
        val items = continueItems.mapNotNull { ui.library.byKey["${it.topType}:${it.topId}"] }.distinctBy { it.key }
        if (items.isNotEmpty()) {
            rows.add(TvRow("continue", "Continuer à regarder", items, continueRow = true))
            seen.addAll(items.map { it.key })
        }
    }
    if (ui.userState.myList.isNotEmpty()) {
        val items = ui.userState.myList.mapNotNull { ui.library.byKey[it.key] }.filterForProfile(ui.isKids).distinctBy { it.key }
        if (items.isNotEmpty()) {
            rows.add(TvRow("mylist", "Ma liste", items))
            seen.addAll(items.map { it.key })
        }
    }
    for (row in ui.recommend.rows) {
        // Top 10 is a RANKING — dropping an entry because it already appeared
        // in Ma liste would silently renumber the chart, so it is exempt from
        // the cross-row filter (it still seeds `seen` for later reco rows).
        val topTen = row.id.startsWith("top10")
        val items = row.items.mapNotNull { ui.library.byKey[it.key] }
            .filterForProfile(ui.isKids).distinctBy { it.key }
            .let { list -> if (topTen) list else list.filter { it.key !in seen } }
        if (items.isNotEmpty()) {
            rows.add(TvRow("reco:${row.id}", row.title, items, topTen = topTen))
            seen.addAll(items.map { it.key })
        }
    }
    if (ui.recommend.rows.isEmpty()) {
        if (ui.visibleMovies.isNotEmpty()) rows.add(TvRow("films", "Films", ui.visibleMovies.sortedByDescending { it.addedAt }))
        if (ui.visibleShows.isNotEmpty()) rows.add(TvRow("series", "Séries", ui.visibleShows.sortedByDescending { it.addedAt }))
    }
    return rows
}

/** Netflix Séries/Films pages: a "recently added" row then genre rows (most
 *  common genres first). Deduped page-wide — each title appears in exactly one
 *  row, the leftover tail lands in a final catch-all row so the page still
 *  covers the whole catalogue. */
private fun buildCatalogRows(all: List<CatalogItem>, idPrefix: String, recentTitle: String): List<TvRow> {
    if (all.isEmpty()) return emptyList()
    val rows = mutableListOf<TvRow>()
    val seen = mutableSetOf<String>()
    val recent = all.sortedByDescending { it.addedAt }.take(18)
    rows.add(TvRow("$idPrefix:recent", recentTitle, recent))
    seen.addAll(recent.map { it.key })
    val counts = mutableMapOf<String, Int>()
    for (item in all) for (g in item.genres) counts[g] = (counts[g] ?: 0) + 1
    val topGenres = counts.entries
        .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
        .map { it.key }.take(12)
    for (g in topGenres) {
        val items = all.filter { g in it.genres && it.key !in seen }.sortedByDescending { it.addedAt }.take(24)
        if (items.size >= 3) {
            rows.add(TvRow("$idPrefix:genre:$g", g, items))
            seen.addAll(items.map { it.key })
        }
    }
    val rest = all.filter { it.key !in seen }.sortedBy { it.sortTitle }
    if (rest.isNotEmpty()) rows.add(TvRow("$idPrefix:rest", "Également sur Flix", rest))
    return rows
}

private fun buildMyListRows(ui: TvUiState): List<TvRow> {
    val items = ui.userState.myList.mapNotNull { ui.library.byKey[it.key] }.filterForProfile(ui.isKids).distinctBy { it.key }
    if (items.isEmpty()) return emptyList()
    val rows = mutableListOf<TvRow>()
    val movies = items.filter { it.isMovie }
    val shows = items.filterNot { it.isMovie }
    if (movies.isNotEmpty()) rows.add(TvRow("mylist:movies", "Films de ma liste", movies))
    if (shows.isNotEmpty()) rows.add(TvRow("mylist:shows", "Séries de ma liste", shows))
    return rows
}

private fun defaultBillboard(ui: TvUiState, rows: List<TvRow>): CatalogItem? {
    if (ui.tab == TvTab.HOME) {
        ui.recommend.billboard?.let { ref -> ui.library.byKey[ref.key]?.let { return it } }
    }
    return rows.firstOrNull { !it.continueRow }?.items?.firstOrNull() ?: rows.firstOrNull()?.items?.firstOrNull()
}

private fun emptyTabMessage(tab: TvTab): String = when (tab) {
    TvTab.HOME -> "La bibliothèque est vide. Lancez un scan depuis le serveur."
    TvTab.SERIES -> "Aucune série dans la bibliothèque."
    TvTab.MOVIES -> "Aucun film dans la bibliothèque."
    TvTab.MY_LIST -> "Votre liste est vide. Ajoutez des titres depuis leur fiche."
    TvTab.SEARCH -> "" // unreachable — search has its own layout
}

// The rows band drives ALL scrolling itself (Netflix pivot: the focused row
// pins to the top of the band, the focused card to the left edge). The default
// bring-into-view would fight those animations with a second minimal scroll,
// so it is disabled for every lazy list inside the band.
private val NoBringIntoView = object : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float = 0f
}

// --- screen ------------------------------------------------------------------

@Composable
fun TvHomeScreen(vm: TvViewModel, ui: TvUiState) {
    val colors = LocalFlixTvColors.current
    Box(Modifier.fillMaxSize().background(colors.background)) {
        if (ui.tab == TvTab.SEARCH) TvSearchContent(vm, ui) else TvBrowseContent(vm, ui)
        TvNavRail(ui, ui.tab, onSelect = vm::selectTab)
    }
}

@Composable
private fun TvBrowseContent(vm: TvViewModel, ui: TvUiState) {
    val colors = LocalFlixTvColors.current
    val tab = ui.tab
    val rows = remember(ui.recommend, ui.userState, ui.library, ui.isKids, tab) { buildRows(ui) }
    var focusedItem by remember(tab) { mutableStateOf<CatalogItem?>(null) }
    // The hero art lags the focused card by a debounce: without it, every
    // D-pad step through a row fetches + decodes a full-screen 1440px backdrop
    // (with a fallback-gradient flash on each cache miss) — stuttery on modest
    // TV hardware. collectLatest cancels the pending delay on every new focus,
    // so only a card the user RESTS on becomes the hero.
    var billboardItem by remember(tab) { mutableStateOf<CatalogItem?>(null) }
    LaunchedEffect(tab) {
        snapshotFlow { focusedItem }.collectLatest { item ->
            if (item != null && item !== billboardItem) {
                delay(300)
                billboardItem = item
            }
        }
    }
    val hero = billboardItem ?: remember(rows) { defaultBillboard(ui, rows) }
    val firstCardFocus = remember(tab) { FocusRequester() }
    val listState = remember(tab) { LazyListState() }
    val scope = rememberCoroutineScope()

    Box(Modifier.fillMaxSize().background(colors.background)) {
        // Full-bleed backdrop of the focused title — the whole screen is the
        // billboard, Netflix-style, with scrims carving out the text zone
        // (left) and the rows band (bottom).
        if (hero != null) {
            TvImage(vm.api, hero.backdropHash ?: hero.thumbHash ?: hero.posterHash, width = 1440, modifier = Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(colors.surface, colors.background))))
            }
        }
        Box(
            Modifier.fillMaxSize().background(
                Brush.horizontalGradient(
                    0f to colors.background.copy(alpha = 0.93f),
                    0.30f to colors.background.copy(alpha = 0.55f),
                    0.65f to Color.Transparent,
                ),
            ),
        )
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    0f to Color.Transparent,
                    0.40f to Color.Transparent,
                    0.82f to colors.background.copy(alpha = 0.93f),
                    1f to colors.background,
                ),
            ),
        )

        // Hero info is PINNED (not a scrolling list item): whichever row the
        // focus is on, the focused title's header stays readable top-left —
        // it can never scroll off-screen the way the old billboard row did.
        if (hero != null) {
            HeroInfo(vm, ui, hero, Modifier.align(Alignment.TopStart).padding(start = CONTENT_START, top = 40.dp))
        }

        Text(
            "FLIX",
            color = colors.accent,
            fontSize = 26.sp,
            fontWeight = FontWeight.Black,
            letterSpacing = 3.sp,
            modifier = Modifier.align(Alignment.TopEnd).padding(top = 26.dp, end = 48.dp),
        )

        if (rows.isEmpty()) {
            Text(
                emptyTabMessage(tab),
                color = colors.textMuted,
                fontSize = 17.sp,
                modifier = Modifier.align(Alignment.BottomStart).padding(start = CONTENT_START, bottom = 120.dp),
            )
        } else {
            CompositionLocalProvider(LocalBringIntoViewSpec provides NoBringIntoView) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.align(Alignment.BottomStart).fillMaxWidth().fillMaxHeight(BAND_FRACTION),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                    // Large tail padding so even the LAST row can pivot to the
                    // top of the band instead of sticking to the bottom edge.
                    contentPadding = PaddingValues(bottom = 400.dp),
                ) {
                    itemsIndexed(rows, key = { _, r -> r.id }) { rowIndex, row ->
                        TvContentRow(
                            vm, ui, row,
                            firstFocusRequester = if (rowIndex == 0) firstCardFocus else null,
                            onFocusCard = { item ->
                                focusedItem = item
                                scope.launch { runCatching { listState.animateScrollToItem(rowIndex) } }
                            },
                        )
                    }
                }
            }
        }
    }

    LaunchedEffect(tab, rows.isNotEmpty()) {
        if (rows.isNotEmpty()) runCatching { firstCardFocus.requestFocus() }
    }
}

// --- hero --------------------------------------------------------------------

@Composable
private fun HeroInfo(vm: TvViewModel, ui: TvUiState, item: CatalogItem, modifier: Modifier = Modifier) {
    val colors = LocalFlixTvColors.current
    Column(modifier.fillMaxWidth(0.44f)) {
        // Prefer the title logo artwork when the release ships one — it's the
        // most "cinema" element and matches the poster/backdrop look.
        val logo = item.logoHash
        if (logo != null) {
            TvImage(
                vm.api, logo, width = 960,
                modifier = Modifier.fillMaxWidth(0.78f).height(88.dp),
                contentScale = androidx.compose.ui.layout.ContentScale.Fit,
            ) { HeroTitle(item.title) }
        } else {
            HeroTitle(item.title)
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            val match = ui.recommend.matchScores[item.key]
            if (match != null && match > 0) {
                Text("Recommandé à $match %", color = colors.positive, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            }
            Text(
                metaLine(item).joinToString("  •  "),
                color = colors.textMuted,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        item.synopsis?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, color = colors.textMuted, fontSize = 15.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, lineHeight = 21.sp)
        }
        if (item.genres.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Text(item.genres.take(3).joinToString("  •  "), color = colors.textFaint, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun HeroTitle(title: String) {
    Text(title, color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black, maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 44.sp)
}

// --- rows --------------------------------------------------------------------

@Composable
private fun TvContentRow(
    vm: TvViewModel,
    ui: TvUiState,
    row: TvRow,
    firstFocusRequester: FocusRequester?,
    onFocusCard: (CatalogItem) -> Unit,
) {
    val colors = LocalFlixTvColors.current
    val rowState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    Column {
        Text(
            row.title,
            color = colors.text,
            fontSize = 17.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(start = CONTENT_START, bottom = 2.dp),
        )
        LazyRow(
            state = rowState,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            // Vertical padding gives the 1.12 focus scale room to draw without
            // being clipped by the lazy viewport; the huge end padding lets the
            // LAST card of a row pivot to the left edge like every other card.
            contentPadding = PaddingValues(start = CONTENT_START, end = 760.dp, top = 8.dp, bottom = 8.dp),
        ) {
            itemsIndexed(row.items, key = { _, item -> item.key }) { index, catalogItem ->
                val progress = ui.userState.progress.firstOrNull { "${it.topType}:${it.topId}" == catalogItem.key }
                val focusMod = if (index == 0 && firstFocusRequester != null) Modifier.focusRequester(firstFocusRequester) else Modifier
                val onFocus = {
                    onFocusCard(catalogItem)
                    scope.launch { runCatching { rowState.animateScrollToItem(index) } }
                    Unit
                }
                if (row.topTen) {
                    TvTopTenTile(vm, catalogItem, rank = index + 1, modifier = focusMod, onFocus = onFocus)
                } else {
                    TvTile(vm, catalogItem, progress, row.continueRow, focusMod, onFocus)
                }
            }
        }
    }
}

@Composable
private fun TvTile(
    vm: TvViewModel,
    item: CatalogItem,
    progress: ProgressSummary?,
    isContinue: Boolean,
    modifier: Modifier = Modifier,
    onFocus: () -> Unit,
) {
    val colors = LocalFlixTvColors.current
    var focused by remember { mutableStateOf(false) }
    val titleAlpha by animateFloatAsState(if (focused) 1f else 0.85f, label = "tileTitle")

    Card(
        onClick = {
            if (progress != null && !progress.watched) {
                vm.play(progress.topType, progress.topId, if (progress.itemType == "episode") progress.itemId else null, (progress.position * 1000).toLong())
            } else {
                vm.openDetail(item.type, item.id)
            }
        },
        modifier = modifier.width(TILE_W.dp).onFocusChanged { focused = it.isFocused; if (it.isFocused) onFocus() },
        shape = CardDefaults.shape(shape = RoundedCornerShape(5.dp)),
        border = CardDefaults.border(focusedBorder = Border(BorderStroke(3.dp, Color.White), shape = RoundedCornerShape(5.dp))),
        scale = CardDefaults.scale(focusedScale = 1.12f),
        colors = CardDefaults.colors(containerColor = colors.surface, focusedContainerColor = colors.surface),
    ) {
        Box(Modifier.width(TILE_W.dp).height(TILE_H.dp)) {
            // Landscape boxart, Netflix-style: extracted frame ("thumb") first
            // for movies, backdrop for shows, cropped poster as last resort so
            // a tile is never an empty grey box.
            val art = if (item.isMovie) item.thumbHash ?: item.backdropHash ?: item.posterHash
            else item.backdropHash ?: item.thumbHash ?: item.posterHash
            TvImage(vm.api, art, width = 480, modifier = Modifier.fillMaxSize()) { ArtFallback() }
            // Bottom scrim keeps the overlaid title readable — our artwork has
            // no baked-in title text the way real Netflix boxart does.
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.45f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.82f))))
            if (isContinue) {
                Box(
                    Modifier.align(Alignment.Center).size(40.dp).clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.55f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("▶", color = Color.White, fontSize = 17.sp)
                }
            }
            if (isNew(item) && progress == null) {
                Box(
                    Modifier.align(Alignment.TopStart).padding(6.dp).clip(RoundedCornerShape(3.dp)).background(colors.accent)
                        .padding(horizontal = 5.dp, vertical = 2.dp),
                ) {
                    Text("NOUVEAU", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Black)
                }
            }
            Text(
                item.title,
                color = Color.White,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.align(Alignment.BottomStart)
                    .padding(start = 8.dp, end = 8.dp, bottom = if (progress != null && progress.ratio > 0.02) 9.dp else 6.dp)
                    .alpha(titleAlpha),
            )
            if (progress != null && progress.ratio > 0.02) {
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(4.dp).background(Color.White.copy(alpha = 0.25f))) {
                    Box(Modifier.fillMaxWidth(progress.ratio.toFloat()).height(4.dp).background(colors.accent))
                }
            }
        }
    }
}

/** Netflix's iconic Top 10 tile: a huge chart numeral (dark fill + light
 *  stroke) with the 2:3 poster overlapping its right edge. The numeral is NOT
 *  focusable decoration — only the poster card takes focus, like Netflix. */
@Composable
private fun TvTopTenTile(
    vm: TvViewModel,
    item: CatalogItem,
    rank: Int,
    modifier: Modifier = Modifier,
    onFocus: () -> Unit,
) {
    val colors = LocalFlixTvColors.current
    val numeralStyle = TextStyle(
        fontSize = 100.sp,
        fontWeight = FontWeight.Black,
        letterSpacing = (-8).sp, // squeezes "10" the way Netflix does
        lineHeight = 100.sp,
    )
    Box(Modifier.width(158.dp).height(126.dp)) {
        Text("$rank", style = numeralStyle.copy(color = Color(0xFF1B1B22)), modifier = Modifier.align(Alignment.BottomStart))
        Text(
            "$rank",
            style = numeralStyle.copy(color = Color.White.copy(alpha = 0.40f), drawStyle = Stroke(width = 3f)),
            modifier = Modifier.align(Alignment.BottomStart),
        )
        Card(
            onClick = { vm.openDetail(item.type, item.id) },
            modifier = modifier.align(Alignment.CenterEnd).width(82.dp).onFocusChanged { if (it.isFocused) onFocus() },
            shape = CardDefaults.shape(shape = RoundedCornerShape(4.dp)),
            border = CardDefaults.border(focusedBorder = Border(BorderStroke(3.dp, Color.White), shape = RoundedCornerShape(4.dp))),
            scale = CardDefaults.scale(focusedScale = 1.1f),
            colors = CardDefaults.colors(containerColor = colors.surface, focusedContainerColor = colors.surface),
        ) {
            Box(Modifier.width(82.dp).height(123.dp)) {
                TvImage(vm.api, item.posterHash ?: item.backdropHash ?: item.thumbHash, width = 480, modifier = Modifier.fillMaxSize()) {
                    ArtFallback(item.title)
                }
            }
        }
    }
}

@Composable
private fun ArtFallback(title: String? = null) {
    val colors = LocalFlixTvColors.current
    Box(
        Modifier.fillMaxSize().background(Brush.linearGradient(listOf(colors.surfaceFocused, colors.surface))),
        contentAlignment = Alignment.Center,
    ) {
        if (title != null) {
            Text(
                title,
                color = colors.textMuted,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(6.dp),
            )
        }
    }
}

// --- nav rail ----------------------------------------------------------------

private val RAIL_COLLAPSED = 60.dp
private val RAIL_EXPANDED = 232.dp

/** Netflix TV left navigation: a thin icon rail that expands with labels (and
 *  dims the content behind a scrim) as soon as focus enters it — D-pad LEFT
 *  from the first card of any row lands here. */
@Composable
private fun TvNavRail(ui: TvUiState, selected: TvTab, onSelect: (TvTab) -> Unit) {
    val colors = LocalFlixTvColors.current
    var expanded by remember { mutableStateOf(false) }
    val width by animateDpAsState(if (expanded) RAIL_EXPANDED else RAIL_COLLAPSED, tween(180), label = "railWidth")
    val scrimAlpha by animateFloatAsState(if (expanded) 1f else 0f, tween(180), label = "railScrim")

    Box(Modifier.fillMaxSize()) {
        // Full-screen dim so the expanded menu floats over the content — drawn
        // only while expanded (alpha 0 otherwise), never focusable.
        Box(
            Modifier.fillMaxSize().alpha(scrimAlpha).background(
                Brush.horizontalGradient(
                    0f to Color.Black.copy(alpha = 0.92f),
                    0.4f to Color.Black.copy(alpha = 0.65f),
                    1f to Color.Black.copy(alpha = 0.25f),
                ),
            ),
        )
        Column(
            Modifier
                .fillMaxHeight()
                .width(width)
                .background(
                    Brush.horizontalGradient(
                        0f to colors.background.copy(alpha = if (expanded) 0f else 0.72f),
                        1f to Color.Transparent,
                    ),
                )
                .onFocusChanged { expanded = it.hasFocus }
                .focusGroup()
                .padding(start = 12.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Row(Modifier.padding(start = 6.dp, bottom = 22.dp), verticalAlignment = Alignment.CenterVertically) {
                TvAvatar(ui.avatar, ui.username ?: "?", 30)
                if (expanded) {
                    Text(
                        ui.username ?: "",
                        color = colors.text,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 12.dp),
                    )
                }
            }
            NavRailItem(Icons.Filled.Search, "Rechercher", selected == TvTab.SEARCH, expanded) { onSelect(TvTab.SEARCH) }
            NavRailItem(Icons.Filled.Home, "Accueil", selected == TvTab.HOME, expanded) { onSelect(TvTab.HOME) }
            NavRailItem(Icons.Filled.Tv, "Séries", selected == TvTab.SERIES, expanded) { onSelect(TvTab.SERIES) }
            NavRailItem(Icons.Filled.Movie, "Films", selected == TvTab.MOVIES, expanded) { onSelect(TvTab.MOVIES) }
            NavRailItem(Icons.Filled.Add, "Ma liste", selected == TvTab.MY_LIST, expanded) { onSelect(TvTab.MY_LIST) }
        }
    }
}

@Composable
private fun NavRailItem(icon: ImageVector, label: String, selected: Boolean, expanded: Boolean, onClick: () -> Unit) {
    val colors = LocalFlixTvColors.current
    var focused by remember { mutableStateOf(false) }
    val tint = when {
        focused -> Color.White
        selected -> Color.White
        else -> colors.textFaint
    }
    Surface(
        onClick = onClick,
        modifier = Modifier.padding(vertical = 3.dp).onFocusChanged { focused = it.isFocused },
        colors = ClickableSurfaceDefaults.colors(containerColor = Color.Transparent, focusedContainerColor = Color.White.copy(alpha = 0.14f)),
        shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(8.dp)),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
    ) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(22.dp))
            if (expanded) {
                Text(
                    label,
                    color = tint,
                    fontSize = 16.sp,
                    fontWeight = if (selected || focused) FontWeight.Bold else FontWeight.SemiBold,
                    maxLines = 1,
                    modifier = Modifier.padding(start = 14.dp),
                )
            }
        }
    }
}

// Recent addition (~14 days). currentTimeMillis is fine at app runtime.
private fun isNew(item: CatalogItem): Boolean = item.addedAt > 0 && System.currentTimeMillis() - item.addedAt < 14L * 24 * 60 * 60 * 1000
