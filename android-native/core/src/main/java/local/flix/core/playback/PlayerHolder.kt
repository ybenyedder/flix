package local.flix.core.playback

import android.content.ComponentName
import android.content.Context
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class PlaybackSnapshot(
    val isPlaying: Boolean = false,
    val playbackState: Int = Player.STATE_IDLE,
    val positionMs: Long = 0L,
    val durationMs: Long = 0L,
    val bufferedPercentage: Int = 0,
    val tracks: Tracks = Tracks.EMPTY,
    val playerError: String? = null,
)

/**
 * UI-side bridge to [PlaybackService]. Connects a [MediaController], mirrors
 * ExoPlayer state into flows Compose can collect, and exposes the transport
 * controls both the mobile PlayerScreen and TvPlayerScreen drive. Kept
 * UI-framework-free (no Compose here) so it is one of the pieces genuinely
 * shared between :app and :tv, per the sibling Auralis native client's
 * PlayerHolder.
 */
class PlayerHolder(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var controller: MediaController? = null

    private val _snapshot = MutableStateFlow(PlaybackSnapshot())
    val snapshot: StateFlow<PlaybackSnapshot> = _snapshot

    /** Exposes the underlying [MediaController] as a plain [Player] so a
     *  Compose screen can bind it to a media3-ui `PlayerView` (or a TV
     *  leanback player view) for video rendering — [PlayerHolder] itself only
     *  owns transport state, never a View. */
    val currentPlayer: Player? get() = controller

    /** Fired once per natural end-of-media (never on a manual stop), so the
     *  screen can decide whether to auto-advance to the next episode. */
    var onEnded: (() -> Unit)? = null

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            pushSnapshot()
        }

        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_ENDED) onEnded?.invoke()
        }

        override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
            _snapshot.value = _snapshot.value.copy(playerError = error.message ?: "Erreur de lecture")
        }
    }

    fun connect(onReady: () -> Unit = {}) {
        if (controller != null) {
            onReady()
            return
        }
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        future.addListener({
            controller = future.get().also { c ->
                c.addListener(listener)
                pushSnapshot()
            }
            startTicker()
            onReady()
        }, ContextCompat.getMainExecutor(context))
    }

    fun release() {
        controller?.removeListener(listener)
        controller?.stop()
        controller?.release()
        controller = null
        scope.cancel()
    }

    private fun startTicker() {
        scope.launch {
            while (true) {
                pushSnapshot()
                delay(500)
            }
        }
    }

    private fun pushSnapshot() {
        val c = controller ?: return
        _snapshot.value = PlaybackSnapshot(
            isPlaying = c.isPlaying,
            playbackState = c.playbackState,
            positionMs = c.currentPosition.coerceAtLeast(0L),
            durationMs = c.duration.coerceAtLeast(0L),
            bufferedPercentage = c.bufferedPercentage,
            tracks = c.currentTracks,
            playerError = _snapshot.value.playerError,
        )
    }

    // ---- controls ------------------------------------------------------------

    /** Replace the current item and start playback (or stay paused) at [startPositionMs]. */
    fun playItem(item: MediaItem, startPositionMs: Long = 0L, playWhenReady: Boolean = true) {
        val c = controller ?: return
        _snapshot.value = PlaybackSnapshot()
        c.setMediaItem(item, startPositionMs)
        c.prepare()
        c.playWhenReady = playWhenReady
    }

    fun togglePlay() {
        val c = controller ?: return
        if (c.isPlaying) c.pause() else { c.prepare(); c.play() }
    }

    fun play() { controller?.play() }
    fun pause() { controller?.pause() }
    fun seekTo(ms: Long) { controller?.seekTo(ms.coerceAtLeast(0L)) }
    fun seekBy(deltaMs: Long) {
        val c = controller ?: return
        c.seekTo((c.currentPosition + deltaMs).coerceIn(0L, c.duration.coerceAtLeast(0L)))
    }

    fun positionMs(): Long = controller?.currentPosition?.coerceAtLeast(0L) ?: 0L
    fun durationMs(): Long = controller?.duration?.coerceAtLeast(0L) ?: 0L
    fun isPlaying(): Boolean = controller?.isPlaying ?: false

    fun stop() { controller?.stop() }

    /** Selects one audio track group by its embedded-language/group index —
     *  used for DIRECT play, where the container itself carries every audio
     *  track and ExoPlayer can switch instantly with no re-buffer. HLS
     *  (remux/transcode) sessions instead re-request a new session with the
     *  desired `audioIdx`, since the server only muxes ONE audio track in. */
    fun selectAudioGroup(groupIndex: Int) {
        val c = controller ?: return
        val group = c.currentTracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }.getOrNull(groupIndex) ?: return
        c.trackSelectionParameters = c.trackSelectionParameters.buildUpon()
            .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
            .build()
    }

    /** Enables/disables the embedded text track group at [groupIndex], or
     *  clears all text overrides when null (subtitles off). */
    fun selectTextGroup(groupIndex: Int?) {
        val c = controller ?: return
        val builder = c.trackSelectionParameters.buildUpon()
        val textGroups = c.currentTracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }
        for (g in textGroups) builder.clearOverridesOfType(C.TRACK_TYPE_TEXT)
        if (groupIndex != null) {
            val group = textGroups.getOrNull(groupIndex)
            if (group != null) builder.setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
        } else {
            builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        }
        c.trackSelectionParameters = builder.build()
        if (groupIndex != null) {
            c.trackSelectionParameters = c.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).build()
        }
    }
}
