package local.flix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.CircularProgressIndicator
import androidx.tv.material3.Text
import local.flix.tv.ui.player.TvPlayerScreen
import local.flix.tv.ui.screens.TvDetailScreen
import local.flix.tv.ui.screens.TvHomeScreen
import local.flix.tv.ui.screens.TvLoginScreen
import local.flix.tv.ui.screens.TvOnboardingScreen
import local.flix.tv.ui.screens.TvProfilesScreen
import local.flix.tv.ui.theme.FlixTvTheme
import local.flix.tv.ui.theme.LocalFlixTvColors

@Composable
fun TvRoot(vm: TvViewModel) {
    val ui by vm.ui.collectAsState()
    FlixTvTheme {
        val colors = LocalFlixTvColors.current
        Box(Modifier.fillMaxSize().background(colors.background)) {
            when (ui.phase) {
                TvPhase.BOOT, TvPhase.LOADING -> TvLoading()
                TvPhase.CONNECT -> TvOnboardingScreen(ui.connecting, ui.message, ui.serverBase, vm::connect)
                TvPhase.PROFILES -> TvProfilesScreen(ui.profiles, onSelect = vm::selectProfile, onChangeServer = vm::changeServer)
                TvPhase.LOGIN -> TvLoginScreen(ui.selectedProfile ?: "", ui.connecting, ui.message, vm::login, vm::backToProfiles)
                TvPhase.HOME -> TvMainContent(vm, ui)
                TvPhase.ERROR -> TvError(ui.message, vm::loadHome)
            }
        }
    }
}

@Composable
private fun TvMainContent(vm: TvViewModel, ui: TvUiState) {
    when (val screen = ui.screen) {
        is TvScreen.Home -> TvHomeScreen(vm, ui)
        is TvScreen.Detail -> TvDetailScreen(vm, ui, screen.type, screen.id)
        is TvScreen.Player -> TvPlayerScreen(vm, ui, screen)
    }
}

@Composable
private fun TvLoading() {
    val colors = LocalFlixTvColors.current
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("FLIX", color = colors.accent, fontSize = 48.sp, fontWeight = FontWeight.Black)
        Spacer(Modifier.height(24.dp))
        CircularProgressIndicator(color = colors.accent, modifier = Modifier.size(38.dp))
    }
}

@Composable
private fun TvError(message: String?, onRetry: () -> Unit) {
    val colors = LocalFlixTvColors.current
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Connexion impossible", color = colors.text, fontSize = 26.sp, fontWeight = FontWeight.Black)
        Spacer(Modifier.height(12.dp))
        Text(message ?: "Le serveur est injoignable.", color = colors.textMuted, fontSize = 16.sp)
        Spacer(Modifier.height(28.dp))
        androidx.tv.material3.Surface(
            onClick = onRetry,
            colors = androidx.tv.material3.ClickableSurfaceDefaults.colors(containerColor = colors.chip, focusedContainerColor = colors.accent),
            shape = androidx.tv.material3.ClickableSurfaceDefaults.shape(shape = androidx.compose.foundation.shape.RoundedCornerShape(6.dp)),
            scale = androidx.tv.material3.ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
        ) {
            Text("Réessayer", color = colors.text, fontSize = 16.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 28.dp, vertical = 12.dp))
        }
    }
}
