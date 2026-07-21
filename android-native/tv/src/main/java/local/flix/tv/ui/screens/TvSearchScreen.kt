package local.flix.tv.ui.screens

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
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
import java.text.Normalizer
import local.flix.core.model.CatalogItem
import local.flix.tv.ui.TvUiState
import local.flix.tv.ui.TvViewModel
import local.flix.tv.ui.components.TvImage
import local.flix.tv.ui.theme.LocalFlixTvColors

// Netflix-TV search: a D-pad letter grid on the left, an instant results grid
// on the right. Results are computed CLIENT-SIDE against the in-memory library
// snapshot — every keypress filters instantly, no server round-trip, no system
// IME popup (which D-pad remotes handle badly).

private val KEY_ROWS = listOf("abcdef", "ghijkl", "mnopqr", "stuvwx", "yz1234", "567890")

private val DIACRITICS = Regex("\\p{Mn}+")

private fun normalize(s: String): String = DIACRITICS.replace(Normalizer.normalize(s.lowercase(), Normalizer.Form.NFD), "")

/** Ranked instant search over the visible catalogue: title prefix beats
 *  in-title word prefix beats substring beats genre beats actor. Blank query
 *  falls back to recent additions (Netflix's "popular searches" slot). */
internal fun searchCatalog(movies: List<CatalogItem>, shows: List<CatalogItem>, query: String): List<CatalogItem> {
    val q = normalize(query.trim())
    val all = movies + shows
    if (q.isEmpty()) return all.sortedByDescending { it.addedAt }.take(24)
    data class Hit(val item: CatalogItem, val score: Int)
    val hits = all.mapNotNull { item ->
        val title = normalize(item.title)
        val original = item.originalTitle?.let { normalize(it) }
        val score = when {
            title.startsWith(q) || original?.startsWith(q) == true -> 0
            title.split(' ').any { it.startsWith(q) } -> 1
            title.contains(q) || original?.contains(q) == true -> 2
            item.genres.any { normalize(it).startsWith(q) } -> 3
            item.actors.any { normalize(it.name).contains(q) } -> 4
            else -> return@mapNotNull null
        }
        Hit(item, score)
    }
    return hits.sortedWith(compareBy({ it.score }, { it.item.sortTitle })).map { it.item }.take(40)
}

@Composable
internal fun TvSearchContent(vm: TvViewModel, ui: TvUiState) {
    val colors = LocalFlixTvColors.current
    var query by remember { mutableStateOf("") }
    val results = remember(query, ui.library, ui.isKids) { searchCatalog(ui.visibleMovies, ui.visibleShows, query) }
    val firstKeyFocus = remember { FocusRequester() }

    Box(Modifier.fillMaxSize()) {
        Text(
            "FLIX",
            color = colors.accent,
            fontSize = 26.sp,
            fontWeight = FontWeight.Black,
            letterSpacing = 3.sp,
            modifier = Modifier.align(Alignment.TopEnd).padding(top = 26.dp, end = 48.dp),
        )
        Row(Modifier.fillMaxSize().padding(start = 84.dp, top = 64.dp, end = 48.dp)) {
            Column(Modifier.width(226.dp)) {
                Text(
                    if (query.isEmpty()) "Titres, genres, acteurs" else query,
                    color = if (query.isEmpty()) colors.textFaint else colors.text,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(8.dp))
                Box(Modifier.fillMaxWidth().height(2.dp).background(colors.chipBorder))
                Spacer(Modifier.height(18.dp))
                KEY_ROWS.forEachIndexed { rowIndex, keys ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        keys.forEachIndexed { keyIndex, c ->
                            val mod = if (rowIndex == 0 && keyIndex == 0) Modifier.focusRequester(firstKeyFocus) else Modifier
                            SearchKey(c.uppercase(), mod) { query += c }
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    SearchKey("ESPACE", Modifier.width(148.dp)) { if (query.isNotEmpty()) query += " " }
                    SearchKey("⌫", Modifier.width(72.dp)) { query = query.dropLast(1) }
                }
            }
            Spacer(Modifier.width(30.dp))
            Column(Modifier.fillMaxSize()) {
                Text(
                    when {
                        query.isEmpty() -> "Ajouts récents"
                        results.isEmpty() -> "Aucun résultat pour « $query »"
                        else -> "Résultats"
                    },
                    color = colors.text,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(12.dp))
                LazyVerticalGrid(
                    columns = GridCells.Fixed(3),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    contentPadding = PaddingValues(bottom = 48.dp, top = 4.dp),
                ) {
                    items(results, key = { it.key }) { item -> SearchResultCard(vm, item) }
                }
            }
        }
    }

    LaunchedEffect(Unit) { runCatching { firstKeyFocus.requestFocus() } }
}

@Composable
private fun SearchKey(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = LocalFlixTvColors.current
    Surface(
        onClick = onClick,
        // For wide keys the caller passes an explicit width(); size() here only
        // fills in whatever dimension is still unconstrained (32×32 for letters).
        modifier = modifier.size(32.dp),
        colors = ClickableSurfaceDefaults.colors(containerColor = Color.Transparent, focusedContainerColor = colors.text),
        shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(4.dp)),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.1f),
    ) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                label,
                color = colors.textMuted,
                fontSize = if (label.length > 1) 11.sp else 15.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun SearchResultCard(vm: TvViewModel, item: CatalogItem) {
    val colors = LocalFlixTvColors.current
    Card(
        onClick = { vm.openDetail(item.type, item.id) },
        modifier = Modifier.fillMaxWidth(),
        shape = CardDefaults.shape(shape = RoundedCornerShape(5.dp)),
        border = CardDefaults.border(focusedBorder = Border(BorderStroke(3.dp, Color.White), shape = RoundedCornerShape(5.dp))),
        scale = CardDefaults.scale(focusedScale = 1.06f),
        colors = CardDefaults.colors(containerColor = colors.surface, focusedContainerColor = colors.surface),
    ) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f)) {
            val art = if (item.isMovie) item.thumbHash ?: item.backdropHash ?: item.posterHash
            else item.backdropHash ?: item.thumbHash ?: item.posterHash
            TvImage(vm.api, art, width = 480, modifier = Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(colors.surfaceFocused, colors.surface))))
            }
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.45f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.82f))))
            Text(
                item.title,
                color = Color.White,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.align(Alignment.BottomStart).padding(start = 8.dp, end = 8.dp, bottom = 6.dp),
            )
        }
    }
}
