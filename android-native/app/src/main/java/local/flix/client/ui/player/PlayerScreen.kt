package local.flix.client.ui.player

import android.net.Uri
import android.view.ViewGroup
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Forward10
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay10
import androidx.compose.material.icons.filled.Subtitles
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import local.flix.client.ui.AppViewModel
import local.flix.client.ui.Screen
import local.flix.client.ui.UiState
import local.flix.client.ui.components.formatClock
import local.flix.core.caps.ClientCaps
import local.flix.core.caps.NativeCaps
import local.flix.core.model.DecisionAudioTrack
import local.flix.core.model.DecisionSubtitle
import local.flix.core.model.EpisodeDetail
import local.flix.core.model.MediaFileInfo
import local.flix.core.model.PlayDecision
import local.flix.core.model.PlaySession
import local.flix.core.model.ShowDetail
import local.flix.core.model.flattenEpisodes
import local.flix.core.playback.resolveAudioGroup
import local.flix.core.playback.resolveTextGroup
import local.flix.core.playback.subtitleFormatId

private data class PlayTarget(
    val itemType: String, // movie|episode (progress granularity)
    val itemId: Int,
    val topType: String, // movie|show
    val topId: Int,
    val title: String,
    val file: MediaFileInfo,
    val resumeMs: Long,
    val episodeList: List<EpisodeDetail> = emptyList(),
    val episodeIndex: Int = -1,
)

