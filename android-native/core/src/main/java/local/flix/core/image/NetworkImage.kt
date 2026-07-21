package local.flix.core.image

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

/**
 * Async network image for posters/backdrops/logos served from
 * `/api/images/<hash>` — content-addressed and immutable server-side, so a
 * two-tier cache (in-memory LRU + a persistent on-disk layer) is safe forever:
 * the same hash never changes body. Shared between :app and :tv since both
 * render the exact same card/billboard artwork. Auth is whatever
 * [FlixApi]-owned [OkHttpClient] the caller passes in (Authorization header
 * interceptor already attached there) — no query-string token needed.
 */
private object ArtCache {
    // ~40 MB of decoded bitmaps — generous enough for a couple of screens'
    // worth of posters/backdrops without re-decoding on every scroll.
    private val cache = object : LruCache<String, ImageBitmap>(40 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ImageBitmap): Int = value.width * value.height * 4
    }

    private fun diskKey(url: String): String {
        val digest = MessageDigest.getInstance("SHA-1").digest(url.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun cached(url: String): ImageBitmap? = cache.get(url)

    suspend fun load(url: String, client: OkHttpClient, cacheDir: File): ImageBitmap? = withContext(Dispatchers.IO) {
        cache.get(url)?.let { return@withContext it }
        val dir = File(cacheDir, "flix-images").apply { mkdirs() }
        val file = File(dir, diskKey(url))
        if (file.exists()) {
            runCatching {
                val bytes = file.readBytes()
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
            }.getOrNull()?.let { cache.put(url, it); return@withContext it }
        }
        runCatching {
            val req = Request.Builder().url(url).get().build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val bytes = resp.body?.bytes() ?: return@use null
                runCatching { file.writeBytes(bytes) }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()?.also { cache.put(url, it) }
            }
        }.getOrNull()
    }
}

@Composable
fun NetworkImage(
    url: String?,
    client: OkHttpClient,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Crop,
    // Opt-in fade-in (ms) when the bitmap lands. Off by default: rows of
    // cards must pop instantly while scrolling; only large hero/billboard
    // surfaces want the soft transition.
    fadeInMs: Int = 0,
    fallback: @Composable () -> Unit = {},
) {
    if (url.isNullOrBlank()) {
        Box(modifier) { fallback() }
        return
    }
    val context = LocalContext.current
    var image by remember(url) { mutableStateOf(ArtCache.cached(url)) }
    LaunchedEffect(url) {
        if (image == null) image = ArtCache.load(url, client, context.cacheDir)
    }
    val bmp = image
    if (bmp != null) {
        val alpha = if (fadeInMs > 0) {
            // This branch only enters composition once the bitmap has landed,
            // so the effect naturally starts the fade at arrival time — a slow
            // load can never eat the animation window under the fallback.
            val anim = remember(url) { Animatable(0f) }
            LaunchedEffect(url) { anim.animateTo(1f, tween(fadeInMs)) }
            anim.value
        } else 1f
        Image(bitmap = bmp, contentDescription = null, modifier = modifier.fillMaxSize().alpha(alpha), contentScale = contentScale)
    } else {
        Box(modifier) { fallback() }
    }
}
