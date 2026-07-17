package local.flix.core.model

import org.json.JSONArray
import org.json.JSONObject

// Plain Kotlin mirrors of the Flix server's JSON wire shapes (see
// /home/pc/Documents/netflix/src/server/library/repository.ts,
// src/server/reco/engine.ts, src/server/state/userState.ts and
// src/server/playback/decision.ts for the authoritative shapes). Parsed with
// android's built-in org.json — no kotlinx-serialization plugin, keeping the
// offline build dependency-free, same pattern as the sibling Auralis client.

// ---- small JSON helpers ----------------------------------------------------

internal fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key, null)
internal fun JSONObject.strOr(key: String, fallback: String): String = if (isNull(key)) fallback else optString(key, fallback)
internal fun JSONObject.intOrNull(key: String): Int? = if (has(key) && !isNull(key)) optInt(key) else null
internal fun JSONObject.longOrNull(key: String): Long? = if (has(key) && !isNull(key)) optLong(key) else null
internal fun JSONObject.doubleOrNull(key: String): Double? = if (has(key) && !isNull(key)) optDouble(key) else null
internal fun JSONObject.boolOr(key: String, fallback: Boolean): Boolean = if (has(key) && !isNull(key)) optBoolean(key, fallback) else fallback

internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
internal fun JSONArray.strings(): List<String> = (0 until length()).mapNotNull { if (isNull(it)) null else optString(it) }
internal fun JSONObject.stringArray(key: String): List<String> = optJSONArray(key)?.strings() ?: emptyList()

// ---- catalogue ---------------------------------------------------------

data class ActorRef(val name: String, val role: String?) {
    companion object {
        fun from(o: JSONObject) = ActorRef(name = o.strOr("name", ""), role = o.str("role"))
    }
}

/** Unified movie/show catalogue entry. The server exposes two distinct DTOs
 *  (CatalogMovie/CatalogShow) but they share almost every field a row/card
 *  needs to render, so one Kotlin type keyed by [type] avoids sealed-class
 *  ceremony throughout the UI layer (rows freely mix movies and shows). */
data class CatalogItem(
    val type: String, // "movie" | "show"
    val id: Int,
    val title: String,
    val sortTitle: String,
    val originalTitle: String?,
    val year: Int?,
    val duration: Double, // movies only; 0 for shows
    val synopsis: String?,
    val tagline: String?,
    val genres: List<String>,
    val actors: List<ActorRef>,
    val directors: List<String>, // movies only
    val studio: String?,
    val contentRating: String?,
    val status: String?, // shows only
    val posterHash: String?,
    val backdropHash: String?,
    val thumbHash: String?, // movies only
    val logoHash: String?,
    val seasonCount: Int?, // shows only
    val episodeCount: Int?, // shows only
    val addedAt: Long,
    val qualityHeight: Int?,
    val qualityHdr: Boolean,
) {
    val key: String get() = "$type:$id"
    val isMovie: Boolean get() = type == "movie"

    companion object {
        fun fromMovie(o: JSONObject): CatalogItem {
            val q = o.optJSONObject("quality")
            return CatalogItem(
                type = "movie",
                id = o.intOrNull("id") ?: 0,
                title = o.strOr("title", ""),
                sortTitle = o.strOr("sortTitle", ""),
                originalTitle = o.str("originalTitle"),
                year = o.intOrNull("year"),
                duration = o.doubleOrNull("duration") ?: 0.0,
                synopsis = o.str("synopsis"),
                tagline = o.str("tagline"),
                genres = o.stringArray("genres"),
                actors = o.optJSONArray("actors")?.objects()?.map { ActorRef.from(it) } ?: emptyList(),
                directors = o.stringArray("directors"),
                studio = o.str("studio"),
                contentRating = o.str("contentRating"),
                status = null,
                posterHash = o.str("posterHash"),
                backdropHash = o.str("backdropHash"),
                thumbHash = o.str("thumbHash"),
                logoHash = o.str("logoHash"),
                seasonCount = null,
                episodeCount = null,
                addedAt = o.longOrNull("addedAt") ?: 0L,
                qualityHeight = q?.intOrNull("height"),
                qualityHdr = q?.boolOr("hdr", false) ?: false,
            )
        }

        fun fromShow(o: JSONObject): CatalogItem {
            val q = o.optJSONObject("quality")
            return CatalogItem(
                type = "show",
                id = o.intOrNull("id") ?: 0,
                title = o.strOr("title", ""),
                sortTitle = o.strOr("sortTitle", ""),
                originalTitle = null,
                year = o.intOrNull("year"),
                duration = 0.0,
                synopsis = o.str("synopsis"),
                tagline = null,
                genres = o.stringArray("genres"),
                actors = o.optJSONArray("actors")?.objects()?.map { ActorRef.from(it) } ?: emptyList(),
                directors = emptyList(),
                studio = o.str("studio"),
                contentRating = o.str("contentRating"),
                status = o.str("status"),
                posterHash = o.str("posterHash"),
                backdropHash = o.str("backdropHash"),
                thumbHash = null,
                logoHash = o.str("logoHash"),
                seasonCount = o.intOrNull("seasonCount"),
                episodeCount = o.intOrNull("episodeCount"),
                addedAt = o.longOrNull("addedAt") ?: 0L,
                qualityHeight = q?.intOrNull("height"),
                qualityHdr = q?.boolOr("hdr", false) ?: false,
            )
        }
    }
}

