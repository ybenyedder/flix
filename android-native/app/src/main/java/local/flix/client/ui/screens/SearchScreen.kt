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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import local.flix.client.ui.AppViewModel
import local.flix.client.ui.UiState
import local.flix.client.ui.components.FlixImage
import local.flix.client.ui.theme.LocalFlixColors
import local.flix.core.model.CatalogItem

@Composable
fun SearchScreen(vm: AppViewModel, ui: UiState) {
    val colors = LocalFlixColors.current
    Column(Modifier.fillMaxSize().background(colors.background).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.ArrowBack, "Retour", tint = colors.text, modifier = Modifier.size(22.dp).clickable { vm.back() })
            Spacer(Modifier.width(10.dp))
            OutlinedTextField(
                value = ui.searchQuery,
                onValueChange = { vm.search(it) },
                placeholder = { Text("Films, séries…", color = colors.textMuted) },
                leadingIcon = { Icon(Icons.Filled.Search, null, tint = colors.textMuted) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { vm.search(ui.searchQuery) }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = colors.accent, unfocusedBorderColor = colors.border,
                    focusedTextColor = colors.text, unfocusedTextColor = colors.text, cursorColor = colors.accent,
                ),
                modifier = Modifier.weight(1f),
            )
        }
        val results = ui.searchMovies + ui.searchShows
        if (ui.searchQuery.isBlank()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Recherchez un film ou une série", color = colors.textMuted, fontSize = 13.sp)
            }
        } else if (results.isEmpty() && !ui.searching) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Aucun résultat pour « ${ui.searchQuery} »", color = colors.textMuted, fontSize = 13.sp)
            }
        } else {
            LazyVerticalGrid(columns = GridCells.Fixed(3), contentPadding = androidx.compose.foundation.layout.PaddingValues(8.dp)) {
                items(results, key = { it.key }) { item -> SearchResultTile(vm, item) }
            }
        }
    }
}

@Composable
private fun SearchResultTile(vm: AppViewModel, item: CatalogItem) {
    val colors = LocalFlixColors.current
    Column(Modifier.padding(4.dp).clickable { vm.openDetail(item.type, item.id) }) {
        Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).clip(RoundedCornerShape(4.dp))) {
            FlixImage(vm.api, item.posterHash ?: item.backdropHash, width = 480, modifier = Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize().background(colors.surfaceHover), contentAlignment = Alignment.Center) {
                    Text(item.title, color = colors.textMuted, fontSize = 11.sp, maxLines = 3, modifier = Modifier.padding(4.dp))
                }
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(item.title, color = colors.text, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
