package local.flix.tv.ui.player

import android.net.Uri
import android.view.ViewGroup
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.ui.PlayerView
import androidx.compose.material3.CircularProgressIndicator
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import local.flix.core.caps.NativeCaps
import local.flix.core.model.EpisodeDetail
import local.flix.core.model.MediaFileInfo
import local.flix.core.model.PlaySession
import local.flix.core.model.flattenEpisodes
import local.flix.tv.ui.TvScreen
import local.flix.tv.ui.TvUiState
import local.flix.tv.ui.TvViewModel
import local.flix.tv.ui.theme.LocalFlixTvColors

private data class TvPlayTarget(
    val itemType: String,
    val itemId: Int,
    val topType: String,
    val topId: Int,
    val title: String,
    val file: MediaFileInfo,
    val resumeMs: Long,
    val episodeList: List<EpisodeDetail> = emptyList(),
    val episodeIndex: Int = -1,
)

/** Fully D-pad-driven playback screen: no drag gestures anywhere (a TV remote
 *  has no pointer), just focusable Surface buttons the built-in Compose focus
 *  search already moves between with the D-pad's arrow keys, and OK/Enter
 *  (DPAD_CENTER) activates whichever one is focused — the standard leanback
 *  interaction model. */
@Composable
fun TvPlayerScreen(vm: TvViewModel, ui: TvUiState, screen: TvScreen.Player) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val colors = LocalFlixTvColors.current

    var target by remember(screen) { mutableStateOf<TvPlayTarget?>(null) }
    var loading by remember(screen) { mutableStateOf(true) }
    var error by remember(screen) { mutableStateOf<String?>(null) }
    var activeSession by remember(screen) { mutableStateOf<PlaySession.Hls?>(null) }
    var nextUpVisible by remember(screen) { mutableStateOf(false) }
    var advanced by remember(screen) { mutableStateOf(false) }
    val playPauseFocus = remember { FocusRequester() }
    // Auto-hide: controls show on any D-pad key and fade after a few seconds of
    // inactivity while playing. `interactions` bumps on every key so the
    // hide-timer effect restarts (cancelling the previous delay) — no wall
    // clock needed.
    var controlsVisible by remember(screen) { mutableStateOf(true) }
    var interactions by remember(screen) { mutableStateOf(0) }

    LaunchedEffect(screen) {
        loading = true
        error = null
        val caps = NativeCaps.build(context)
        val resolved: TvPlayTarget? = if (screen.type == "movie") {
            val detail = ui.movieDetails[screen.id] ?: vm.api.movieDetail(screen.id)
            val file = detail?.files?.firstOrNull()
            if (detail != null && file != null) TvPlayTarget("movie", screen.id, "movie", screen.id, detail.item.title, file, screen.resumeMs) else null
        } else {
            val show = ui.showDetails[screen.id] ?: vm.api.showDetail(screen.id)
            if (show != null) {
                val episodes = show.flattenEpisodes()
                val epId = screen.episodeId ?: episodes.firstOrNull()?.id
                val idx = episodes.indexOfFirst { it.id == epId }
                val ep = episodes.getOrNull(idx)
                val file = ep?.files?.firstOrNull()
                if (ep != null && file != null) {
                    TvPlayTarget("episode", ep.id, "show", show.item.id, "${show.item.title} — É${ep.episodeNumber}", file, screen.resumeMs, episodes, idx)
                } else null
            } else null
        }
        if (resolved == null) {
            error = "Impossible de charger ce contenu."
            loading = false
            return@LaunchedEffect
        }
        target = resolved
        val session = vm.api.createSession(resolved.file.id, caps, deviceId = "android-tv")
        if (session == null) {
            error = "Le serveur n'a pas pu préparer la lecture."
            loading = false
            return@LaunchedEffect
        }
        val mediaItem = when (session) {
            is PlaySession.Direct -> MediaItem.Builder().setUri(Uri.parse(vm.api.absoluteUrl(session.url))).build()
            is PlaySession.Hls -> {
                activeSession = session
                MediaItem.Builder().setUri(Uri.parse(vm.api.absoluteUrl(session.playlistUrl))).setMimeType(MimeTypes.APPLICATION_M3U8).build()
            }
        }
        vm.player.playItem(mediaItem, startPositionMs = resolved.resumeMs)
        loading = false
        runCatching { playPauseFocus.requestFocus() }
    }

    LaunchedEffect(screen) {
        while (true) {
            delay(8000)
            val t = target ?: continue
            val posMs = vm.player.positionMs()
            val durMs = vm.player.durationMs()
            if (durMs <= 0) continue
            vm.saveProgress(t.itemType, t.itemId, posMs / 1000.0, durMs / 1000.0, t.file.id)
            nextUpVisible = t.episodeIndex in 0 until t.episodeList.lastIndex && (durMs - posMs) in 0..30_000
        }
    }

    DisposableEffect(screen) {
        vm.player.onEnded = {
            val t = target
            if (t != null && !advanced) {
                advanced = true
                val durSec = (vm.player.durationMs() / 1000.0).coerceAtLeast(1.0)
                vm.recordWatchEvent(t.itemType, t.itemId, "complete", 1.0, durSec)
                scope.launch {
                    if (t.episodeIndex in 0 until t.episodeList.lastIndex) vm.play("show", t.topId, t.episodeList[t.episodeIndex + 1].id) else vm.back()
                }
            }
        }
        onDispose {
            vm.player.onEnded = null
            val t = target
            if (t != null) {
                val posMs = vm.player.positionMs()
                val durMs = vm.player.durationMs().coerceAtLeast(1L)
                val ratio = (posMs.toDouble() / durMs).coerceIn(0.0, 1.0)
                vm.saveProgress(t.itemType, t.itemId, posMs / 1000.0, durMs / 1000.0, t.file.id)
                if (!advanced && ratio < 0.15 && posMs > 120_000) vm.recordWatchEvent(t.itemType, t.itemId, "abandon", ratio, posMs / 1000.0)
            }
            vm.player.stop()
            activeSession?.let { s -> vm.endPlaySession(s.sessionId) }
        }
    }

    val snapshot by vm.player.snapshot.collectAsState()
    // Runtime playback failures previously sat unread in the snapshot: frozen
    // frame, no message. Share the setup-error overlay.
    val shownError = error ?: snapshot.playerError

    // Fade the controls after a few seconds of inactivity, but only while
    // actually playing (a paused screen keeps its controls). Any key bumps
    // `interactions`, restarting this.
    LaunchedEffect(interactions, snapshot.isPlaying, controlsVisible, loading, shownError) {
        if (controlsVisible && snapshot.isPlaying && shownError == null && !loading) {
            delay(5000)
            controlsVisible = false
        }
    }
    val overlayAlpha by androidx.compose.animation.core.animateFloatAsState(if (controlsVisible) 1f else 0f, label = "controls")

    Box(
        Modifier.fillMaxSize().background(Color.Black).onPreviewKeyEvent { e ->
            if (e.type == KeyEventType.KeyDown) {
                val wasHidden = !controlsVisible
                controlsVisible = true
                interactions++
                // Swallow only the FIRST key that wakes the controls, so it
                // reveals them instead of also triggering the focused button.
                wasHidden
            } else {
                false
            }
        },
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            // keepScreenOn: media3 does not hold the screen — without it the TV
            // screensaver/Daydream kicks in mid-playback.
            factory = { ctx -> PlayerView(ctx).apply { useController = false; keepScreenOn = true; layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT) } },
            update = { view -> view.player = vm.player.currentPlayer },
        )

        if (loading) CircularProgressIndicator(color = colors.accent, modifier = Modifier.align(Alignment.Center))

        shownError?.let { msg ->
            Column(Modifier.align(Alignment.Center).padding(48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Lecture impossible", color = colors.text, fontSize = 22.sp, fontWeight = FontWeight.Black)
                Spacer(Modifier.height(10.dp))
                Text(msg, color = colors.textMuted, fontSize = 16.sp)
                Spacer(Modifier.height(20.dp))
                Surface(
                    onClick = { vm.back() },
                    colors = ClickableSurfaceDefaults.colors(containerColor = colors.chip, focusedContainerColor = colors.accent),
                    shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(6.dp)),
                    scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
                ) {
                    Text("Retour", color = colors.text, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 26.dp, vertical = 12.dp))
                }
            }
        }

        if (shownError == null && !loading) {
            // Whole control layer fades together. Kept in composition (buttons
            // stay focusable) even at alpha 0 so a key press can be caught to
            // reveal them.
            Box(Modifier.fillMaxSize().alpha(overlayAlpha)) {
                // Bottom cinematic scrim so white controls read over any frame.
                Box(
                    Modifier.align(Alignment.BottomStart).fillMaxWidth().fillMaxHeight(0.5f)
                        .background(androidx.compose.ui.graphics.Brush.verticalGradient(0f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.85f))),
                )
                Column(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(horizontal = 56.dp, vertical = 44.dp)) {
                    Text(target?.title.orEmpty(), color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Black, maxLines = 1)
                    Spacer(Modifier.height(16.dp))
                    // Progress bar with a knob (visual only — D-pad seeks via the
                    // ±10s buttons; tv-material ships no draggable Slider and a
                    // remote has no pointer anyway).
                    val progress = if (snapshot.durationMs > 0) (snapshot.positionMs.toFloat() / snapshot.durationMs).coerceIn(0f, 1f) else 0f
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(formatTime(snapshot.positionMs), color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        Box(Modifier.weight(1f).padding(horizontal = 14.dp)) {
                            Box(Modifier.fillMaxWidth().height(5.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.25f))) {
                                Box(Modifier.fillMaxWidth(progress).height(5.dp).clip(CircleShape).background(colors.accent))
                            }
                        }
                        Text(formatTime(snapshot.durationMs), color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    }
                    Spacer(Modifier.height(18.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        TvCtrlButton("‹", onClick = { vm.back() })
                        TvCtrlButton("⏪", onClick = { vm.player.seekBy(-10_000L) })
                        TvCtrlButton(
                            if (snapshot.isPlaying) "⏸" else "▶",
                            onClick = { vm.player.togglePlay(); interactions++ },
                            modifier = Modifier.focusRequester(playPauseFocus),
                            big = true,
                        )
                        TvCtrlButton("⏩", onClick = { vm.player.seekBy(10_000L) })
                    }
                }
            }
        }

        if (nextUpVisible && !advanced) {
            Box(Modifier.fillMaxSize().padding(56.dp), contentAlignment = Alignment.BottomEnd) {
                Column(Modifier.background(colors.surface, RoundedCornerShape(10.dp)).padding(22.dp), horizontalAlignment = Alignment.End) {
                    Text("Épisode suivant", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(14.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TvPillButton("Ignorer", onClick = { nextUpVisible = false })
                        TvPillButton(
                            "Lire",
                            emphasized = true,
                            onClick = {
                                val t = target
                                if (t != null && t.episodeIndex in 0 until t.episodeList.lastIndex) {
                                    advanced = true
                                    vm.play("show", t.topId, t.episodeList[t.episodeIndex + 1].id)
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

/** "1:04:12" / "48:07" from a millisecond position. */
private fun formatTime(ms: Long): String {
    val totalSec = (ms / 1000).coerceAtLeast(0)
    val h = totalSec / 3600
    val m = (totalSec % 3600) / 60
    val s = totalSec % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

/** Round transport control. `big` = the central play/pause. */
@Composable
private fun TvCtrlButton(glyph: String, onClick: () -> Unit, modifier: Modifier = Modifier, big: Boolean = false) {
    val colors = LocalFlixTvColors.current
    val d = if (big) 68.dp else 52.dp
    Surface(
        onClick = onClick,
        modifier = modifier.size(d),
        shape = ClickableSurfaceDefaults.shape(shape = CircleShape),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (big) Color.White.copy(alpha = 0.16f) else Color.White.copy(alpha = 0.08f),
            focusedContainerColor = colors.accent,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.12f),
    ) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(glyph, color = Color.White, fontSize = if (big) 26.sp else 20.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun TvPillButton(label: String, onClick: () -> Unit, emphasized: Boolean = false) {
    val colors = LocalFlixTvColors.current
    Surface(
        onClick = onClick,
        shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(6.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (emphasized) Color.White else colors.chip,
            focusedContainerColor = colors.accent,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
    ) {
        Text(label, color = if (emphasized) colors.background else Color.White, fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 20.dp, vertical = 11.dp))
    }
}
