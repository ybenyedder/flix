package local.flix.tv.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Typography
import androidx.tv.material3.darkColorScheme

// Fixed cinematic dark palette shared with the mobile app (see
// app/.../ui/theme/Theme.kt and src/app/globals.css), rendered through Compose
// for TV's own MaterialTheme so Surface/Card focus scale+glow read correctly
// against a near-black background. Extended for the 10-foot redesign with
// scrim/chip/elevation tones so cards, billboards and chips share one system.

@Immutable
data class FlixTvColors(
    val background: Color = Color(0xFF0B0B0F),
    val backgroundElevated: Color = Color(0xFF141418),
    val surface: Color = Color(0xFF1A1A20),
    val surfaceFocused: Color = Color(0xFF2A2A33),
    val accent: Color = Color(0xFFE50914),
    val accentSoft: Color = Color(0xFFF6414A),
    val positive: Color = Color(0xFF46D369),
    val text: Color = Color(0xFFFFFFFF),
    val textMuted: Color = Color(0xFFB9B9C4),
    val textFaint: Color = Color(0xFF7A7A88),
    // Semi-transparent surfaces for chips/scrims layered over artwork.
    val chip: Color = Color(0x1FFFFFFF),
    val chipBorder: Color = Color(0x33FFFFFF),
    val scrimTop: Color = Color(0x00000000),
    val scrimBottom: Color = Color(0xF20B0B0F),
)

val LocalFlixTvColors = staticCompositionLocalOf { FlixTvColors() }

@Composable
fun FlixTvTheme(content: @Composable () -> Unit) {
    val colors = FlixTvColors()
    val scheme = darkColorScheme(
        primary = colors.accent,
        onPrimary = colors.text,
        background = colors.background,
        onBackground = colors.text,
        surface = colors.surface,
        onSurface = colors.text,
        surfaceVariant = colors.surfaceFocused,
        onSurfaceVariant = colors.textMuted,
        border = colors.textFaint,
    )
    CompositionLocalProvider(LocalFlixTvColors provides colors) {
        MaterialTheme(colorScheme = scheme, typography = Typography(), content = content)
    }
}
