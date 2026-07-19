package local.flix.client.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import local.flix.client.ui.components.PrimaryButton
import local.flix.client.ui.components.ProfileAvatar
import local.flix.client.ui.theme.LocalFlixColors
import local.flix.core.model.ProfileRef

@Composable
private fun FlixField(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    keyboard: KeyboardOptions,
    password: Boolean = false,
    onImeDone: () -> Unit = {},
) {
    val colors = LocalFlixColors.current
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label, color = colors.textMuted) },
        singleLine = true,
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = keyboard,
        keyboardActions = KeyboardActions(onDone = { onImeDone() }, onGo = { onImeDone() }),
        modifier = Modifier.fillMaxWidth(),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = colors.accent,
            unfocusedBorderColor = colors.border,
            focusedTextColor = colors.text,
            unfocusedTextColor = colors.text,
            cursorColor = colors.accent,
        ),
    )
}

@Composable
fun OnboardingScreen(connecting: Boolean, message: String?, initial: String, onConnect: (String) -> Unit) {
    val colors = LocalFlixColors.current
    var url by remember { mutableStateOf(initial) }
    Box(Modifier.fillMaxSize().background(colors.background).systemBarsPadding().imePadding()) {
        Column(
            Modifier.fillMaxSize().padding(28.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("FLIX", color = colors.accent, fontSize = 36.sp, fontWeight = FontWeight.Black)
            Spacer(Modifier.height(24.dp))
            Text("Connexion au serveur", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = colors.text)
            Spacer(Modifier.height(8.dp))
            Text(
                "Entrez l'adresse de votre serveur Flix auto-hébergé (IP locale + port).",
                fontSize = 13.sp, color = colors.textMuted, textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(28.dp))
            FlixField(
                value = url, onChange = { url = it }, label = "Adresse du serveur (ex : 192.168.1.10:4247)",
                keyboard = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                onImeDone = { onConnect(url) },
            )
            Spacer(Modifier.height(16.dp))
            PrimaryButton("Se connecter", loading = connecting, modifier = Modifier.fillMaxWidth()) { onConnect(url) }
            if (message != null) {
                Spacer(Modifier.height(14.dp))
                Text(message, color = colors.accent, fontSize = 12.5.sp, textAlign = TextAlign.Center)
            }
        }
    }
}

@Composable
fun ProfilesScreen(profiles: List<ProfileRef>, onSelect: (String) -> Unit, onChangeServer: (() -> Unit)? = null) {
    val colors = LocalFlixColors.current
    Box(Modifier.fillMaxSize().background(colors.background).systemBarsPadding()) {
        Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.height(40.dp))
            Text("Qui regarde ?", fontSize = 28.sp, fontWeight = FontWeight.Medium, color = colors.text)
            Spacer(Modifier.height(36.dp))
            if (profiles.isEmpty()) {
                // Wrong/moved server address lands here with an empty list —
                // without an escape hatch the app is bricked until a data
                // clear, hence the mandatory "Changer de serveur" link below.
                Text("Aucun profil trouvé sur ce serveur.", color = colors.textMuted, fontSize = 14.sp)
            } else {
                LazyVerticalGrid(columns = GridCells.Fixed(3), horizontalArrangement = Arrangement.spacedBy(18.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    items(profiles) { p ->
                        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.clickable { onSelect(p.username) }) {
                            ProfileAvatar(p.avatar, p.username, 84)
                            Spacer(Modifier.height(8.dp))
                            Text(p.username, fontSize = 13.sp, color = colors.textMuted, fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }
            if (onChangeServer != null) {
                Spacer(Modifier.weight(1f))
                Text(
                    "Changer de serveur",
                    color = colors.textMuted,
                    fontSize = 13.sp,
                    modifier = Modifier.clickable { onChangeServer() }.padding(12.dp),
                )
            }
        }
    }
}

@Composable
fun LoginScreen(username: String, connecting: Boolean, message: String?, onLogin: (String) -> Unit, onBack: () -> Unit) {
    val colors = LocalFlixColors.current
    var password by remember(username) { mutableStateOf("") }
    Box(Modifier.fillMaxSize().background(colors.background).systemBarsPadding().imePadding()) {
        Column(
            Modifier.fillMaxSize().padding(horizontal = 28.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            ProfileAvatar(null, username, 88)
            Spacer(Modifier.height(14.dp))
            Text(username, fontSize = 20.sp, fontWeight = FontWeight.Bold, color = colors.text)
            Spacer(Modifier.height(4.dp))
            Text("Entrez le mot de passe", fontSize = 13.sp, color = colors.textMuted)
            Spacer(Modifier.height(22.dp))
            FlixField(
                value = password, onChange = { password = it }, label = "Mot de passe", password = true,
                keyboard = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
                onImeDone = { onLogin(password) },
            )
            Spacer(Modifier.height(16.dp))
            PrimaryButton("Se connecter", loading = connecting, modifier = Modifier.fillMaxWidth()) { onLogin(password) }
            if (message != null) {
                Spacer(Modifier.height(14.dp))
                Text(message, color = colors.accent, fontSize = 12.5.sp, textAlign = TextAlign.Center)
            }
            Spacer(Modifier.height(18.dp))
            Row(Modifier.clickable { onBack() }) {
                Text("← Changer de profil", fontSize = 12.sp, color = colors.textMuted, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
