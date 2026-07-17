package local.flix.core.playback

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import java.util.concurrent.TimeUnit

/** Holds the current bearer token for the playback process to attach to every
 *  media request. Set by the app right after login/session-restore (see the
 *  app/tv ViewModels) — kept as a tiny in-memory bridge rather than re-reading
 *  DataStore on every segment fetch. Never persisted here; Prefs.kt (DataStore)
 *  remains the durable store. */
object PlaybackAuth {
    @Volatile var token: String? = null
}

/**
 * Native background playback + lock-screen/notification media controls,
 * shared by both :app and :tv (declared once in core/AndroidManifest.xml).
 * Deliberately package-agnostic: it resolves "which activity to reopen when
 * the notification is tapped" via the OS launcher-intent lookup rather than
 * referencing MainActivity/TvActivity directly, since those classes live in
 * modules core cannot depend on.
 */
class PlaybackService : MediaSessionService() {

    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val httpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(0, TimeUnit.SECONDS)
            .addInterceptor(Interceptor { chain ->
                val original = chain.request()
                val token = PlaybackAuth.token
                val request = if (token.isNullOrBlank() || original.header("Authorization") != null) {
                    original
                } else {
                    original.newBuilder().header("Authorization", "Bearer $token").build()
                }
                chain.proceed(request) as Response
            })
            .build()
        val dataSourceFactory: DataSource.Factory = OkHttpDataSource.Factory(httpClient)

        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .build()

        // Tapping the media notification brings whichever app hosts this
        // service (phone or TV APK) back to its own launcher activity.
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val openApp = if (launchIntent != null) {
            PendingIntent.getActivity(this, 0, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        } else {
            null
        }

        session = MediaSession.Builder(this, player).apply { openApp?.let { setSessionActivity(it) } }.build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }
}