@Composable
fun PlayerScreen(vm: AppViewModel, ui: UiState, screen: Screen.Player) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var target by remember(screen) { mutableStateOf<PlayTarget?>(null) }
    var decision by remember(screen) { mutableStateOf<PlayDecision?>(null) }
    var loading by remember(screen) { mutableStateOf(true) }
    var error by remember(screen) { mutableStateOf<String?>(null) }
    var activeSession by remember(screen) { mutableStateOf<PlaySession.Hls?>(null) }
    var controlsVisible by remember { mutableStateOf(true) }
    var showTracks by remember { mutableStateOf(false) }
    var nextUpVisible by remember(screen) { mutableStateOf(false) }
    var advanced by remember(screen) { mutableStateOf(false) }
    // Kept for session re-creation on a track switch: caps to re-POST, the
    // current audio pick as the ffprobe stream_index the server contract
    // speaks (never a media3 ordinal), and the subtitle pick as a
    // subtitles.id (null = « Désactivés »). Both are OUR single source of
    // truth — media3's own selection state resets on every session rebuild
    // and is re-derived from these (see the enforcement effect below). Same
    // model as the TV player.
    var caps by remember(screen) { mutableStateOf<ClientCaps?>(null) }
    var selectedAudioIdx by remember(screen) { mutableStateOf<Int?>(null) }
    var selectedSubId by remember(screen) { mutableStateOf<Int?>(null) }

    /** Media item for a session. Every NON-burn-in subtitle (embedded text
     *  AND external sidecars) is sideloaded from /api/subs/{id} — the server
     *  extracts/converts to WebVTT lazily, exactly what the web player feeds
     *  its <track> element. Embedded tracks are included because an HLS
     *  session does not mux text at all — without the sideload they simply
     *  don't exist client-side. Each gets a STABLE id so selection can match
     *  it back to the right media3 text group (TrackSelection.kt); cue times
     *  always line up since HLS playlists are full static VOD starting at 0.
     *  Bitmap subs (requiresBurnIn) can't be text tracks; they ride in
     *  `subtitleId` on session creation instead. */
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
        val session = vm.api.createSession(t.file.id, c, audioIdx = selectedAudioIdx, subtitleId = burnInId, deviceId = "android-mobile")
        if (session == null) {
            error = "Le serveur n'a pas pu préparer la lecture."
            loading = false
            return
        }
        if (session is PlaySession.Hls) activeSession = session
        vm.player.playItem(buildMediaItem(session, decision), startPositionMs = startMs)
        loading = false
    }

    // Resolve what to play from the nav args, load its media file + episode
    // context, then run the same decide-then-create-session flow the web
    // player uses (src/app/api/play/decision, .../play/session).
    LaunchedEffect(screen) {
        loading = true
        error = null
        val builtCaps = NativeCaps.build(context)
        caps = builtCaps
        val resolved: PlayTarget? = if (screen.type == "movie") {
            val detail = ui.movieDetails[screen.id] ?: vm.api.movieDetail(screen.id)
            val file = detail?.files?.firstOrNull()
            if (detail != null && file != null) {
                PlayTarget("movie", screen.id, "movie", screen.id, detail.item.title, file, screen.resumeMs)
            } else null
        } else {
            val show = ui.showDetails[screen.id] ?: vm.api.showDetail(screen.id)
            if (show != null) {
                val episodes = show.flattenEpisodes()
                val epId = screen.episodeId ?: episodes.firstOrNull()?.id
                val idx = episodes.indexOfFirst { it.id == epId }
                val ep = episodes.getOrNull(idx)
                val file = ep?.files?.firstOrNull()
                if (ep != null && file != null) {
                    PlayTarget(
                        "episode", ep.id, "show", show.item.id,
                        "${show.item.title} — S${show.seasons.firstOrNull { s -> s.episodes.any { it.id == ep.id } }?.seasonNumber ?: 0} : É${ep.episodeNumber}",
                        file, screen.resumeMs, episodes, idx,
                    )
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
    }

    val snapshot by vm.player.snapshot.collectAsState()

    // Enforce the CURRENT subtitle choice on whatever text groups media3
    // exposes right now, resolved by identity (stable sideload id) — never by
    // ordinal. Keyed on the live Tracks so it re-asserts itself after every
    // session rebuild and whenever sideloads (re)appear; everything not chosen
    // is kept off, exactly like the web forces every non-active <track> to
    // "disabled". A burn-in pick resolves to no text group and correctly
    // lands on selectTextTrack(null): the subtitle is in the video pixels.
    LaunchedEffect(snapshot.tracks, selectedSubId, decision) {
        val dec = decision ?: return@LaunchedEffect
        val sub = dec.subtitles.firstOrNull { it.id == selectedSubId && !it.requiresBurnIn }
        vm.player.selectTextTrack(sub?.let { resolveTextGroup(snapshot.tracks, it) })
    }

    // Progress persistence + near-end next-up prompt, every ~8s while attached.
    LaunchedEffect(screen) {
        while (true) {
            delay(8000)
            val t = target ?: continue
            val posMs = vm.player.positionMs()
            val durMs = vm.player.durationMs()
            if (durMs <= 0) continue
            vm.saveProgress(t.itemType, t.itemId, posMs / 1000.0, durMs / 1000.0, t.file.id)
            val remainingMs = durMs - posMs
            nextUpVisible = t.episodeIndex in 0 until t.episodeList.lastIndex && remainingMs in 0..30_000
        }
    }

    // Natural end of media: record the watch signal and auto-advance a series.
    DisposableEffect(screen) {
        vm.player.onEnded = {
            val t = target
            if (t != null && !advanced) {
                advanced = true
                val durSec = (vm.player.durationMs() / 1000.0).coerceAtLeast(1.0)
                vm.recordWatchEvent(t.itemType, t.itemId, "complete", 1.0, durSec)
                scope.launch {
                    if (t.episodeIndex in 0 until t.episodeList.lastIndex) {
                        val next = t.episodeList[t.episodeIndex + 1]
                        vm.play("show", t.topId, next.id)
                    } else {
                        vm.back()
                    }
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
                if (!advanced && ratio < 0.15 && posMs > 120_000) {
                    vm.recordWatchEvent(t.itemType, t.itemId, "abandon", ratio, posMs / 1000.0)
                }
            }
            vm.player.stop()
            activeSession?.let { s -> vm.endPlaySession(s.sessionId) }
        }
    }

    // Setup failures (decision/session) and runtime playback failures (decode
    // error, dead segment, expired HLS session) share the same overlay — the
    // latter previously sat unread in the snapshot: frozen frame, no message.
    val shownError = error ?: snapshot.playerError

    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black).clickable(
        indication = null,
        interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
    ) { controlsVisible = !controlsVisible }) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    // media3 does NOT hold the screen on by itself — without
                    // this the display times out mid-film (audio keeps going
                    // via the foreground service).
                    keepScreenOn = true
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                }
            },
            update = { view -> view.player = vm.player.currentPlayer },
        )

        if (loading) {
            CircularProgressIndicator(color = androidx.compose.ui.graphics.Color.White, modifier = Modifier.align(Alignment.Center).size(40.dp))
        }

        shownError?.let { msg ->
            Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(msg, color = androidx.compose.ui.graphics.Color.White, fontSize = 14.sp)
                Spacer(Modifier.size(12.dp))
                Text("← Retour", color = androidx.compose.ui.graphics.Color.White, modifier = Modifier.clickable { vm.back() }.padding(8.dp))
            }
        }

        if (controlsVisible && shownError == null) {
            PlayerControlsOverlay(
                title = target?.title ?: "",
                snapshot = snapshot,
                onBack = { vm.back() },
                onTogglePlay = { vm.player.togglePlay() },
                onSeekBy = { vm.player.seekBy(it) },
                onSeekTo = { vm.player.seekTo(it) },
                onToggleTracks = { showTracks = !showTracks },
            )
        }

        if (nextUpVisible && !advanced) {
            NextEpisodeBanner(
                onPlayNow = {
                    val t = target
                    if (t != null && t.episodeIndex in 0 until t.episodeList.lastIndex) {
                        advanced = true
                        val next = t.episodeList[t.episodeIndex + 1]
                        vm.play("show", t.topId, next.id)
                    }
                },
                onDismiss = { nextUpVisible = false },
            )
        }

        if (showTracks) {
            TrackMenu(
                decision = decision,
                selectedAudioIdx = selectedAudioIdx,
                selectedSubId = selectedSubId,
                onSelectAudio = { t ->
                    showTracks = false
                    if (t.streamIndex != selectedAudioIdx) {
                        selectedAudioIdx = t.streamIndex
                        // DIRECT play carries every audio track in the
                        // container, so a supported, unambiguously-resolved
                        // pick switches instantly client-side and KEEPS direct
                        // play. Everything else — HLS (the server muxes exactly
                        // one audio track in), an unsupported codec, an
                        // ambiguous language match — goes back to the server by
                        // stream index: recreate the session, resume in place.
                        val group = if (activeSession == null && t.supported) resolveAudioGroup(snapshot.tracks, t) else null
                        if (group != null) vm.player.selectAudioTrack(group)
                        else scope.launch { startPlayback(vm.player.positionMs()) }
                    }
                },
                onSelectText = { s ->
                    showTracks = false
                    if (s?.id != selectedSubId) {
                        // A burn-in sub only exists as pixels ffmpeg renders
                        // into the video: entering OR leaving one changes what
                        // the server must encode, so the session is recreated.
                        // Text picks cost nothing: the enforcement effect
                        // re-resolves the sideloaded group from selectedSubId.
                        val wasBurnIn = decision?.subtitles?.any { it.id == selectedSubId && it.requiresBurnIn } == true
                        selectedSubId = s?.id
                        if (s?.requiresBurnIn == true || wasBurnIn) scope.launch { startPlayback(vm.player.positionMs()) }
                    }
                },
                onDismiss = { showTracks = false },
            )
        }
    }
}

