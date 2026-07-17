package local.flix.tv.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
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
import local.flix.core.net.FlixApi

@Composable
fun TvImage(
    api: FlixApi,
    hash: String?,
    width: Int? = null,
    modifier: Modifier = Modifier,
    contentScale: androidx.compose.ui.layout.ContentScale = androidx.compose.ui.layout.ContentScale.Crop,
    fallback: @Composable () -> Unit = {},
) {
    NetworkImage(url = api.imageUrl(hash, width), client = api.client, modifier = modifier, contentScale = contentScale, fallback = fallback)
}

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
fun TvAvatar(preset: String?, name: String, size: Int, onClick: (() -> Unit)? = null) {
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
            shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape((size * 0.12f).dp)),
            colors = ClickableSurfaceDefaults.colors(containerColor = Color.Transparent, focusedContainerColor = Color.Transparent),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1.12f),
            border = ClickableSurfaceDefaults.border(focusedBorder = androidx.tv.material3.Border(androidx.compose.foundation.BorderStroke(3.dp, Color.White), shape = RoundedCornerShape((size * 0.12f).dp))),
        ) { content() }
    } else {
        Box(Modifier.clip(RoundedCornerShape((size * 0.12f).dp))) { content() }
    }
}