data class ScanProgress(val status: String, val scannedAt: String?)

data class LibrarySnapshot(
    val movies: List<CatalogItem>,
    val shows: List<CatalogItem>,
    val mediaDir: String,
    val scannedAt: String?,
    val countMovies: Int,
    val countShows: Int,
    val countEpisodes: Int,
    val scanStatus: String,
) {
    val byKey: Map<String, CatalogItem> by lazy { (movies + shows).associateBy { it.key } }

    companion object {
        val EMPTY = LibrarySnapshot(emptyList(), emptyList(), "", null, 0, 0, 0, "idle")

        fun from(o: JSONObject): LibrarySnapshot {
            val scan = o.optJSONObject("scan")
            return LibrarySnapshot(
                movies = o.optJSONArray("movies")?.objects()?.map { CatalogItem.fromMovie(it) } ?: emptyList(),
                shows = o.optJSONArray("shows")?.objects()?.map { CatalogItem.fromShow(it) } ?: emptyList(),
                mediaDir = o.strOr("mediaDir", ""),
                scannedAt = o.str("scannedAt"),
                countMovies = o.intOrNull("countMovies") ?: 0,
                countShows = o.intOrNull("countShows") ?: 0,
                countEpisodes = o.intOrNull("countEpisodes") ?: 0,
                scanStatus = scan?.strOr("status", "idle") ?: "idle",
            )
        }
    }
}

// ---- item detail (files/streams/subtitles) ---------------------------------

data class StreamInfo(
    val id: Int,
    val streamIndex: Int,
    val type: String, // video|audio|subtitle
    val codec: String?,
    val profile: String?,
    val level: Int?,
    val width: Int?,
    val height: Int?,
    val bitDepth: Int?,
    val frameRate: Double?,
    val hdrFormat: String?,
    val channels: Int?,
    val channelLayout: String?,
    val sampleRate: Int?,
    val language: String?,
    val title: String?,
    val bitrate: Int?,
    val isDefault: Boolean,
    val isForced: Boolean,
    val attachedPic: Boolean,
) {
    companion object {
        fun from(o: JSONObject) = StreamInfo(
            id = o.intOrNull("id") ?: 0,
            streamIndex = o.intOrNull("streamIndex") ?: 0,
            type = o.strOr("type", "video"),
            codec = o.str("codec"),
            profile = o.str("profile"),
            level = o.intOrNull("level"),
            width = o.intOrNull("width"),
            height = o.intOrNull("height"),
            bitDepth = o.intOrNull("bitDepth"),
            frameRate = o.doubleOrNull("frameRate"),
            hdrFormat = o.str("hdrFormat"),
            channels = o.intOrNull("channels"),
            channelLayout = o.str("channelLayout"),
            sampleRate = o.intOrNull("sampleRate"),
            language = o.str("language"),
            title = o.str("title"),
            bitrate = o.intOrNull("bitrate"),
            isDefault = o.boolOr("isDefault", false),
            isForced = o.boolOr("isForced", false),
            attachedPic = o.boolOr("attachedPic", false),
        )
    }
}

