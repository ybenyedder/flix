package local.flix.core.caps

import android.content.Context
import android.hardware.display.DisplayManager
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import android.util.Range
import android.view.Display
import androidx.core.content.getSystemService
import org.json.JSONArray
import org.json.JSONObject

// Mirrors the wire shape of ClientCaps in
// /home/pc/Documents/netflix/src/lib/flix/caps.ts — this is the NATIVE
// counterpart of that file's buildBrowserCaps(): instead of probing
// MediaSource.isTypeSupported() (what a browser tab can do), it queries
// android.media.MediaCodecList directly for what THIS DEVICE can decode in
// hardware/software, so decide() on the server almost always answers
// "direct" for MKV/HEVC/AV1/HDR files a browser could never play natively.

data class VideoCap(val codec: String, val profiles: List<String>? = null, val maxLevel: Int? = null, val bitDepth: Int? = null)

data class ClientCaps(
    val containers: List<String>,
    val video: List<VideoCap>,
    val audio: List<String>,
    val maxWidth: Int,
    val maxHeight: Int,
    val hdr: Boolean,
)

fun ClientCaps.toJson(): JSONObject {
    val o = JSONObject()
    o.put("containers", JSONArray(containers))
    val videoArr = JSONArray()
    for (v in video) {
        val vo = JSONObject().put("codec", v.codec)
        if (v.profiles != null) vo.put("profiles", JSONArray(v.profiles))
        if (v.maxLevel != null) vo.put("maxLevel", v.maxLevel)
        if (v.bitDepth != null) vo.put("bitDepth", v.bitDepth)
        videoArr.put(vo)
    }
    o.put("video", videoArr)
    o.put("audio", JSONArray(audio))
    o.put("maxWidth", maxWidth)
    o.put("maxHeight", maxHeight)
    o.put("hdr", hdr)
    return o
}

/** A safe, minimal fallback if MediaCodecList enumeration throws on some OEM
 *  ROM — degrades to "let the server transcode", never to "assume everything
 *  is supported" (which could hand the player an undecodable direct URL). */
val MINIMAL_CAPS = ClientCaps(containers = emptyList(), video = emptyList(), audio = emptyList(), maxWidth = 1280, maxHeight = 720, hdr = false)

// Containers ExoPlayer's built-in extractors (DefaultExtractorsFactory, media3
// 1.8.0) demux without help: Mp4Extractor (mp4/m4v and most .mov), Matroska
// (mkv/webm share the EBML container), TsExtractor, FlvExtractor, AviExtractor.
// Deliberately excludes "wmv" (no ASF extractor in media3) — those files fall
// through to server-side remux/transcode into HLS, which plays fine too.
private val NATIVE_CONTAINERS = listOf("mp4", "mkv", "webm", "ts", "flv", "avi", "mov")

private data class CodecProbe(val mime: String, val id: String)

private val VIDEO_PROBES = listOf(
    CodecProbe(android.media.MediaFormat.MIMETYPE_VIDEO_AVC, "h264"),
    CodecProbe(android.media.MediaFormat.MIMETYPE_VIDEO_HEVC, "hevc"),
    CodecProbe(android.media.MediaFormat.MIMETYPE_VIDEO_AV1, "av1"),
    CodecProbe(android.media.MediaFormat.MIMETYPE_VIDEO_VP9, "vp9"),
    CodecProbe(android.media.MediaFormat.MIMETYPE_VIDEO_VP8, "vp8"),
    CodecProbe(android.media.MediaFormat.MIMETYPE_VIDEO_MPEG4, "mpeg4"),
    CodecProbe(android.media.MediaFormat.MIMETYPE_VIDEO_MPEG2, "mpeg2video"),
)

private val AUDIO_PROBES = listOf(
    CodecProbe(android.media.MediaFormat.MIMETYPE_AUDIO_AAC, "aac"),
    CodecProbe(android.media.MediaFormat.MIMETYPE_AUDIO_AC3, "ac3"),
    CodecProbe(android.media.MediaFormat.MIMETYPE_AUDIO_EAC3, "eac3"),
    CodecProbe(android.media.MediaFormat.MIMETYPE_AUDIO_OPUS, "opus"),
    CodecProbe(android.media.MediaFormat.MIMETYPE_AUDIO_FLAC, "flac"),
    CodecProbe(android.media.MediaFormat.MIMETYPE_AUDIO_MPEG, "mp3"),
    CodecProbe(android.media.MediaFormat.MIMETYPE_AUDIO_VORBIS, "vorbis"),
    CodecProbe("audio/true-hd", "truehd"),
    CodecProbe("audio/vnd.dts", "dts"),
    CodecProbe("audio/vnd.dts.hd", "dts"),
)

