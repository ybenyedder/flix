package local.flix.tv.ui.player

import android.net.Uri
import android.view.ViewGroup
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Forward10
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay10
import androidx.compose.material.icons.filled.Subtitles
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
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import local.flix.core.caps.ClientCaps
import local.flix.core.caps.NativeCaps
import local.flix.core.model.DecisionAudioTrack
import local.flix.core.model.DecisionSubtitle
import local.flix.core.model.EpisodeDetail
import local.flix.core.model.MediaFileInfo
import local.flix.core.model.PlayDecision
import local.flix.core.model.PlaySession
import local.flix.core.model.flattenEpisodes
import local.flix.core.playback.resolveAudioGroup
import local.flix.core.playback.resolveTextGroup
import local.flix.core.playback.subtitleFormatId
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
    // "Ignorer" must stick: the 8s progress loop recomputes nextUpVisible
    // unconditionally, so without this latch the overlay pops right back on
    // the next tick. Reset per `screen` — the next episode gets its own offer.
    var nextUpDismissed by remember(screen) { mutableStateOf(false) }
    var advanced by remember(screen) { mutableStateOf(false) }
    // Track menu state. `decision` carries the server's track lists (the web
    // player's PlayerView does the same decide-then-session dance); the
    // selections are OUR single source of truth — media3's own selection state
    // is re-derived from them (see the enforcement effect below) because it
    // resets on every session rebuild. `selectedAudioIdx` is the ffprobe
    // stream_index the server contract speaks (never a media3 ordinal);
    // `selectedSubId` is a subtitles.id, null = « Désactivés ».
    var caps by remember(screen) { mutableStateOf<ClientCaps?>(null) }
    var decision by remember(screen) { mutableStateOf<PlayDecision?>(null) }
    var showTracks by remember(screen) { mutableStateOf(false) }
    var selectedAudioIdx by remember(screen) { mutableStateOf<Int?>(null) }
    var selectedSubId by remember(screen) { mutableStateOf<Int?>(null) }
    val playPauseFocus = remember { FocusRequester() }
    val nextUpPlayFocus = remember { FocusRequester() }
    val tracksFirstFocus = remember { FocusRequester() }
    // Auto-hide: controls show on any D-pad key and fade after a few seconds of
    // inactivity while playing. `interactions` bumps on every key so the
    // hide-timer effect restarts (cancelling the previous delay) — no wall
    // clock needed.
    var controlsVisible by remember(screen) { mutableStateOf(true) }
    var interactions by remember(screen) { mutableStateOf(0) }

    /** Media item for a fresh session. Every NON-burn-in subtitle (embedded
     *  text AND external sidecars) is sideloaded from /api/subs/<id> — the
     *  server extracts/converts to WebVTT lazily, exactly what the web player
     *  feeds its <track> element — with a STABLE format id so selection can
     *  resolve it by identity (TrackSelection.kt). This works identically for
     *  direct play and HLS: the session playlist is a full static VOD starting
     *  at 0 (hlsArgs.ts), so sideloaded cue times always line up. Burn-in
     *  (bitmap) subs can't be text tracks at all; they ride in `subtitleId`
     *  on session creation instead. */
    fun buildMediaItem(session: PlaySession, dec: PlayDecision?): MediaItem {
        val sideloaded = dec?.subtitles.orEmpty()
            .filter { !it.requiresBurnIn }
            .map { s ->
                MediaItem.SubtitleConfiguration.Builder(Uri.parse(vm.api.subtitleUrl(s.id)))
                    .setId(subtitleFormatId(s.id))
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLanguage(s.language)
                    .setLabel(s.title ?: s.language)
                    .build()
            }
        return when (session) {
            is PlaySession.Direct -> MediaItem.Builder()
                .setUri(Uri.parse(vm.api.absoluteUrl(session.url)))
                .setSubtitleConfigurations(sideloaded)
                .build()
            is PlaySession.Hls -> MediaItem.Builder()
                .setUri(Uri.parse(vm.api.absoluteUrl(session.playlistUrl)))
                .setMimeType(MimeTypes.APPLICATION_M3U8)
                .setSubtitleConfigurations(sideloaded)
                .build()
        }
    }

    /** Create (or re-create, on a track change) the playback session for the
     *  CURRENT selections and start playing at [startMs]. The mode is decided
     *  server-side from fileId/caps/audioIdx/subtitleId — never here (a
     *  non-default audio pick may turn direct into remux, a burn-in sub into
     *  transcode; the direct > remux > transcode order is the server's law).
     *  The previous HLS session is ended explicitly first — the server would
     *  also replace it on the same deviceId, but only once the create request
     *  lands, and an orphaned ffmpeg otherwise idles until the reaper. */
    suspend fun startPlayback(startMs: Long) {
        val t = target ?: return
        val c = caps ?: return
        loading = true
        activeSession?.let { vm.endPlaySession(it.sessionId) }
        activeSession = null
        val burnInId = decision?.subtitles?.firstOrNull { it.id == selectedSubId && it.requiresBurnIn }?.id
        val session = vm.api.createSession(t.file.id, c, audioIdx = selectedAudioIdx, subtitleId = burnInId, deviceId = "android-tv")
        if (session == null) {
            error = "Le serveur n'a pas pu préparer la lecture."
            loading = false
            return
        }
        if (session is PlaySession.Hls) activeSession = session
        vm.player.playItem(buildMediaItem(session, decision), startPositionMs = startMs)
        loading = false
    }

    LaunchedEffect(screen) {
        loading = true
        error = null
        val builtCaps = NativeCaps.build(context)
        caps = builtCaps
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
        // Ask for the decision first: it carries the track lists AND the
        // per-profile language preselections (audioStreamIndex/subtitleId).
        // Feeding its resolved audio index back into the session — like the
        // web does — keeps the session and the menu's notion of "current"
        // agreeing even when a preference picked a non-default track. A null
        // decision (older server?) still plays; the menu just stays hidden.
        val dec = vm.api.decidePlay(resolved.file.id, builtCaps)
        decision = dec
        selectedAudioIdx = dec?.audioStreamIndex
        selectedSubId = dec?.subtitleId
        startPlayback(resolved.resumeMs)
        runCatching { playPauseFocus.requestFocus() }
    }

    // Enforce the CURRENT subtitle choice on whatever text groups media3
    // exposes right now, resolved by identity (stable sideload id) — never by
    // ordinal. Keyed on the live Tracks so it re-asserts itself after every
    // session rebuild and whenever sideloads (re)appear; everything not chosen
    // is kept off, exactly like the web forces every non-active <track> to
    // "disabled". A burn-in pick resolves to no text group and correctly
    // lands on selectTextTrack(null): the subtitle is in the video pixels.
    val snapshot by vm.player.snapshot.collectAsState()
    LaunchedEffect(snapshot.tracks, selectedSubId, decision) {
        val dec = decision ?: return@LaunchedEffect
        val sub = dec.subtitles.firstOrNull { it.id == selectedSubId && !it.requiresBurnIn }
        vm.player.selectTextTrack(sub?.let { resolveTextGroup(snapshot.tracks, it) })
    }

    LaunchedEffect(screen) {
        while (true) {
            delay(8000)
            val t = target ?: continue
            val posMs = vm.player.positionMs()
            val durMs = vm.player.durationMs()
            if (durMs <= 0) continue
            vm.saveProgress(t.itemType, t.itemId, posMs / 1000.0, durMs / 1000.0, t.file.id)
            nextUpVisible = !nextUpDismissed && t.episodeIndex in 0 until t.episodeList.lastIndex && (durMs - posMs) in 0..30_000
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

    // Hand the focus back to the transport when the tracks panel closes. The
    // transport layer is NOT composed while the panel is up (that is the focus
    // trap — invisible-but-focusable transport buttons would otherwise catch a
    // stray D-pad move), so the restore has to wait for it to be back in the
    // tree: an effect keyed on (showTracks, loading) runs after recomposition
    // has re-attached playPauseFocus, and re-runs once a pick-triggered
    // session rebuild finishes (the transport is also gated on !loading).
    var tracksWasOpen by remember(screen) { mutableStateOf(false) }
    LaunchedEffect(showTracks, loading) {
        if (showTracks) {
            tracksWasOpen = true
        } else if (tracksWasOpen && !loading) {
            tracksWasOpen = false
            runCatching { playPauseFocus.requestFocus() }
        }
    }

    Box(
        Modifier.fillMaxSize().background(Color.Black).onPreviewKeyEvent { e ->
            // BACK closes the tracks panel — and only the panel. It must be
            // eaten HERE, in the preview pass: unhandled BACKs bubble up to
            // TvActivity.onBackPressed, which pops the whole player off the
            // nav stack. Consuming the DOWN also keeps the activity from ever
            // starting its back-tracking, so the later UP can't re-trigger it.
            if (showTracks && e.key == Key.Back) {
                if (e.type == KeyEventType.KeyDown) showTracks = false
                return@onPreviewKeyEvent true
            }
            if (e.type == KeyEventType.KeyDown) {
                val wasHidden = !controlsVisible
                controlsVisible = true
                interactions++
                // Swallow only the FIRST key that wakes the controls, so it
                // reveals them instead of also triggering the focused button —
                // and only while the transport layer is the active one: the
                // error, next-up and tracks overlays render fully visible
                // regardless of controlsVisible, so eating their first OK/BACK
                // press would force the user to press every button twice.
                val transportActive = shownError == null && !loading && !(nextUpVisible && !advanced) && !showTracks
                wasHidden && transportActive
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

        if (shownError == null && !loading && !showTracks) {
            // Whole control layer fades together. Kept in composition (buttons
            // stay focusable) even at alpha 0 so a key press can be caught to
            // reveal them — but dropped entirely while the tracks panel is up,
            // which is what keeps D-pad focus from escaping the panel.
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
                        TvCtrlButton(Icons.AutoMirrored.Filled.ArrowBack, "Retour", onClick = { vm.back() })
                        TvCtrlButton(Icons.Filled.Replay10, "Reculer de 10 secondes", onClick = { vm.player.seekBy(-10_000L) })
                        TvCtrlButton(
                            if (snapshot.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                            if (snapshot.isPlaying) "Pause" else "Lecture",
                            onClick = { vm.player.togglePlay(); interactions++ },
                            modifier = Modifier.focusRequester(playPauseFocus),
                            big = true,
                        )
                        TvCtrlButton(Icons.Filled.Forward10, "Avancer de 10 secondes", onClick = { vm.player.seekBy(10_000L) })
                        // Same availability rule as the web's TrackMenu button:
                        // an actual audio choice, or at least one subtitle.
                        val dec = decision
                        if (dec != null && (dec.audioTracks.size > 1 || dec.subtitles.isNotEmpty())) {
                            TvCtrlButton(Icons.Filled.Subtitles, "Pistes audio et sous-titres", onClick = { showTracks = true; interactions++ })
                        }
                    }
                }
            }
        }

        if (nextUpVisible && !advanced) {
            // Steal the focus while the offer is up: the transport buttons stay
            // focusable at alpha 0, so without this OK would land on play/pause
            // and PAUSE the video underneath the overlay instead of launching
            // the next episode. Focus is handed back on dismiss.
            LaunchedEffect(Unit) { runCatching { nextUpPlayFocus.requestFocus() } }
            Box(Modifier.fillMaxSize().padding(56.dp), contentAlignment = Alignment.BottomEnd) {
                Column(Modifier.background(colors.surface, RoundedCornerShape(10.dp)).padding(22.dp), horizontalAlignment = Alignment.End) {
                    Text("Épisode suivant", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(14.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TvPillButton("Ignorer", onClick = {
                            nextUpVisible = false
                            nextUpDismissed = true
                            runCatching { playPauseFocus.requestFocus() }
                        })
                        TvPillButton(
                            "Lire",
                            emphasized = true,
                            modifier = Modifier.focusRequester(nextUpPlayFocus),
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

        val dec = decision
        if (showTracks && dec != null) {
            // Same focus-steal pattern as the next-up overlay: grab the D-pad
            // on open (the transport layer is un-composed meanwhile), hand it
            // back through the tracksWasOpen effect on close.
            LaunchedEffect(Unit) { runCatching { tracksFirstFocus.requestFocus() } }
            Box(
                Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.5f)).padding(40.dp),
                contentAlignment = Alignment.CenterEnd,
            ) {
                TvTrackPanel(
                    decision = dec,
                    selectedAudioIdx = selectedAudioIdx,
                    selectedSubId = selectedSubId,
                    firstFocus = tracksFirstFocus,
                    onSelectAudio = { t ->
                        showTracks = false
                        if (t.streamIndex != selectedAudioIdx) {
                            selectedAudioIdx = t.streamIndex
                            // DIRECT play carries every audio track in the
                            // container, so a supported, unambiguously-resolved
                            // pick switches instantly client-side and KEEPS
                            // direct play (the web can't do this — it always
                            // rebuilds into a remux). Everything else — HLS
                            // (the server muxes exactly one audio track in),
                            // an unsupported codec, an ambiguous language
                            // match — goes back to the server by stream index:
                            // end session, recreate with audioIdx, resume at
                            // the current position. Never an ordinal pick.
                            val group = if (activeSession == null && t.supported) resolveAudioGroup(snapshot.tracks, t) else null
                            if (group != null) vm.player.selectAudioTrack(group)
                            else scope.launch { startPlayback(vm.player.positionMs()) }
                        }
                    },
                    onSelectSubtitle = { s ->
                        showTracks = false
                        if (s?.id != selectedSubId) {
                            // A burn-in sub only exists as pixels ffmpeg renders
                            // into the video: entering OR leaving one changes
                            // what the server must encode, so the session is
                            // recreated (web parity — its pipeline rebuilds on
                            // burnInSubtitleId changes). Text picks cost
                            // nothing: the enforcement effect re-resolves the
                            // sideloaded group from selectedSubId.
                            val hadBurnIn = dec.subtitles.any { it.id == selectedSubId && it.requiresBurnIn }
                            selectedSubId = s?.id
                            if (s?.requiresBurnIn == true || hadBurnIn) {
                                scope.launch { startPlayback(vm.player.positionMs()) }
                            }
                        }
                    },
                )
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

/** Round transport control. `big` = the central play/pause. Vector icons, not
 *  emoji glyphs — the system emoji font paints those in colour (orange pause
 *  buttons…), which wrecks the theme on every OEM. */
@Composable
private fun TvCtrlButton(icon: ImageVector, contentDescription: String, onClick: () -> Unit, modifier: Modifier = Modifier, big: Boolean = false) {
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
            Icon(icon, contentDescription = contentDescription, tint = Color.White, modifier = Modifier.size(if (big) 32.dp else 24.dp))
        }
    }
}

@Composable
private fun TvPillButton(label: String, onClick: () -> Unit, emphasized: Boolean = false, modifier: Modifier = Modifier) {
    val colors = LocalFlixTvColors.current
    Surface(
        onClick = onClick,
        modifier = modifier,
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

/** Audio + subtitle picker, right-aligned over the player. Selecting only
 *  REPORTS the pick to the screen — this panel has no idea whether it costs a
 *  client-side switch or a whole session rebuild (same contract as the web's
 *  TrackMenu). Labels mirror the web's: title > LANG > fallback, « ·N.0 »
 *  channels, « (transcodage) » for unsupported audio, « ·SME » / « (incrustés) »
 *  for SDH / burn-in subs. Initial focus lands on the CURRENT selection, so
 *  BACK-out-without-change is a zero-cost round trip. */
@Composable
private fun TvTrackPanel(
    decision: PlayDecision,
    selectedAudioIdx: Int?,
    selectedSubId: Int?,
    firstFocus: FocusRequester,
    onSelectAudio: (DecisionAudioTrack) -> Unit,
    onSelectSubtitle: (DecisionSubtitle?) -> Unit,
) {
    val colors = LocalFlixTvColors.current
    val showAudio = decision.audioTracks.size > 1
    val showSubs = decision.subtitles.isNotEmpty()
    Row(
        // Same container language as the next-up overlay: colors.surface on a
        // RoundedCornerShape (tv-material Surfaces are used for the focusable
        // rows themselves).
        Modifier.background(colors.surface, RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 22.dp).width(if (showAudio && showSubs) 600.dp else 320.dp),
    ) {
        if (showAudio) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
                Text("Audio", color = colors.textMuted, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(10.dp))
                decision.audioTracks.forEach { t ->
                    val selected = t.streamIndex == selectedAudioIdx
                    TvTrackRow(
                        label = audioTrackLabel(t),
                        selected = selected,
                        onClick = { onSelectAudio(t) },
                        // The audio column owns the initial focus when shown;
                        // `selected` matches exactly one row (stream_index is
                        // unique and audioStreamIndex is one of them).
                        modifier = if (selected) Modifier.focusRequester(firstFocus) else Modifier,
                    )
                }
            }
        }
        if (showSubs) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
                Text("Sous-titres", color = colors.textMuted, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(10.dp))
                val offSelected = selectedSubId == null || decision.subtitles.none { it.id == selectedSubId }
                TvTrackRow(
                    label = "Désactivés",
                    selected = offSelected,
                    onClick = { onSelectSubtitle(null) },
                    modifier = if (!showAudio && offSelected) Modifier.focusRequester(firstFocus) else Modifier,
                )
                decision.subtitles.forEach { s ->
                    val selected = s.id == selectedSubId
                    TvTrackRow(
                        label = subtitleTrackLabel(s),
                        selected = selected,
                        onClick = { onSelectSubtitle(s) },
                        modifier = if (!showAudio && selected) Modifier.focusRequester(firstFocus) else Modifier,
                    )
                }
            }
        }
    }
}

/** One focusable row of the tracks panel: check slot + label. */
@Composable
private fun TvTrackRow(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = LocalFlixTvColors.current
    Surface(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
        shape = ClickableSurfaceDefaults.shape(shape = RoundedCornerShape(8.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (selected) colors.chip else Color.Transparent,
            focusedContainerColor = colors.accent,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.02f),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(22.dp)) {
                if (selected) Text("✓", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            }
            Text(label, color = Color.White, fontSize = 14.sp, maxLines = 1)
        }
    }
}

// French labels, mirroring the web TrackMenu's trackLabel() + suffixes.
private fun baseTrackLabel(language: String?, title: String?, fallback: String): String =
    title ?: language?.uppercase() ?: fallback

private fun audioTrackLabel(t: DecisionAudioTrack): String = buildString {
    append(baseTrackLabel(t.language, t.title, "Piste ${t.streamIndex}"))
    t.channels?.let { append(" · ${it}.0") }
    if (!t.supported) append(" (transcodage)")
}

private fun subtitleTrackLabel(s: DecisionSubtitle): String = buildString {
    append(baseTrackLabel(s.language, s.title, "Piste ${s.id}"))
    if (s.isSdh) append(" · SME")
    if (s.requiresBurnIn) append(" (incrustés)")
}
