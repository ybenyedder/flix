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
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import local.flix.client.ui.AppViewModel
import local.flix.client.ui.Screen
import local.flix.client.ui.UiState
import local.flix.client.ui.components.formatClock
import local.flix.core.caps.NativeCaps
import local.flix.core.model.DecisionAudioTrack
import local.flix.core.model.DecisionSubtitle
import local.flix.core.model.EpisodeDetail
import local.flix.core.model.MediaFileInfo
import local.flix.core.model.PlayDecision
import local.flix.core.model.PlaySession
import local.flix.core.model.ShowDetail
import local.flix.core.model.flattenEpisodes

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

    // Resolve what to play from the nav args, load its media file + episode
    // context, then run the same decide-then-create-session flow the web
    // player uses (src/app/api/play/decision, .../play/session).
    LaunchedEffect(screen) {
        loading = true
        error = null
        val caps = NativeCaps.build(context)
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

        val dec = vm.api.decidePlay(resolved.file.id, caps)
        val session = vm.api.createSession(resolved.file.id, caps, deviceId = "android-mobile")
        if (dec == null || session == null) {
            error = "Le serveur n'a pas pu préparer la lecture."
            loading = false
            return@LaunchedEffect
        }
        decision = dec

        // External subtitles are separate sidecar files (/api/subs/{id}, always
        // served as WebVTT) — unlike embedded/HLS tracks they live OUTSIDE the
        // media container, so ExoPlayer never exposes them unless we sideload them
        // here. Each gets a STABLE id so track selection can match it back to the
        // right media3 text group (see resolveTextGroupIndex); previously the raw
        // server-list ordinal was fed to media3, so external subs never rendered.
        // Bitmap subs (requiresBurnIn) can't be served as text, so they're skipped.
        val externalSubs = dec.subtitles
            .filter { it.source == "external" && !it.requiresBurnIn }
            .map { s ->
                MediaItem.SubtitleConfiguration.Builder(Uri.parse(vm.api.subtitleUrl(s.id)))
                    .setId("flix-sub-${s.id}")
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLanguage(s.language)
                    .setLabel(s.title ?: s.language)
                    .build()
            }

        val mediaItem = when (session) {
            is PlaySession.Direct -> MediaItem.Builder()
                .setUri(Uri.parse(vm.api.absoluteUrl(session.url)))
                .setSubtitleConfigurations(externalSubs)
                .build()
            is PlaySession.Hls -> {
                activeSession = session
                MediaItem.Builder()
                    .setUri(Uri.parse(vm.api.absoluteUrl(session.playlistUrl)))
                    .setMimeType(MimeTypes.APPLICATION_M3U8)
                    .setSubtitleConfigurations(externalSubs)
                    .build()
            }
        }
        vm.player.playItem(mediaItem, startPositionMs = resolved.resumeMs)
        loading = false
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

    val snapshot by vm.player.snapshot.collectAsState()
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
                snapshot = snapshot,
                onSelectAudio = { idx -> vm.player.selectAudioGroup(idx) },
                onSelectText = { idx -> vm.player.selectTextGroup(idx) },
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

@Composable
private fun TrackMenu(
    decision: PlayDecision?,
    snapshot: local.flix.core.playback.PlaybackSnapshot,
    onSelectAudio: (Int) -> Unit,
    onSelectText: (Int?) -> Unit,
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
                    Text(
                        (t.title ?: t.language ?: "Piste ${idx + 1}") + if (t.isDefault) " (défaut)" else "",
                        color = androidx.compose.ui.graphics.Color.White, fontSize = 13.sp,
                        // Resolve to the media3 group by language; keep the list
                        // ordinal only as a fallback when the language is missing
                        // or ambiguous (see resolveAudioGroupIndex).
                        modifier = Modifier.clickable { onSelectAudio(resolveAudioGroupIndex(snapshot.tracks, t) ?: idx) }.padding(vertical = 6.dp),
                    )
                }
            }
            Spacer(Modifier.size(14.dp))
            Text("Sous-titres", color = androidx.compose.ui.graphics.Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp)
            Spacer(Modifier.size(8.dp))
            Text("Désactivés", color = androidx.compose.ui.graphics.Color.White.copy(alpha = 0.7f), fontSize = 13.sp, modifier = Modifier.clickable { onSelectText(null) }.padding(vertical = 6.dp))
            decision?.subtitles.orEmpty().forEachIndexed { idx, s ->
                Text(
                    s.title ?: s.language ?: "Piste ${idx + 1}",
                    color = androidx.compose.ui.graphics.Color.White, fontSize = 13.sp,
                    // Map to the REAL media3 text group by identity (external subs
                    // by their sideloaded id, else by language) instead of the raw
                    // ordinal; no-op if the track isn't actually present so we
                    // never disable the wrong group (see resolveTextGroupIndex).
                    modifier = Modifier.clickable { resolveTextGroupIndex(snapshot.tracks, s)?.let { g -> onSelectText(g) } }.padding(vertical = 6.dp),
                )
            }
        }
    }
}

