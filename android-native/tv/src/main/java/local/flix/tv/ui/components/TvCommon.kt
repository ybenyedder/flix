package local.flix.tv.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import local.flix.core.image.NetworkImage
import local.flix.core.model.CatalogItem
import local.flix.core.net.FlixApi
import local.flix.tv.ui.theme.LocalFlixTvColors

@Composable
fun TvImage(
    api: FlixApi,
    hash: String?,
    width: Int? = null,
    modifier: Modifier = Modifier,
    contentScale: androidx.compose.ui.layout.ContentScale = androidx.compose.ui.layout.ContentScale.Crop,
    fadeInMs: Int = 0,
    fallback: @Composable () -> Unit = {},
) {
    NetworkImage(url = api.imageUrl(hash, width), client = api.client, modifier = modifier, contentScale = contentScale, fadeInMs = fadeInMs, fallback = fallback)
}

// --- metadata rendering -----------------------------------------------------

/** A small pill (year, rating, runtime, genre…) laid over artwork or on a
 *  detail panel. Deliberately low-contrast so a ROW of them doesn't fight the
 *  title. */
@Composable
fun MetaChip(text: String, emphasized: Boolean = false) {
    val colors = LocalFlixTvColors.current
    Box(
        Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(if (emphasized) colors.accent else colors.chip)
            .border(1.dp, if (emphasized) Color.Transparent else colors.chipBorder, RoundedCornerShape(4.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(text, color = if (emphasized) Color.White else colors.textMuted, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** Quality label from the stored max height + HDR flag (4K / 1080p / HDR). */
fun qualityLabel(height: Int?, hdr: Boolean): String? {
    val res = when {
        height == null -> null
        height >= 2000 -> "4K"
        height >= 1400 -> "1440p"
        height >= 1000 -> "1080p"
        height >= 700 -> "720p"
        else -> "SD"
    }
    return when {
        res != null && hdr -> "$res · HDR"
        res != null -> res
        hdr -> "HDR"
        else -> null
    }
}

/** "2 h 14" / "48 min" from a runtime in seconds (movies only). */
fun formatRuntime(seconds: Double): String? {
    if (seconds <= 0) return null
    // Round like the web's formatDuration (35 s reads « 1 min »), and never
    // surface « 0 min » — a zero here means ffprobe failed, not a 0-min film.
    val totalMin = Math.round(seconds / 60.0).toInt()
    if (totalMin <= 0) return null
    val h = totalMin / 60
    val m = totalMin % 60
    return if (h > 0) "${h} h ${m.toString().padStart(2, '0')}" else "$m min"
}

/** The compact "year · rating · quality · runtime/seasons" line shared by the
 *  billboard and the detail header. */
fun metaLine(item: CatalogItem): List<String> = buildList {
    item.year?.let { add(it.toString()) }
    if (item.isMovie) {
        formatRuntime(item.duration)?.let { add(it) }
    } else {
        item.seasonCount?.let { add(if (it > 1) "$it saisons" else "1 saison") }
    }
    qualityLabel(item.qualityHeight, item.qualityHdr)?.let { add(it) }
    item.contentRating?.let { add(it) }
}

// --- profile avatar ---------------------------------------------------------

private val AVATAR_GRADIENTS: Map<String, Pair<Color, Color>> = mapOf(
    "red" to (Color(0xFFE50914) to Color(0xFF7A0509)),
    "blue" to (Color(0xFF2196F3) to Color(0xFF0C3D78)),
    "green" to (Color(0xFF43A047) to Color(0xFF1B5E20)),
    "purple" to (Color(0xFF8E24AA) to Color(0xFF4A148C)),
    "orange" to (Color(0xFFFB8C00) to Color(0xFFA35400)),
    "teal" to (Color(0xFF00897B) to Color(0xFF00332D)),
    "pink" to (Color(0xFFD81B60) to Color(0xFF6E0E30)),
    "yellow" to (Color(0xFFFDD835) to Color(0xFFA68500)),
)

@Composable
fun TvAvatar(preset: String?, name: String, size: Int, onClick: (() -> Unit)? = null, modifier: Modifier = Modifier) {
    val (c0, c1) = AVATAR_GRADIENTS[preset] ?: AVATAR_GRADIENTS.getValue("red")
    val content: @Composable () -> Unit = {
        Box(
            Modifier.size(size.dp).background(Brush.linearGradient(listOf(c0, c1))),
            contentAlignment = Alignment.Center,
        ) {
            Text((name.ifBlank { "?" }).take(1).uppercase(), color = Color.White, fontSize = (size * 0.4f).sp, fontWeight = FontWeight.Black)
        }
    }
    if (onClick != null) {
        Surface(
            onClick = onClick,
            modifier = modifier,
            shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape((size * 0.14f).dp)),
            colors = ClickableSurfaceDefaults.colors(containerColor = Color.Transparent, focusedContainerColor = Color.Transparent),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1.12f),
            border = ClickableSurfaceDefaults.border(focusedBorder = androidx.tv.material3.Border(BorderStroke(3.dp, Color.White), shape = RoundedCornerShape((size * 0.14f).dp))),
        ) { content() }
    } else {
        Box(modifier.clip(RoundedCornerShape((size * 0.14f).dp))) { content() }
    }
}

/** Row of metadata chips, dot-separated for the billboard/detail panels. */
@Composable
fun MetaRow(parts: List<String>) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        parts.forEach { MetaChip(it) }
    }
}