data class SubtitleTrackInfo(
    val id: Int,
    val streamIndex: Int?,
    val source: String, // embedded|external
    val language: String?,
    val title: String?,
    val isForced: Boolean,
    val isSdh: Boolean,
    val format: String?,
    val isText: Boolean,
) {
    companion object {
        fun from(o: JSONObject) = SubtitleTrackInfo(
            id = o.intOrNull("id") ?: 0,
            streamIndex = o.intOrNull("streamIndex"),
            source = o.strOr("source", "embedded"),
            language = o.str("language"),
            title = o.str("title"),
            isForced = o.boolOr("isForced", false),
            isSdh = o.boolOr("isSdh", false),
            format = o.str("format"),
            isText = o.boolOr("isText", true),
        )
    }
}

data class MediaFileInfo(
    val id: Int,
    val label: String,
    val size: Long,
    val duration: Double,
    val container: String?,
    val bitrate: Int?,
    val version: String?,
    val streams: List<StreamInfo>,
    val subtitles: List<SubtitleTrackInfo>,
) {
    val videoStream: StreamInfo? get() = streams.firstOrNull { it.type == "video" && !it.attachedPic }

    companion object {
        fun from(o: JSONObject) = MediaFileInfo(
            id = o.intOrNull("id") ?: 0,
            label = o.strOr("label", ""),
            size = o.longOrNull("size") ?: 0L,
            duration = o.doubleOrNull("duration") ?: 0.0,
            container = o.str("container"),
            bitrate = o.intOrNull("bitrate"),
            version = o.str("version"),
            streams = o.optJSONArray("streams")?.objects()?.map { StreamInfo.from(it) } ?: emptyList(),
            subtitles = o.optJSONArray("subtitles")?.objects()?.map { SubtitleTrackInfo.from(it) } ?: emptyList(),
        )
    }
}

data class MovieDetail(val item: CatalogItem, val files: List<MediaFileInfo>) {
    companion object {
        fun from(o: JSONObject) = MovieDetail(
            item = CatalogItem.fromMovie(o),
            files = o.optJSONArray("files")?.objects()?.map { MediaFileInfo.from(it) } ?: emptyList(),
        )
    }
}

data class EpisodeDetail(
    val id: Int,
    val seasonId: Int,
    val episodeNumber: Int,
    val episodeEnd: Int?,
    val title: String?,
    val synopsis: String?,
    val airDate: String?,
    val duration: Double,
    val thumbHash: String?,
    val files: List<MediaFileInfo>,
) {
    companion object {
        fun from(o: JSONObject) = EpisodeDetail(
            id = o.intOrNull("id") ?: 0,
            seasonId = o.intOrNull("seasonId") ?: 0,
            episodeNumber = o.intOrNull("episodeNumber") ?: 0,
            episodeEnd = o.intOrNull("episodeEnd"),
            title = o.str("title"),
            synopsis = o.str("synopsis"),
            airDate = o.str("airDate"),
            duration = o.doubleOrNull("duration") ?: 0.0,
            thumbHash = o.str("thumbHash"),
            files = o.optJSONArray("files")?.objects()?.map { MediaFileInfo.from(it) } ?: emptyList(),
        )
    }
}

data class SeasonDetail(
    val id: Int,
    val seasonNumber: Int,
    val title: String?,
    val posterHash: String?,
    val episodes: List<EpisodeDetail>,
) {
    companion object {
        fun from(o: JSONObject) = SeasonDetail(
            id = o.intOrNull("id") ?: 0,
            seasonNumber = o.intOrNull("seasonNumber") ?: 0,
            title = o.str("title"),
            posterHash = o.str("posterHash"),
            episodes = o.optJSONArray("episodes")?.objects()?.map { EpisodeDetail.from(it) } ?: emptyList(),
        )
    }
}

data class ShowDetail(val item: CatalogItem, val seasons: List<SeasonDetail>) {
    companion object {
        fun from(o: JSONObject) = ShowDetail(
            item = CatalogItem.fromShow(o),
            seasons = o.optJSONArray("seasons")?.objects()?.map { SeasonDetail.from(it) } ?: emptyList(),
        )
    }
}

// ---- recommendations --------------------------------------------------------

data class ItemRef(val type: String, val id: Int) {
    val key: String get() = "$type:$id"

    companion object {
        fun from(o: JSONObject) = ItemRef(type = o.strOr("type", "movie"), id = o.intOrNull("id") ?: 0)
    }
}

