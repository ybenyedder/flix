package local.flix.tv.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Typography
import androidx.tv.material3.darkColorScheme

// Same fixed Netflix-style dark palette as the mobile app (see
// app/.../ui/theme/Theme.kt and src/app/globals.css), rendered through
// Compose for TV's own MaterialTheme/ColorScheme so Surface/Card focus
// scale+glow read correctly against a near-black background.

@Immutable
data class FlixTvColors(
    val background: Color = Color(0xFF141414),
    val surface: Color = Color(0xFF181818),
    val surfaceFocused: Color = Color(0xFF2A2A2A),
    val accent: Color = Color(0xFFE50914),
    val text: Color = Color(0xFFFFFFFF),
    val textMuted: Color = Color(0xFFB3B3B3),
    val textFaint: Color = Color(0xFF808080),
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
