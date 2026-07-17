package local.flix.core.net

import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import local.flix.core.caps.ClientCaps
import local.flix.core.caps.toJson
import local.flix.core.model.AuthResult
import local.flix.core.model.LibrarySnapshot
import local.flix.core.model.MovieDetail
import local.flix.core.model.PlayDecision
import local.flix.core.model.PlaySession
import local.flix.core.model.ProfileRef
import local.flix.core.model.RecommendResult
import local.flix.core.model.ShowDetail
import local.flix.core.model.UserState
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Thin OkHttp client for the Flix server HTTP API. Auth is a bearer session
 * token attached via an interceptor (see [AuthInterceptor]) so every request —
 * REST calls here, image fetches (NetworkImage.kt) and ExoPlayer's
 * media3-datasource-okhttp — shares one authenticated [OkHttpClient] instance,
 * which is also the single Call.Factory the player reads from.
 *
 * Zero external network calls: [base] is always whatever LAN/localhost address
 * the user typed into onboarding (see Onboarding screens); nothing here ever
 * targets a hardcoded remote host.
 */
class FlixApi {

    @Volatile var base: String = ""
        private set

    @Volatile var token: String? = null
        private set

    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        // Playback reads can stall mid-segment on a slow remux; keep the socket
        // open rather than tearing down a otherwise-healthy transfer.
        .callTimeout(0, TimeUnit.SECONDS)
        .addInterceptor(AuthInterceptor { token })
        .build()