data class RecoRow(val id: String, val title: String, val items: List<ItemRef>) {
    companion object {
        fun from(o: JSONObject) = RecoRow(
            id = o.strOr("id", ""),
            title = o.strOr("title", ""),
            items = o.optJSONArray("items")?.objects()?.map { ItemRef.from(it) } ?: emptyList(),
        )
    }
}

data class RecommendResult(val billboard: ItemRef?, val rows: List<RecoRow>, val matchScores: Map<String, Int>) {
    companion object {
        val EMPTY = RecommendResult(null, emptyList(), emptyMap())

        fun from(o: JSONObject): RecommendResult {
            val scores = HashMap<String, Int>()
            o.optJSONObject("matchScores")?.let { m -> m.keys().forEach { k -> scores[k] = m.optInt(k) } }
            return RecommendResult(
                billboard = o.optJSONObject("billboard")?.let { ItemRef.from(it) },
                rows = o.optJSONArray("rows")?.objects()?.map { RecoRow.from(it) } ?: emptyList(),
                matchScores = scores,
            )
        }
    }
}

// ---- per-profile state -------------------------------------------------------

data class MyListEntry(val itemType: String, val itemId: Int) {
    val key: String get() = "$itemType:$itemId"

    companion object {
        fun from(o: JSONObject) = MyListEntry(o.strOr("itemType", "movie"), o.intOrNull("itemId") ?: 0)
    }
}

data class RatingEntry(val itemType: String, val itemId: Int, val value: Int) {
    val key: String get() = "$itemType:$itemId"

    companion object {
        fun from(o: JSONObject) = RatingEntry(o.strOr("itemType", "movie"), o.intOrNull("itemId") ?: 0, o.intOrNull("value") ?: 0)
    }
}

data class ProgressSummary(
    val itemType: String, // movie|episode
    val itemId: Int,
    val mediaFileId: Int?,
    val position: Double,
    val duration: Double,
    val watched: Boolean,
    val updatedAt: Long,
    val topType: String, // movie|show
    val topId: Int,
    val title: String,
    val subtitle: String?,
    val posterHash: String?,
    val backdropHash: String?,
    val thumbHash: String?,
) {
    val ratio: Double get() = if (duration > 0) (position / duration).coerceIn(0.0, 1.0) else 0.0

    companion object {
        fun from(o: JSONObject) = ProgressSummary(
            itemType = o.strOr("itemType", "movie"),
            itemId = o.intOrNull("itemId") ?: 0,
            mediaFileId = o.intOrNull("mediaFileId"),
            position = o.doubleOrNull("position") ?: 0.0,
            duration = o.doubleOrNull("duration") ?: 0.0,
            watched = o.boolOr("watched", false),
            updatedAt = o.longOrNull("updatedAt") ?: 0L,
            topType = o.strOr("topType", "movie"),
            topId = o.intOrNull("topId") ?: 0,
            title = o.strOr("title", ""),
            subtitle = o.str("subtitle"),
            posterHash = o.str("posterHash"),
            backdropHash = o.str("backdropHash"),
            thumbHash = o.str("thumbHash"),
        )
    }
}

data class UserState(val myList: List<MyListEntry>, val ratings: List<RatingEntry>, val progress: List<ProgressSummary>) {
    companion object {
        val EMPTY = UserState(emptyList(), emptyList(), emptyList())

        fun from(o: JSONObject) = UserState(
            myList = o.optJSONArray("myList")?.objects()?.map { MyListEntry.from(it) } ?: emptyList(),
            ratings = o.optJSONArray("ratings")?.objects()?.map { RatingEntry.from(it) } ?: emptyList(),
            progress = o.optJSONArray("progress")?.objects()?.map { ProgressSummary.from(it) } ?: emptyList(),
        )
    }
}

// ---- auth --------------------------------------------------------------

data class ProfileRef(val username: String, val avatar: String, val isKids: Boolean) {
    companion object {
        fun from(o: JSONObject) = ProfileRef(o.strOr("username", ""), o.strOr("avatar", "red"), o.boolOr("isKids", false))
    }
}