// ---- server-track -> media3-group mapping ----------------------------------
// The server's decision lists (audioTracks / subtitles) are NOT in the same
// order — nor even the same set — as the track groups ExoPlayer actually
// exposes: external subs are sideloaded into their own groups, HLS renditions
// arrive in playlist order, and burn-in-only subs aren't present as tracks at
// all. Passing the raw list ordinal therefore selected the wrong group (and
// external subs never rendered). We instead resolve by identity against the
// live Tracks. Indices returned are within the type-filtered groups, matching
// exactly what PlayerHolder.selectAudioGroup / selectTextGroup expect.

/** Media3 audio-group index for a chosen server audio track, matched on
 *  (normalised) language. Returns null when the match is missing OR ambiguous
 *  (several groups share the language), so the caller keeps the positional
 *  ordinal rather than risk switching to the wrong same-language track. */
private fun resolveAudioGroupIndex(tracks: Tracks, audio: DecisionAudioTrack): Int? {
    val audioGroups = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
    val matches = audioGroups.indices.filter { sameLanguage(audioGroups[it].getTrackFormat(0).language, audio.language) }
    return matches.singleOrNull()
}

/** Media3 text-group index for a chosen server subtitle. External subs are
 *  sideloaded by us with a stable id (see the MediaItem build), so those match
 *  exactly; embedded/HLS text tracks are matched on (normalised) language.
 *  Returns null when the track isn't in the current Tracks (e.g. an HLS
 *  burn-in-only sub) so the caller can no-op instead of disabling the wrong
 *  group. */
private fun resolveTextGroupIndex(tracks: Tracks, sub: DecisionSubtitle): Int? {
    val textGroups = tracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }
    if (sub.source == "external") {
        val id = "flix-sub-${sub.id}"
        val byId = textGroups.indexOfFirst { it.getTrackFormat(0).id == id }
        if (byId >= 0) return byId
    }
    val byLang = textGroups.indexOfFirst { sameLanguage(it.getTrackFormat(0).language, sub.language) }
    return byLang.takeIf { it >= 0 }
}

/** ISO-639 codes aren't stored uniformly across a real library (ffprobe emits
 *  639-2 "fre"/"fra", while media3 normalises container/HLS tags to 639-1
 *  "fr") — decision.ts flags the very same issue server-side — so compare on a
 *  folded 639-1 code. */
private fun sameLanguage(a: String?, b: String?): Boolean {
    val na = normalizeLang(a) ?: return false
    val nb = normalizeLang(b) ?: return false
    return na == nb
}

private fun normalizeLang(code: String?): String? {
    if (code.isNullOrBlank()) return null
    val c = code.trim().lowercase().substringBefore('-') // drop region, e.g. "en-US"
    return LANG_3_TO_1[c] ?: c
}

/** Common ISO-639-2/B and 639-2/T codes ffprobe emits, folded to the 639-1
 *  code media3 uses — only the languages a home library realistically carries. */
private val LANG_3_TO_1 = mapOf(
    "eng" to "en", "fre" to "fr", "fra" to "fr", "spa" to "es", "ger" to "de",
    "deu" to "de", "ita" to "it", "por" to "pt", "rus" to "ru", "jpn" to "ja",
    "chi" to "zh", "zho" to "zh", "kor" to "ko", "dut" to "nl", "nld" to "nl",
    "ara" to "ar", "hin" to "hi", "swe" to "sv", "nor" to "no", "dan" to "da",
    "fin" to "fi", "pol" to "pl", "tur" to "tr", "ces" to "cs", "cze" to "cs",
    "gre" to "el", "ell" to "el", "heb" to "he", "tha" to "th", "vie" to "vi",
    "ukr" to "uk", "ron" to "ro", "rum" to "ro", "hun" to "hu",
)