@Composable
private fun PlayerControlsOverlay(
    title: String,
    snapshot: local.flix.core.playback.PlaybackSnapshot,
    onBack: () -> Unit,
    onTogglePlay: () -> Unit,
    onSeekBy: (Long) -> Unit,
    onSeekTo: (Long) -> Unit,
    onToggleTracks: () -> Unit,
) {
    var dragging by remember { mutableStateOf(false) }
    var dragValue by remember { mutableStateOf(0f) }
    val progress = if (dragging) dragValue else if (snapshot.durationMs > 0) (snapshot.positionMs.toFloat() / snapshot.durationMs).coerceIn(0f, 1f) else 0f

    Column(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.35f)).systemBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.ArrowBack, "Retour", tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(26.dp).clickable { onBack() })
            Spacer(Modifier.width(12.dp))
            Text(title, color = androidx.compose.ui.graphics.Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, modifier = Modifier.weight(1f))
            Icon(Icons.Filled.Subtitles, "Audio et sous-titres", tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(24.dp).clickable { onToggleTracks() })
        }
        Spacer(Modifier.weight(1f))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Replay10, "Reculer de 10s", tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(40.dp).clickable { onSeekBy(-10_000L) })
            Spacer(Modifier.width(36.dp))
            Box(
                Modifier.size(64.dp).clip(CircleShape).background(androidx.compose.ui.graphics.Color.White.copy(alpha = 0.15f)).clickable { onTogglePlay() },
                contentAlignment = Alignment.Center,
            ) {
                Icon(if (snapshot.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow, "Lecture/Pause", tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(34.dp))
            }
            Spacer(Modifier.width(36.dp))
            Icon(Icons.Filled.Forward10, "Avancer de 10s", tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(40.dp).clickable { onSeekBy(10_000L) })
        }
        Spacer(Modifier.weight(1f))
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(formatClock(if (dragging) (dragValue * snapshot.durationMs).toLong() else snapshot.positionMs), color = androidx.compose.ui.graphics.Color.White, fontSize = 11.sp)
            Slider(
                value = progress,
                onValueChange = { dragging = true; dragValue = it },
                onValueChangeFinished = { onSeekTo((dragValue * snapshot.durationMs).toLong()); dragging = false },
                colors = SliderDefaults.colors(thumbColor = androidx.compose.ui.graphics.Color(0xFFE50914), activeTrackColor = androidx.compose.ui.graphics.Color(0xFFE50914), inactiveTrackColor = androidx.compose.ui.graphics.Color.White.copy(alpha = 0.3f)),
                modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
            )
            Text(formatClock(snapshot.durationMs), color = androidx.compose.ui.graphics.Color.White, fontSize = 11.sp)
        }
        Spacer(Modifier.size(12.dp))
    }
}