data class AuthResult(
    val ok: Boolean,
    val token: String?,
    val username: String?,
    val isAdmin: Boolean,
    val isKids: Boolean,
    val avatar: String,
    val defaultPassword: Boolean,
    val error: String?,
) {
    companion object {
        fun from(o: JSONObject, fallbackUsername: String? = null) = AuthResult(
            ok = o.boolOr("ok", false),
            token = o.str("token"),
            username = o.str("username") ?: fallbackUsername,
            isAdmin = o.boolOr("isAdmin", false),
            isKids = o.boolOr("isKids", false),
            avatar = o.strOr("avatar", "red"),
            defaultPassword = o.boolOr("defaultPassword", false),
            error = o.str("error"),
        )
        fun failure(message: String) = AuthResult(false, null, null, false, false, "red", false, message)
    }
}

// ---- playback decision -------------------------------------------------------

data class DecisionAudioTrack(
    val id: Int,
    val streamIndex: Int,
    val language: String?,
    val title: String?,
    val codec: String?,
    val channels: Int?,
    val channelLayout: String?,
    val isDefault: Boolean,
    val supported: Boolean,
) {
    companion object {
        fun from(o: JSONObject) = DecisionAudioTrack(
            id = o.intOrNull("id") ?: 0,
            streamIndex = o.intOrNull("streamIndex") ?: 0,
            language = o.str("language"),
            title = o.str("title"),
            codec = o.str("codec"),
            channels = o.intOrNull("channels"),
            channelLayout = o.str("channelLayout"),
            isDefault = o.boolOr("isDefault", false),
            supported = o.boolOr("supported", false),
        )
    }
}

data class DecisionSubtitle(
    val id: Int,
    val streamIndex: Int?,
    val source: String,
    val language: String?,
    val title: String?,
    val isForced: Boolean,
    val isSdh: Boolean,
    val format: String?,
    val requiresBurnIn: Boolean,
) {
    companion object {
        fun from(o: JSONObject) = DecisionSubtitle(
            id = o.intOrNull("id") ?: 0,
            streamIndex = o.intOrNull("streamIndex"),
            source = o.strOr("source", "embedded"),
            language = o.str("language"),
            title = o.str("title"),
            isForced = o.boolOr("isForced", false),
            isSdh = o.boolOr("isSdh", false),
            format = o.str("format"),
            requiresBurnIn = o.boolOr("requiresBurnIn", false),
        )
    }
}

data class PlayDecision(
    val mode: String, // direct|remux|transcode
    val fileId: Int,
    val reason: String,
    val url: String?,
    val duration: Double,
    val container: String,
    val videoCodec: String?,
    val audioStreamIndex: Int?,
    val subtitleId: Int?,
    val requiresBurnIn: Boolean,
    val audioTracks: List<DecisionAudioTrack>,
    val subtitles: List<DecisionSubtitle>,
) {
    companion object {
        fun from(o: JSONObject) = PlayDecision(
            mode = o.strOr("mode", "transcode"),
            fileId = o.intOrNull("fileId") ?: 0,
            reason = o.strOr("reason", ""),
            url = o.str("url"),
            duration = o.doubleOrNull("duration") ?: 0.0,
            container = o.strOr("container", ""),
            videoCodec = o.str("videoCodec"),
            audioStreamIndex = o.intOrNull("audioStreamIndex"),
            subtitleId = o.intOrNull("subtitleId"),
            requiresBurnIn = o.boolOr("requiresBurnIn", false),
            audioTracks = o.optJSONArray("audioTracks")?.objects()?.map { DecisionAudioTrack.from(it) } ?: emptyList(),
            subtitles = o.optJSONArray("subtitles")?.objects()?.map { DecisionSubtitle.from(it) } ?: emptyList(),
        )
    }
}

/** Result of POST /api/play/session — either an immediate direct-play URL or
 *  an HLS session the player must poll segments from. */
sealed class PlaySession {
    data class Direct(val url: String) : PlaySession()
    data class Hls(val sessionId: String, val playlistUrl: String, val mode: String) : PlaySession()

    companion object {
        fun from(o: JSONObject): PlaySession? {
            val mode = o.str("mode") ?: return null
            return if (mode == "direct") {
                val url = o.str("url") ?: return null
                Direct(url)
            } else {
                val sessionId = o.str("sessionId") ?: return null
                val playlistUrl = o.str("playlistUrl") ?: return null
                Hls(sessionId, playlistUrl, mode)
            }
        }
    }
}
