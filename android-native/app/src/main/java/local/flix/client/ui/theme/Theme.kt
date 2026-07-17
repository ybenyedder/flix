package local.flix.client.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight

// Single fixed Netflix-style dark theme — mirrors the web client's CSS
// variables in /home/pc/Documents/netflix/src/app/globals.css
// (--background:#141414, --surface:#181818, --accent:#E50914, …). Flix has
// no theme picker; unlike the sibling Auralis client this is intentionally
// the only palette.

@Immutable
data class FlixColors(
    val background: Color = Color(0xFF141414),
    val surface: Color = Color(0xFF181818),
    val surfaceHover: Color = Color(0xFF232323),
    val accent: Color = Color(0xFFE50914),
    val accentHover: Color = Color(0xFFF6121D),
    val text: Color = Color(0xFFFFFFFF),
    val textMuted: Color = Color(0xFFB3B3B3),
    val textFaint: Color = Color(0xFF808080),
    val border: Color = Color(0x33FFFFFF),
)

val LocalFlixColors = staticCompositionLocalOf { FlixColors() }

private val FlixType = Typography().let { d ->
    val f = FontFamily.SansSerif
    Typography(
        displayLarge = d.displayLarge.copy(fontFamily = f, fontWeight = FontWeight.Black),
        headlineMedium = d.headlineMedium.copy(fontFamily = f, fontWeight = FontWeight.Black),
        titleLarge = d.titleLarge.copy(fontFamily = f, fontWeight = FontWeight.Bold),
        titleMedium = d.titleMedium.copy(fontFamily = f, fontWeight = FontWeight.SemiBold),
        bodyLarge = d.bodyLarge.copy(fontFamily = f),
        bodyMedium = d.bodyMedium.copy(fontFamily = f),
        labelLarge = d.labelLarge.copy(fontFamily = f, fontWeight = FontWeight.SemiBold),
        labelSmall = d.labelSmall.copy(fontFamily = f, fontWeight = FontWeight.SemiBold),
    )
}

@Composable
fun FlixTheme(content: @Composable () -> Unit) {
    val colors = FlixColors()
    val scheme = darkColorScheme(
        primary = colors.accent,
        onPrimary = colors.text,
        background = colors.background,
        onBackground = colors.text,
        surface = colors.surface,
        onSurface = colors.text,
        surfaceVariant = colors.surfaceHover,
        onSurfaceVariant = colors.textMuted,
        error = colors.accent,
        outline = colors.border,
    )
    androidx.compose.runtime.CompositionLocalProvider(LocalFlixColors provides colors) {
        MaterialTheme(colorScheme = scheme, typography = FlixType, content = content)
    }
}