private fun hasTenBitProfile(mime: String, profiles: Set<Int>): Boolean = when (mime) {
    android.media.MediaFormat.MIMETYPE_VIDEO_HEVC -> profiles.any {
        it == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10 ||
            it == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10 ||
            (Build.VERSION.SDK_INT >= 29 && it == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10Plus)
    }
    android.media.MediaFormat.MIMETYPE_VIDEO_VP9 -> profiles.any {
        it == MediaCodecInfo.CodecProfileLevel.VP9Profile2 ||
            it == MediaCodecInfo.CodecProfileLevel.VP9Profile3 ||
            it == MediaCodecInfo.CodecProfileLevel.VP9Profile2HDR ||
            it == MediaCodecInfo.CodecProfileLevel.VP9Profile3HDR
    }
    android.media.MediaFormat.MIMETYPE_VIDEO_AV1 -> profiles.any {
        it == MediaCodecInfo.CodecProfileLevel.AV1ProfileMain10 ||
            it == MediaCodecInfo.CodecProfileLevel.AV1ProfileMain10HDR10 ||
            it == MediaCodecInfo.CodecProfileLevel.AV1ProfileMain10HDR10Plus
    }
    else -> false
}

object NativeCaps {

    /** Enumerate this device's real decode capability via MediaCodecList and
     *  its HDR display support, so the server can answer "direct" for almost
     *  everything a set-top box / phone SoC can actually decode. Never throws —
     *  any enumeration failure degrades to [MINIMAL_CAPS]. */
    fun build(context: Context): ClientCaps = runCatching { buildInternal(context) }.getOrDefault(MINIMAL_CAPS)

    private fun buildInternal(context: Context): ClientCaps {
        val list = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }

        val video = mutableListOf<VideoCap>()
        var maxW = 1920
        var maxH = 1080

        for (probe in VIDEO_PROBES) {
            var supported = false
            var tenBit = false
            for (info in list) {
                if (probe.mime !in info.supportedTypes) continue
                supported = true
                val caps = runCatching { info.getCapabilitiesForType(probe.mime) }.getOrNull() ?: continue
                val profiles = caps.profileLevels?.map { it.profile }?.toSet() ?: emptySet()
                if (hasTenBitProfile(probe.mime, profiles)) tenBit = true
                val vcaps = caps.videoCapabilities
                if (vcaps != null) {
                    maxW = maxOf(maxW, safeUpper(vcaps.supportedWidths))
                    maxH = maxOf(maxH, safeUpper(vcaps.supportedHeights))
                }
            }
            if (supported) {
                // AV1 hardware/software decoders on Android are near-universally
                // 8/10-bit capable at the Main profile level even when the
                // profile-level list doesn't enumerate cleanly on some OEM ROMs.
                val bitDepth = when {
                    tenBit -> 10
                    probe.id == "av1" -> 10
                    else -> null
                }
                video.add(VideoCap(codec = probe.id, bitDepth = bitDepth))
            }
        }

        val audio = mutableListOf<String>()
        for (probe in AUDIO_PROBES) {
            if (list.any { probe.mime in it.supportedTypes }) audio.add(probe.id)
        }

        // Decode ceiling can exceed panel resolution (downscaled 4K is normal),
        // but never report LESS than the actual display so a device with no
        // usable video decoder info still gets a sane floor.
        val display = displaySize(context)
        maxW = maxOf(maxW, display.first)
        maxH = maxOf(maxH, display.second)

        val hdr = hasHdrDisplay(context)

        return ClientCaps(
            containers = NATIVE_CONTAINERS,
            video = video,
            audio = audio.distinct(),
            maxWidth = maxW,
            maxHeight = maxH,
            hdr = hdr,
        )
    }

    private fun safeUpper(range: Range<Int>?): Int = range?.upper ?: 0

    private fun displaySize(context: Context): Pair<Int, Int> = runCatching {
        val dm = context.getSystemService<DisplayManager>()
        val display = dm?.getDisplay(Display.DEFAULT_DISPLAY)
        val metrics = android.util.DisplayMetrics()
        @Suppress("DEPRECATION")
        display?.getRealMetrics(metrics)
        (metrics.widthPixels.takeIf { it > 0 } ?: 1920) to (metrics.heightPixels.takeIf { it > 0 } ?: 1080)
    }.getOrDefault(1920 to 1080)

    private fun hasHdrDisplay(context: Context): Boolean = runCatching {
        val dm = context.getSystemService<DisplayManager>()
        val display = dm?.getDisplay(Display.DEFAULT_DISPLAY) ?: return false
        val types = display.hdrCapabilities?.supportedHdrTypes ?: return false
        types.isNotEmpty()
    }.getOrDefault(false)
}