    private inner class AuthInterceptor(private val tokenProvider: () -> String?) : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val original = chain.request()
            val t = tokenProvider()
            val request = if (t.isNullOrBlank() || original.header("Authorization") != null) {
                original
            } else {
                original.newBuilder().header("Authorization", "Bearer $t").build()
            }
            return chain.proceed(request)
        }
    }

    fun configure(base: String, token: String?) {
        this.base = normalizeBase(base)
        this.token = token
    }

    fun setToken(token: String?) {
        this.token = token
    }

    fun isConfigured(): Boolean = base.isNotBlank() && !token.isNullOrBlank()

    // ---- URL builders (used by the player / image loader) ------------------

    fun absoluteUrl(path: String): String = if (path.startsWith("http")) path else base + (if (path.startsWith("/")) path else "/$path")

    fun imageUrl(hash: String?, width: Int? = null): String? {
        if (hash.isNullOrBlank()) return null
        val w = if (width != null) "?w=$width" else ""
        return absoluteUrl("/api/images/$hash$w")
    }

    // ---- auth ----------------------------------------------------------------

    suspend fun health(probeBase: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val req = Request.Builder().url("${normalizeBase(probeBase)}/api/health").get().build()
            client.newCall(req).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    suspend fun login(probeBase: String, username: String, password: String): AuthResult = withContext(Dispatchers.IO) {
        val b = normalizeBase(probeBase)
        val body = JSONObject().put("username", username).put("password", password)
        val req = Request.Builder().url("$b/api/auth/login").post(body.toString().toRequestBody(JSON)).build()
        runCatching {
            client.newCall(req).execute().use { resp ->
                val json = resp.body?.string()?.let { JSONObject(it) } ?: JSONObject()
                if (resp.isSuccessful && json.optBoolean("ok", false)) {
                    AuthResult.from(json, username)
                } else {
                    AuthResult.failure(json.optString("error", "Identifiant ou mot de passe incorrect"))
                }
            }
        }.getOrElse { AuthResult.failure("Serveur injoignable") }
    }

    /** Account list for the "Qui est-ce ?" profile picker. */
    suspend fun accounts(probeBase: String): List<ProfileRef> = withContext(Dispatchers.IO) {
        val b = normalizeBase(probeBase)
        runCatching {
            val req = Request.Builder().url("$b/api/auth/accounts").get().build()
            client.newCall(req).execute().use { resp ->
                val arr = resp.body?.string()?.let { JSONObject(it) }?.optJSONArray("profiles") ?: JSONArray()
                (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let { ProfileRef.from(it) } }
            }
        }.getOrDefault(emptyList())
    }

    /** Re-validate/refresh the stored token against /api/auth/status. */
    suspend fun status(): AuthResult = withContext(Dispatchers.IO) {
        runCatching {
            val req = authed(Request.Builder().url("$base/api/auth/status").get())
            client.newCall(req).execute().use { resp ->
                val json = resp.body?.string()?.let { JSONObject(it) } ?: JSONObject()
                if (json.optBoolean("authenticated", false)) AuthResult.from(json) else AuthResult.failure("Session expirée")
            }
        }.getOrElse { AuthResult.failure("Serveur injoignable") }
    }

    // ---- library / detail / search --------------------------------------------

    suspend fun library(): LibrarySnapshot = LibrarySnapshot.from(getJson("/api/library"))

    suspend fun movieDetail(id: Int): MovieDetail? = withContext(Dispatchers.IO) {
        runCatching { MovieDetail.from(getJson("/api/items/movie/$id")) }.getOrNull()
    }

    suspend fun showDetail(id: Int): ShowDetail? = withContext(Dispatchers.IO) {
        runCatching { ShowDetail.from(getJson("/api/items/show/$id")) }.getOrNull()
    }

    suspend fun search(query: String): Pair<List<local.flix.core.model.CatalogItem>, List<local.flix.core.model.CatalogItem>> =
        withContext(Dispatchers.IO) {
            if (query.isBlank()) return@withContext emptyList<local.flix.core.model.CatalogItem>() to emptyList()
            val url = "$base/api/search".toHttpUrlOrNull()!!.newBuilder().addQueryParameter("q", query).build()
            runCatching {
                client.newCall(authed(Request.Builder().url(url).get())).execute().use { resp ->
                    val json = resp.body?.string()?.let { JSONObject(it) } ?: JSONObject()
                    val movies = json.optJSONArray("movies")?.objects()?.map { local.flix.core.model.CatalogItem.fromMovie(it) } ?: emptyList()
                    val shows = json.optJSONArray("shows")?.objects()?.map { local.flix.core.model.CatalogItem.fromShow(it) } ?: emptyList()
                    movies to shows
                }
            }.getOrDefault(emptyList<local.flix.core.model.CatalogItem>() to emptyList())
        }

    // ---- recommendations / state -----------------------------------------------

    suspend fun recommend(): RecommendResult =
        runCatching { RecommendResult.from(getJson("/api/recommend")) }.getOrDefault(RecommendResult.EMPTY)

    suspend fun userState(): UserState = runCatching { UserState.from(getJson("/api/state")) }.getOrDefault(UserState.EMPTY)

    suspend fun toggleMyList(itemType: String, itemId: Int, add: Boolean): Boolean =
        postState(JSONObject().put("kind", "myList").put("itemType", itemType).put("itemId", itemId).put("add", add))

    suspend fun setRating(itemType: String, itemId: Int, value: Int): Boolean =
        postState(JSONObject().put("kind", "rating").put("itemType", itemType).put("itemId", itemId).put("value", value))

    suspend fun setProgress(itemType: String, itemId: Int, position: Double, duration: Double, mediaFileId: Int?): Boolean =
        postState(
            JSONObject().put("kind", "progress").put("itemType", itemType).put("itemId", itemId)
                .put("position", position).put("duration", duration)
                .apply { if (mediaFileId != null) put("mediaFileId", mediaFileId) },
        )

    suspend fun recordWatchEvent(itemType: String, itemId: Int, eventKind: String, ratio: Double, seconds: Double): Boolean =
        postState(
            JSONObject().put("kind", "watchEvent").put("itemType", itemType).put("itemId", itemId)
                .put("eventKind", eventKind).put("ratio", ratio).put("seconds", seconds),
        )

    private suspend fun postState(body: JSONObject): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val req = authed(Request.Builder().url("$base/api/state").post(body.toString().toRequestBody(JSON)))
            client.newCall(req).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    // ---- playback ----------------------------------------------------------

    suspend fun decidePlay(fileId: Int, caps: ClientCaps, audioIdx: Int? = null, subtitleId: Int? = null): PlayDecision? =
        withContext(Dispatchers.IO) {
            val body = JSONObject().put("fileId", fileId).put("caps", caps.toJson())
            audioIdx?.let { body.put("audioIdx", it) }
            subtitleId?.let { body.put("subtitleId", it) }
            runCatching {
                val req = authed(Request.Builder().url("$base/api/play/decision").post(body.toString().toRequestBody(JSON)))
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return@use null
                    resp.body?.string()?.let { PlayDecision.from(JSONObject(it)) }
                }
            }.getOrNull()
        }

    suspend fun createSession(
        fileId: Int,
        caps: ClientCaps,
        audioIdx: Int? = null,
        subtitleId: Int? = null,
        deviceId: String = "android",
    ): PlaySession? = withContext(Dispatchers.IO) {
        val body = JSONObject().put("fileId", fileId).put("caps", caps.toJson()).put("deviceId", deviceId)
        audioIdx?.let { body.put("audioIdx", it) }
        subtitleId?.let { body.put("subtitleId", it) }
        runCatching {
            val req = authed(Request.Builder().url("$base/api/play/session").post(body.toString().toRequestBody(JSON)))
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                resp.body?.string()?.let { PlaySession.from(JSONObject(it)) }
            }
        }.getOrNull()
    }

    suspend fun endSession(sessionId: String) = withContext(Dispatchers.IO) {
        runCatching {
            val req = authed(Request.Builder().url("$base/api/play/session/${Uri.encode(sessionId)}").delete())
            client.newCall(req).execute().close()
        }
    }

    fun subtitleUrl(subtitleId: Int): String = absoluteUrl("/api/subs/$subtitleId")

    // ---- helpers -----------------------------------------------------------

    private suspend fun getJson(path: String): JSONObject = withContext(Dispatchers.IO) {
        val req = authed(Request.Builder().url("$base$path").get())
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: "{}"
            if (!resp.isSuccessful) throw ApiException(resp.code, text)
            JSONObject(text)
        }
    }

    private fun authed(builder: Request.Builder): Request = builder.build()

    class ApiException(val code: Int, val bodyText: String) : Exception("HTTP $code")

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()

        fun normalizeBase(raw: String): String {
            var v = raw.trim()
            if (v.isEmpty()) return v
            if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(v)) v = "http://$v"
            return v.trimEnd('/')
        }
    }
}

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