@Composable
private fun NextEpisodeBanner(onPlayNow: () -> Unit, onDismiss: () -> Unit) {
    Box(Modifier.fillMaxSize().padding(20.dp), contentAlignment = Alignment.BottomEnd) {
        Column(
            Modifier.clip(RoundedCornerShape(6.dp)).background(androidx.compose.ui.graphics.Color(0xFF1A1A1A)).padding(16.dp),
            horizontalAlignment = Alignment.End,
        ) {
            Text("Épisode suivant", color = androidx.compose.ui.graphics.Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.size(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Ignorer", color = androidx.compose.ui.graphics.Color.White.copy(alpha = 0.7f), fontSize = 12.sp, modifier = Modifier.clickable { onDismiss() }.padding(8.dp))
                Box(Modifier.clip(RoundedCornerShape(4.dp)).background(androidx.compose.ui.graphics.Color.White).clickable { onPlayNow() }.padding(horizontal = 14.dp, vertical = 8.dp)) {
                    Text("Lire", color = androidx.compose.ui.graphics.Color.Black, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                }
            }
        }
    }
}

/** Netflix-style « Audio et sous-titres » sheet. Rows carry the SERVER'S
 *  track identities (DecisionAudioTrack / DecisionSubtitle) — resolution to a
 *  media3 group happens in the caller via TrackSelection.kt, by identity,
 *  never by list ordinal. The check mark reflects our own selection state
 *  (selectedAudioIdx / selectedSubId), the single source of truth that
 *  survives session rebuilds. */
@Composable
private fun TrackMenu(
    decision: PlayDecision?,
    selectedAudioIdx: Int?,
    selectedSubId: Int?,
    onSelectAudio: (DecisionAudioTrack) -> Unit,
    onSelectText: (DecisionSubtitle?) -> Unit,
    onDismiss: () -> Unit,
) {
    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.6f)).clickable(
        indication = null, interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
    ) { onDismiss() }) {
        Column(
            Modifier.align(Alignment.Center).clip(RoundedCornerShape(8.dp)).background(androidx.compose.ui.graphics.Color(0xFF1A1A1A)).padding(20.dp),
        ) {
            Text("Audio", color = androidx.compose.ui.graphics.Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp)
            Spacer(Modifier.size(8.dp))
            val audioTracks = decision?.audioTracks.orEmpty()
            if (audioTracks.isEmpty()) {
                Text("Piste par défaut", color = androidx.compose.ui.graphics.Color.White.copy(alpha = 0.7f), fontSize = 13.sp)
            } else {
                audioTracks.forEachIndexed { idx, t ->
                    TrackMenuRow(
                        label = (t.title ?: t.language ?: "Piste ${idx + 1}") + if (t.isDefault) " (défaut)" else "",
                        selected = t.streamIndex == selectedAudioIdx,
                        onClick = { onSelectAudio(t) },
                    )
                }
            }
            Spacer(Modifier.size(14.dp))
            Text("Sous-titres", color = androidx.compose.ui.graphics.Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp)
            Spacer(Modifier.size(8.dp))
            TrackMenuRow(label = "Désactivés", selected = selectedSubId == null, onClick = { onSelectText(null) })
            decision?.subtitles.orEmpty().forEachIndexed { idx, s ->
                TrackMenuRow(
                    label = s.title ?: s.language ?: "Piste ${idx + 1}",
                    selected = s.id == selectedSubId,
                    onClick = { onSelectText(s) },
                )
            }
        }
    }
}

@Composable
private fun TrackMenuRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { onClick() }.padding(vertical = 6.dp)) {
        Text(
            if (selected) "✓" else " ",
            color = androidx.compose.ui.graphics.Color.White,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.width(20.dp),
        )
        Text(
            label,
            color = if (selected) androidx.compose.ui.graphics.Color.White else androidx.compose.ui.graphics.Color.White.copy(alpha = 0.7f),
            fontSize = 13.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}
