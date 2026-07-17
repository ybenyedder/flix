package local.flix.client.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import local.flix.client.ui.theme.LocalFlixColors
import local.flix.core.image.NetworkImage
import local.flix.core.net.FlixApi
import kotlin.math.roundToInt

/** [NetworkImage] pre-bound to this app's [FlixApi]'s authenticated OkHttp
 *  client — every poster/backdrop/logo call site just passes a hash. */
@Composable
fun FlixImage(
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
fun ProfileAvatar(preset: String?, name: String, size: Int, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val (c0, c1) = AVATAR_GRADIENTS[preset] ?: AVATAR_GRADIENTS.getValue("red")
    Box(
        modifier
            .size(size.dp)
            .clip(RoundedCornerShape((size * 0.12f).dp))
            .background(Brush.linearGradient(listOf(c0, c1)))
            .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            (name.ifBlank { "?" }).take(1).uppercase(),
            color = Color.White.copy(alpha = 0.95f),
            fontSize = (size * 0.42f).sp,
            fontWeight = FontWeight.Black,
        )
    }
}

@Composable
fun PrimaryButton(label: String, modifier: Modifier = Modifier, loading: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val colors = LocalFlixColors.current
    Box(
        modifier
            .clip(RoundedCornerShape(4.dp))
            .background(if (enabled) colors.text else colors.textFaint)
            .clickable(enabled = enabled && !loading) { onClick() }
            .padding(horizontal = 22.dp, vertical = 13.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(color = colors.background, strokeWidth = 2.dp, modifier = Modifier.size(20.dp).clip(CircleShape))
        } else {
            Text(label, color = colors.background, fontWeight = FontWeight.Bold, fontSize = 15.sp)
        }
    }
}

/** Small caps/quality badge shown on cards and detail headers (e.g. "4K",
 *  "HDR"). */
@Composable
fun QualityBadge(height: Int?, hdr: Boolean) {
    val label = when {
        height != null && height >= 2000 -> "4K"
        height != null && height >= 1000 -> "HD"
        else -> null
    }
    if (label == null && !hdr) return
    val colors = LocalFlixColors.current
    androidx.compose.foundation.layout.Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (label != null) {
            Box(Modifier.clip(RoundedCornerShape(2.dp)).background(colors.textFaint.copy(alpha = 0.3f)).padding(horizontal = 4.dp, vertical = 1.dp)) {
                Text(label, color = colors.text, fontSize = 10.sp, fontWeight = FontWeight.Bold)
            }
        }
        if (hdr) {
            Box(Modifier.clip(RoundedCornerShape(2.dp)).background(colors.textFaint.copy(alpha = 0.3f)).padding(horizontal = 4.dp, vertical = 1.dp)) {
                Text("HDR", color = colors.text, fontSize = 10.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

fun matchLabel(score: Int?): String? = score?.let { "$it% de correspondance" }

fun formatDuration(seconds: Double): String {
    val total = seconds.roundToInt()
    val h = total / 3600
    val m = (total % 3600) / 60
    return if (h > 0) "${h} h ${m} min" else "${m} min"
}

fun formatClock(ms: Long): String {
    val totalSec = (ms / 1000).coerceAtLeast(0)
    val h = totalSec / 3600
    val m = (totalSec % 3600) / 60
    val s = totalSec % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}
