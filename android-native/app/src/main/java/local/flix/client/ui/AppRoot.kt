package local.flix.client.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import local.flix.client.ui.components.PrimaryButton
import local.flix.client.ui.player.PlayerScreen
import local.flix.client.ui.screens.DetailScreen
import local.flix.client.ui.screens.HomeScreen
import local.flix.client.ui.screens.LoginScreen
import local.flix.client.ui.screens.OnboardingScreen
import local.flix.client.ui.screens.ProfilesScreen
import local.flix.client.ui.screens.SearchScreen
import local.flix.client.ui.theme.FlixTheme
import local.flix.client.ui.theme.LocalFlixColors

@Composable
fun AppRoot(vm: AppViewModel) {
    val ui by vm.ui.collectAsState()
    FlixTheme {
        val colors = LocalFlixColors.current
        Box(Modifier.fillMaxSize().background(colors.background)) {
            when (ui.phase) {
                Phase.BOOT, Phase.LOADING -> LoadingScreen()
                Phase.CONNECT -> OnboardingScreen(ui.connecting, ui.message, ui.serverBase, vm::connect)
                Phase.PROFILES -> ProfilesScreen(ui.profiles, onSelect = vm::selectProfile, onChangeServer = vm::changeServer)
                Phase.LOGIN -> LoginScreen(
                    username = ui.selectedProfile ?: "",
                    connecting = ui.connecting,
                    message = ui.message,
                    onLogin = vm::login,
                    onBack = vm::backToProfiles,
                )
                Phase.HOME -> MainContent(vm, ui)
                Phase.ERROR -> ErrorScreen(ui.message, onRetry = vm::loadHome, onChangeServer = vm::changeServer)
            }
        }
    }
}

@Composable
private fun MainContent(vm: AppViewModel, ui: UiState) {
    when (val screen = ui.screen) {
        is Screen.Home -> HomeScreen(vm, ui)
        is Screen.Search -> SearchScreen(vm, ui)
        is Screen.Detail -> DetailScreen(vm, ui, screen.type, screen.id)
        is Screen.Player -> PlayerScreen(vm, ui, screen)
    }
}

@Composable
private fun LoadingScreen() {
    val colors = LocalFlixColors.current
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        CircularProgressIndicator(color = colors.accent, strokeWidth = 3.dp, modifier = Modifier.size(36.dp))
        Spacer(Modifier.height(16.dp))
        Text("FLIX", color = colors.text, fontSize = 22.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun ErrorScreen(message: String?, onRetry: () -> Unit, onChangeServer: () -> Unit) {
    val colors = LocalFlixColors.current
    Column(
        Modifier.fillMaxSize().padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Connexion impossible", color = colors.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text(message ?: "Le serveur est injoignable.", color = colors.textMuted, fontSize = 13.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(20.dp))
        PrimaryButton("Réessayer") { onRetry() }
        Spacer(Modifier.height(14.dp))
        Text(
            "Changer de serveur", color = colors.textMuted, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.clickable { onChangeServer() },
        )
    }
}
