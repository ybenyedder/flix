package local.flix.core.playback

import androidx.media3.common.C
import androidx.media3.common.Tracks
import local.flix.core.model.DecisionAudioTrack
import local.flix.core.model.DecisionSubtitle

// ---- server-track -> media3-group mapping ----------------------------------
// The server's decision lists (audioTracks / subtitles) are NOT in the same
// order — nor even the same set — as the track groups ExoPlayer actually
// exposes: sideloaded subs live in their own groups, HLS renditions arrive in
// playlist order, and burn-in-only subs aren't present as tracks at all.
// Passing a raw list ordinal therefore selects the wrong group. These helpers
// resolve by IDENTITY against the live [Tracks] instead — a stable format id
// for subs we sideloaded ourselves, the language for everything else — and
// return null (never a guess) when identity can't settle it, so callers fall
// back to the server-exact path (recreate the session with audioIdx) rather
// than switching to the wrong track. Shared by :app and :tv.

/** Stable [androidx.media3.common.Format.id] we stamp on every sideloaded
 *  subtitle configuration (media3 propagates SubtitleConfiguration.id to the
 *  resulting Format), so a server subtitle row can be matched back to its
 *  media3 text group exactly, even when several tracks share a language
 *  (full vs forced vs SDH are routinely all "fr"). */
fun subtitleFormatId(subtitleId: Int): String = "flix-sub-$subtitleId"

/** Media3 audio group for a chosen server audio track, matched on
 *  (normalised) language. Null when the match is missing OR ambiguous
 *  (several groups share the language): the caller must then ask the server
 *  for the track by `audioIdx` — the only actor that knows stream indices —
 *  instead of risking a switch to the wrong same-language track. */
fun resolveAudioGroup(tracks: Tracks, audio: DecisionAudioTrack): Tracks.Group? {
    val groups = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
    return groups.filter { sameLanguage(it.getTrackFormat(0).language, audio.language) }.singleOrNull()
}

/** Media3 text group for a chosen server subtitle: first by the stable
 *  sideload id (exact — see [subtitleFormatId]), then by (normalised)
 *  language for in-container embedded tracks the client did not sideload.
 *  Null when the track isn't in the current [Tracks] at all (e.g. a burn-in
 *  sub, which lives in the video pixels, not in a text track). */
fun resolveTextGroup(tracks: Tracks, sub: DecisionSubtitle): Tracks.Group? {
    val groups = tracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }
    val id = subtitleFormatId(sub.id)
    groups.firstOrNull { it.getTrackFormat(0).id == id }?.let { return it }
    return groups.firstOrNull { sameLanguage(it.getTrackFormat(0).language, sub.language) }
}

/** ISO-639 codes aren't stored uniformly across a real library (ffprobe emits
 *  639-2 "fre"/"fra", while media3 normalises container/HLS tags to 639-1
 *  "fr") — the server's decision.ts flags the very same issue — so compare on
 *  a folded 639-1 code. */
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
