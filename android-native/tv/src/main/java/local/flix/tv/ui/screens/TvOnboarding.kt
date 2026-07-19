package local.flix.tv.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import local.flix.core.model.ProfileRef
import local.flix.tv.ui.components.TvAvatar
import local.flix.tv.ui.theme.LocalFlixTvColors

/** Minimal D-pad-friendly text field: tv-material ships no TextField of its
 *  own (only display/selection surfaces), so this wraps [BasicTextField] with
 *  manual focus styling — the same pattern used by TV apps that mix
 *  Compose-for-TV display components with plain compose-foundation input. */
@Composable
private fun TvField(value: String, onChange: (String) -> Unit, placeholder: String, password: Boolean = false, keyboardType: KeyboardType = KeyboardType.Text, onDone: () -> Unit = {}) {
    val colors = LocalFlixTvColors.current
    var focused by remember { mutableStateOf(false) }
    Box(
        Modifier
            .fillMaxWidth()
            .border(2.dp, if (focused) colors.accent else colors.textFaint, RoundedCornerShape(6.dp))
            .background(colors.surface, RoundedCornerShape(6.dp))
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        if (value.isEmpty()) Text(placeholder, color = colors.textFaint, fontSize = 18.sp)
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = TextStyle(color = colors.text, fontSize = 18.sp),
            cursorBrush = SolidColor(colors.accent),
            visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = ImeAction.Go),
            keyboardActions = KeyboardActions(onGo = { onDone() }, onDone = { onDone() }),
            modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused },
        )
    }
}

@Composable
private fun TvPrimaryButton(label: String, onClick: () -> Unit) {
    val colors = LocalFlixTvColors.current
    Surface(
        onClick = onClick,
        colors = ClickableSurfaceDefaults.colors(containerColor = colors.text, focusedContainerColor = colors.accent),
        shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(6.dp)),
    ) {
        Text(label, color = colors.background, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold, fontSize = 16.sp, modifier = Modifier.padding(horizontal = 28.dp, vertical = 14.dp))
    }
}

@Composable
fun TvOnboardingScreen(connecting: Boolean, message: String?, initial: String, onConnect: (String) -> Unit) {
    val colors = LocalFlixTvColors.current
    var url by remember { mutableStateOf(initial) }
    Column(
        Modifier.fillMaxSize().padding(64.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("FLIX", color = colors.accent, fontSize = 44.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Black)
        Spacer(Modifier.height(24.dp))
        Text("Connexion au serveur", color = colors.text, fontSize = 24.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text("Entrez l'adresse de votre serveur Flix (IP locale + port).", color = colors.textMuted, fontSize = 16.sp)
        Spacer(Modifier.height(28.dp))
        Box(Modifier.widthIn(max = 520.dp)) {
            TvField(url, { url = it }, "Adresse du serveur (ex : 192.168.1.10:4247)", keyboardType = KeyboardType.Uri, onDone = { onConnect(url) })
        }
        Spacer(Modifier.height(20.dp))
        TvPrimaryButton(if (connecting) "Connexion…" else "Se connecter") { onConnect(url) }
        if (message != null) {
            Spacer(Modifier.height(14.dp))
            Text(message, color = colors.accent, fontSize = 15.sp)
        }
    }
}

@Composable
fun TvProfilesScreen(profiles: List<ProfileRef>, onSelect: (String) -> Unit, onChangeServer: (() -> Unit)? = null) {
    val colors = LocalFlixTvColors.current
    Column(Modifier.fillMaxSize().padding(64.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text("Qui regarde ?", color = colors.text, fontSize = 32.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium)
        Spacer(Modifier.height(36.dp))
        if (profiles.isEmpty()) {
            // Wrong/moved server address lands here with an empty list — the
            // "Changer de serveur" button below is the only escape hatch short
            // of clearing the app's data.
            Text("Aucun profil trouvé sur ce serveur.", color = colors.textMuted, fontSize = 16.sp)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(28.dp)) {
            profiles.forEach { p ->
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    TvAvatar(p.avatar, p.username, 120, onClick = { onSelect(p.username) })
                    Spacer(Modifier.height(10.dp))
                    Text(p.username, color = colors.textMuted, fontSize = 16.sp)
                }
            }
        }
        if (onChangeServer != null) {
            Spacer(Modifier.height(40.dp))
            androidx.tv.material3.Surface(onClick = onChangeServer) {
                Text("Changer de serveur", color = colors.textMuted, fontSize = 15.sp, modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp))
            }
        }
    }
}

@Composable
fun TvLoginScreen(username: String, connecting: Boolean, message: String?, onLogin: (String) -> Unit, onBack: () -> Unit) {
    val colors = LocalFlixTvColors.current
    var password by remember(username) { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(64.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        TvAvatar(null, username, 110)
        Spacer(Modifier.height(16.dp))
        Text(username, color = colors.text, fontSize = 24.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text("Entrez le mot de passe", color = colors.textMuted, fontSize = 16.sp)
        Spacer(Modifier.height(24.dp))
        Box(Modifier.widthIn(max = 420.dp)) {
            TvField(password, { password = it }, "Mot de passe", password = true, keyboardType = KeyboardType.Password, onDone = { onLogin(password) })
        }
        Spacer(Modifier.height(20.dp))
        TvPrimaryButton(if (connecting) "Connexion…" else "Se connecter") { onLogin(password) }
        if (message != null) {
            Spacer(Modifier.height(14.dp))
            Text(message, color = colors.accent, fontSize = 15.sp)
        }
        Spacer(Modifier.height(18.dp))
        Surface(onClick = onBack, colors = ClickableSurfaceDefaults.colors(containerColor = colors.background, focusedContainerColor = colors.surface)) {
            Text("← Changer de profil", color = colors.textMuted, fontSize = 14.sp, modifier = Modifier.padding(8.dp))
        }
    }
}
