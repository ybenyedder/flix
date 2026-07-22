"use client";

// Full-screen player: resolves a PlaybackRequest (movie / show "play next up"
// / specific episode) into an actual media file, asks the server to decide
// direct/remux/transcode (POST /api/play/decision — the frontend NEVER
// recomputes that decision itself), then either points <video> straight at
// /api/stream/<id> or spins up an HLS session (native on Safari, hls.js
// everywhere else) and follows its playlist. Handles resume, periodic +
// teardown progress persistence, watch/abandon signals, track switching
// (which — per decide()'s rules — always means a fresh remux session for
// audio, and only for bitmap subtitles) and auto-advance to the next episode.
// Chapters from the decision drive the « Passer l'intro/le récap » button and
// the NextEpisodeCard trigger (start of the end-credits chapter, falling back
// to duration-30s); trickplay sprite metadata is fetched best-effort per file
// and feeds the seekbar's hover/scrub thumbnails.
//
// Per-profile language preferences ride the decision (the server preselects
// the preferred audio/TEXT-subtitle tracks when nothing explicit is asked),
// and every explicit TrackMenu pick is persisted fire-and-forget to
// /api/settings. A version picked in the DetailModal arrives as
// request.mediaFileId and overrides the default files[0] pick — for that
// item only; auto-advance reverts to the default.
//
// One <PlayerSession> per usePlayerStore().request.nonce (see the `key`
// below) — every "Lecture" click, even on the same title, gets fully fresh
// internal state rather than reusing whatever the last viewing left behind.

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type Hls from "hls.js";
import { api } from "@/lib/flix/api";
import { buildBrowserCaps } from "@/lib/flix/caps";
import { getDeviceId } from "@/lib/flix/device";
import type { MovieDetail, ShowDetail, EpisodeDetail, SeasonDetail, PlaybackDecision, PlaybackSessionResponse, PlaybackSubtitleTrack, TrickplayMeta } from "@/lib/flix/types";
import {
  computeResumeStart,
  classifyWatchEvent,
  findNextEpisode,
  pickNextUpEpisode,
  clampVolume,
  decideHlsRecovery,
  serializeVolume,
  chapterAt,
  classifyChapter,
  skipTargetFor,
  nextUpTriggerTime,
  SKIP_BUTTON_SECONDS,
  VOLUME_STORAGE_KEY,
  type HlsRecoveryAttempts,
} from "@/lib/flix/playerLogic";
import { usePlayerStore, pickPlaybackFile, type PlaybackRequest } from "@/store/player";
import { useStateStore } from "@/store/state";
import { useWatchPartyStore } from "@/store/watchParty";
import { computeLivePosition, shouldResync, targetMatches, type PartyControlAction } from "@/lib/flix/party";
import { PlayerControls } from "./PlayerControls";
import { TrackMenu } from "./TrackMenu";
import { NextEpisodeCard } from "./NextEpisodeCard";
import { PartyOverlay } from "./PartyOverlay";
import { useFullscreenSync } from "./player/useFullscreenSync";
import { usePlayerKeyboard } from "./player/usePlayerKeyboard";
import { useAutoHideControls } from "./player/useAutoHideControls";
import { useVolumePersistence } from "./player/useVolumePersistence";

interface ResolvedItem {
  itemType: "movie" | "episode";
  itemId: number;
  mediaFileId: number;
  duration: number;
  title: string;
  subtitle: string | null;
  topId: number;
  seasons: SeasonDetail[] | null;
}

interface Target {
  kind: "movie" | "show" | "episode";
  id: number;
  topId?: number;
}

function labelFor(episode: EpisodeDetail, season: SeasonDetail | undefined): string {
  const seasonPart = season ? `S${season.seasonNumber}` : "S?";
  return `${seasonPart} : É${episode.episodeNumber}${episode.title ? ` — ${episode.title}` : ""}`;
}

/** Reads the stored progress store directly (rather than subscribing) since
 *  this only needs to run once per resolved item, right when the media
 *  pipeline is (re)built — not on every progress-store update. */
function resolveResumeOffset(item: ResolvedItem): number {
  const row = useStateStore.getState().progress.find((p) => p.itemType === item.itemType && p.itemId === item.itemId);
  if (!row) return 0;
  return computeResumeStart(row.position, item.duration || row.duration);
}

/** In a watch party, a newly-loaded file must open at the SHARED position (where
 *  the room is right now), not the viewer's personal resume — so a guest joins
 *  the film already in progress at the exact same frame. Returns null when no
 *  party is active or the loaded item isn't the room's current title (then the
 *  personal resume applies as usual). */
function resolvePartyStart(item: ResolvedItem): number | null {
  const st = useWatchPartyStore.getState();
  if (!st.active || !st.playback.target) return null;
  if (!targetMatches(st.playback.target, { kind: item.itemType, id: item.itemId, mediaFileId: item.mediaFileId })) return null;
  return st.livePosition();
}

const MEDIA_ERROR_MESSAGE = "Impossible de lire cette vidéo";

/** Track language → persistable preference value. The server only accepts
 *  2-3 lowercase letters (see src/server/state/settings.ts), so a missing or
 *  odd tag simply isn't persisted rather than round-tripping garbage. */
function prefLangOf(language: string | null | undefined): string | null {
  const lang = language?.trim().toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(lang) ? lang : null;
}

function writeStoredVolume(volume: number, muted: boolean): void {
  try {
    window.localStorage.setItem(VOLUME_STORAGE_KEY, serializeVolume(volume, muted));
  } catch {
    /* stockage indisponible (mode privé, quota) — non bloquant */
  }
}

export function PlayerView() {
  const request = usePlayerStore((s) => s.request);
  if (!request) return null;
  return <PlayerSession key={request.nonce} initial={request} />;
}

function PlayerSession({ initial }: { initial: PlaybackRequest }) {
  const [target, setTarget] = useState<Target>({ kind: initial.kind, id: initial.id, topId: initial.topId });
  const [current, setCurrent] = useState<ResolvedItem | null>(null);
  const [nextEpisode, setNextEpisode] = useState<EpisodeDetail | null>(null);
  const [decision, setDecision] = useState<PlaybackDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by « Réessayer » to force a rebuild of the media pipeline after a
  // playback error (the pipeline effect lists it in its deps).
  const [retryNonce, setRetryNonce] = useState(0);
  const [buffering, setBuffering] = useState(false);

  const [audioIdx, setAudioIdx] = useState<number | undefined>(undefined);
  const [selectedSubtitle, setSelectedSubtitle] = useState<PlaybackSubtitleTrack | null>(null);
  // Trickplay sprite metadata — best-effort (null when FLIX_TRICKPLAY is off
  // or the sprite isn't generated yet; no spinner, no error surface, the
  // seekbar just shows a plain timecode tooltip instead). Tagged with the
  // fileId it was fetched for, so a stale sprite is derived away at render
  // time during an episode auto-advance instead of reset via setState-in-effect.
  const [trickplay, setTrickplay] = useState<{ fileId: number; meta: TrickplayMeta } | null>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showTrackMenu, setShowTrackMenu] = useState(false);
  const [nextUpVisible, setNextUpVisible] = useState(false);
  const [nextUpDismissed, setNextUpDismissed] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const currentRef = useRef<ResolvedItem | null>(null);
  const posRef = useRef({ time: 0, duration: 0 });
  const pendingResumeRef = useRef<number | null>(null);
  const finalizedForRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const textTrackRef = useRef<HTMLTrackElement | null>(null);
  // Re-arms the auto-hide timer of the controls overlay; set by the auto-hide
  // effect so keyboard shortcuts can surface the controls (volume feedback)
  // without duplicating the timer logic.
  const controlsResetRef = useRef<() => void>(() => {});
  // True once the user picked a subtitle in the TrackMenu (incl. « Désactivés »)
  // — from then on the server-side preference preselection carried by each new
  // decision must never override that explicit choice. Reset on auto-advance
  // so the (just-persisted) preference applies afresh to the next episode.
  const subtitleChosenRef = useRef(false);
  // Mirror of showControls for the video tap handler below — an event handler
  // closing over the state would act on a stale value right after the
  // container's own click listener surfaced the controls.
  const showControlsRef = useRef(true);
  // One automatic pipeline rebuild per item on a fatal network error. The
  // server purges an idle HLS session after ~5 min — a long pause then 404s
  // every segment on resume; recreating the session (fresh decide(), so the
  // direct > remux > transcode order is re-applied) resumes seamlessly instead
  // of surfacing the error UI.
  const autoSessionRetryRef = useRef(false);

  const burnInSubtitleId = selectedSubtitle?.requiresBurnIn ? selectedSubtitle.id : null;
  const activeTextSubtitle = selectedSubtitle && !selectedSubtitle.requiresBurnIn ? selectedSubtitle : null;

  useEffect(() => {
    currentRef.current = current;
    finalizedForRef.current = null;
    // A new item invalidates the last measured position — keeping the old
    // one would send a bogus final state (e.g. a false "complete") for the
    // item still loading if the player closes mid-load (auto-advance).
    posRef.current = { time: 0, duration: 0 };
    autoSessionRetryRef.current = false;
  }, [current]);

  useEffect(() => {
    showControlsRef.current = showControls;
  }, [showControls]);

  const close = useCallback(() => usePlayerStore.getState().close(), []);

  // Watch-party role. Guests follow the host's title and never auto-advance on
  // their own; both host and guests reconcile transport to the shared state.
  const partyActive = useWatchPartyStore((s) => s.active);
  const partyIsHost = useWatchPartyStore((s) => s.isHost());
  const partyIsGuest = partyActive && !partyIsHost;

  // --- resolve `target` -> a playable item (movie file, or a specific/next-up episode) ---
  useEffect(() => {
    let alive = true;
    // The version (specific media file) chosen in the DetailModal only applies
    // to the very item the player was opened on — auto-advance sets a new
    // target id, so the next episode reverts to the default pick. It survives
    // retries and track changes because `initial` is stable for the whole
    // session (PlayerSession is keyed on the request nonce).
    const preferredFileId = target.kind === initial.kind && target.id === initial.id ? initial.mediaFileId : undefined;
    (async () => {
      setError(null);
      try {
        if (target.kind === "movie") {
          const detail = await api.get<MovieDetail>(`/api/items/movie/${target.id}`);
          const file = pickPlaybackFile(detail.files, preferredFileId);
          if (!file) throw new Error("Aucun fichier disponible pour ce film");
          if (!alive) return;
          setCurrent({ itemType: "movie", itemId: detail.id, mediaFileId: file.id, duration: file.duration || detail.duration, title: detail.title, subtitle: null, topId: detail.id, seasons: null });
          setNextEpisode(null);
        } else {
          const showId = target.kind === "episode" ? target.topId : target.id;
          if (!showId) throw new Error("Série introuvable");
          const show = await api.get<ShowDetail>(`/api/items/show/${showId}`);
          if (!alive) return;
          const episode =
            target.kind === "episode"
              ? (show.seasons.flatMap((s) => s.episodes).find((e) => e.id === target.id) ?? null)
              : pickNextUpEpisode(show.seasons, useStateStore.getState().progress.filter((p) => p.topType === "show" && p.topId === showId));
          if (!episode) throw new Error("Aucun épisode disponible pour cette série");
          const file = pickPlaybackFile(episode.files, preferredFileId);
          if (!file) throw new Error("Aucun fichier disponible pour cet épisode");
          const season = show.seasons.find((s) => s.id === episode.seasonId);
          setCurrent({
            itemType: "episode",
            itemId: episode.id,
            mediaFileId: file.id,
            duration: file.duration || episode.duration,
            title: show.title,
            subtitle: labelFor(episode, season),
            topId: showId,
            seasons: show.seasons,
          });
          setNextEpisode(findNextEpisode(show.seasons, episode.id));
        }
        setNextUpVisible(false);
        setNextUpDismissed(false);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Lecture impossible");
      }
    })();
    return () => {
      alive = false;
    };
    // `initial` is identity-stable for the lifetime of this PlayerSession.
  }, [target, initial]);

  // --- trickplay metadata for the current file (best-effort, absent-safe) ---
  useEffect(() => {
    const fileId = current?.mediaFileId;
    if (!fileId) return;
    let alive = true;
    void api
      .get<TrickplayMeta>(`/api/trickplay/${fileId}`)
      .then((meta) => {
        if (alive) setTrickplay({ fileId, meta });
      })
      .catch(() => {
        /* pas de sprite (flag désactivé / pas encore généré) — aperçu simple */
      });
    return () => {
      alive = false;
    };
  }, [current?.mediaFileId]);
  const trickplayMeta = trickplay && trickplay.fileId === current?.mediaFileId ? trickplay.meta : null;

  // --- build the media pipeline for the current file + track selection ---
  useEffect(() => {
    if (!current) return;
    let alive = true;
    let localHls: Hls | null = null;
    let localSessionId: string | null = null;
    let cleanupLoadedMeta: (() => void) | null = null;

    (async () => {
      setError(null);
      setDecision(null);
      const caps = buildBrowserCaps();
      let dec: PlaybackDecision;
      try {
        dec = await api.post<PlaybackDecision>("/api/play/decision", { fileId: current.mediaFileId, caps, audioIdx, subtitleId: burnInSubtitleId ?? undefined });
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Décision de lecture impossible");
        return;
      }
      if (!alive) return;
      setDecision(dec);

      // Server-side language preselection: the decision can carry a
      // preselected TEXT subtitle (pref.subtitleLang). Applied only until the
      // user makes an explicit choice in the TrackMenu — that pick (incl.
      // « Désactivés ») must never be overridden by a later re-decision
      // (audio track change, retry). Never a burn-in track: decide() only
      // preselects text subtitles, so this can't retrigger the pipeline.
      if (!subtitleChosenRef.current && dec.subtitleId !== null) {
        const preselected = dec.subtitles.find((s) => s.id === dec.subtitleId && !s.requiresBurnIn);
        if (preselected) setSelectedSubtitle(preselected);
      }

      const video = videoRef.current;
      if (!video) return;

      if (video.src) {
        video.removeAttribute("src");
        video.load();
      }

      if (dec.mode === "direct") {
        video.src = dec.url ?? `/api/stream/${current.mediaFileId}`;
      } else {
        let session: PlaybackSessionResponse;
        try {
          session = await api.post<PlaybackSessionResponse>("/api/play/session", {
            fileId: current.mediaFileId,
            caps,
            // The session recomputes decide() itself WITHOUT the profile's
            // language prefs — forward the decision's resolved audio track so
            // a preference-driven pick survives into the actual remux (a
            // no-op when no preference applied: the resolved index is then
            // the default track anyway).
            audioIdx: audioIdx ?? dec.audioStreamIndex ?? undefined,
            subtitleId: burnInSubtitleId ?? undefined,
            deviceId: getDeviceId(),
          });
        } catch (err) {
          if (alive) setError(err instanceof Error ? err.message : "Session de lecture impossible");
          return;
        }
        if (!session.sessionId || !session.playlistUrl) {
          if (alive) setError("Réponse de session invalide");
          return;
        }
        if (!alive) {
          void api.del(`/api/play/session/${session.sessionId}`).catch(() => {});
          return;
        }
        localSessionId = session.sessionId;

        const nativeHls = video.canPlayType("application/vnd.apple.mpegurl") !== "";
        if (nativeHls) {
          video.src = session.playlistUrl;
        } else {
          const { default: HlsCtor } = await import("hls.js");
          if (!alive) {
            void api.del(`/api/play/session/${session.sessionId}`).catch(() => {});
            return;
          }
          if (!HlsCtor.isSupported()) {
            setError("La lecture HLS n'est pas prise en charge par ce navigateur");
            return;
          }
          const hls = new HlsCtor({
            enableWorker: false,
            xhrSetup: (xhr) => {
              const token = api.token();
              if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
            },
          });
          localHls = hls;
          hlsRef.current = hls;
          // One recovery attempt per error family and per pipeline: a fatal
          // network error gets one startLoad(), a fatal media error one
          // recoverMediaError(); anything beyond that surfaces the error UI.
          const recoveryAttempts: HlsRecoveryAttempts = { networkTried: false, mediaTried: false };
          hls.on(HlsCtor.Events.ERROR, (_event, data) => {
            if (!data.fatal || !alive) return;
            const action = decideHlsRecovery(data.type, recoveryAttempts);
            if (action === "startLoad") {
              recoveryAttempts.networkTried = true;
              hls.startLoad();
            } else if (action === "recoverMediaError") {
              recoveryAttempts.mediaTried = true;
              hls.recoverMediaError();
            } else if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR && !autoSessionRetryRef.current) {
              // hls.js is out of recovery moves and the network says the
              // session is gone (idle purge during a long pause). Rebuild the
              // whole pipeline once, resuming at the current position — same
              // sequence as the « Réessayer » button's pipeline branch.
              autoSessionRetryRef.current = true;
              if (posRef.current.time > 0) pendingResumeRef.current = posRef.current.time;
              setError(null);
              setRetryNonce((n) => n + 1);
            } else {
              setError(MEDIA_ERROR_MESSAGE);
            }
          });
          hls.loadSource(session.playlistUrl);
          hls.attachMedia(video);
        }
      }

      const resumeAt = pendingResumeRef.current ?? resolvePartyStart(current) ?? resolveResumeOffset(current);
      pendingResumeRef.current = null;
      const onLoadedMeta = () => {
        if (resumeAt > 0.5) video.currentTime = resumeAt;
        void video.play().catch(() => {
          /* autoplay can be blocked until the user interacts once — the play button still works */
        });
      };
      video.addEventListener("loadedmetadata", onLoadedMeta, { once: true });
      // `once` only removes the listener after it FIRES — if this pipeline is
      // torn down before loadedmetadata (quick track change), the stale
      // handler would force an outdated currentTime onto the next source.
      cleanupLoadedMeta = () => video.removeEventListener("loadedmetadata", onLoadedMeta);
    })();

    return () => {
      alive = false;
      cleanupLoadedMeta?.();
      if (localHls) localHls.destroy();
      if (hlsRef.current === localHls) hlsRef.current = null;
      if (localSessionId) void api.del(`/api/play/session/${localSessionId}`).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.mediaFileId, audioIdx, burnInSubtitleId, retryNonce]);

  // --- restore the persisted volume/mute once the <video> exists ---
  useVolumePersistence(videoRef);

  // --- keep the active text subtitle actually showing ---
  // A <track default> inserted after the media has loaded isn't reliably
  // activated by every browser, so force the mode: "showing" for the active
  // track, "disabled" for every other text track (e.g. in-stream ones
  // surfaced by hls.js). Re-applied on loadedmetadata because a pipeline
  // rebuild (track change) can reset track modes.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const apply = () => {
      const active = activeTextSubtitle ? (textTrackRef.current?.track ?? null) : null;
      for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = video.textTracks[i] === active ? "showing" : "disabled";
      }
      // Force the element's own track directly too, and retry next frame if it
      // hasn't registered in video.textTracks yet: a <track> added MID-playback
      // registers asynchronously in some browsers, and `default` only applies
      // at initial parse — so without this a subtitle picked from the menu
      // silently stays "disabled" and never renders.
      if (active) active.mode = "showing";
      else if (activeTextSubtitle) {
        // Cancel before re-arming: `apply` also fires from loadedmetadata, and
        // two live chains sharing this single `raf` handle would leave one of
        // them uncancellable at cleanup — an infinite rAF loop kept alive on a
        // detached <video> after the player unmounts.
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(apply);
      }
    };
    apply();
    video.addEventListener("loadedmetadata", apply);
    return () => {
      video.removeEventListener("loadedmetadata", apply);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [activeTextSubtitle]);

  // --- progress + watch-event persistence ---
  const saveProgressNow = useCallback(() => {
    const item = currentRef.current;
    if (!item) return;
    void useStateStore.getState().setProgress(item.itemType, item.itemId, posRef.current.time, posRef.current.duration || item.duration, item.mediaFileId);
  }, []);

  // Sends the final progress + (if applicable) watch/abandon signal for the
  // currently-resolved item, exactly once. `viaBeacon` picks the transport:
  // a real page unload can't wait for a normal fetch to land, so it fires a
  // best-effort sendBeacon; every other teardown (closing the player in-app,
  // advancing to the next episode) awaits a normal request instead — the
  // caller relies on that completing BEFORE re-reading progress (e.g. to
  // compute a resume offset for the very item just closed).
  const sendFinalState = useCallback(async (finished: boolean, viaBeacon: boolean): Promise<void> => {
    const item = currentRef.current;
    if (!item) return;
    if (finalizedForRef.current === item.itemId) return;
    finalizedForRef.current = item.itemId;
    const dur = posRef.current.duration || item.duration;
    const position = finished ? dur : posRef.current.time;
    const progressBody = { kind: "progress", itemType: item.itemType, itemId: item.itemId, position, duration: dur, mediaFileId: item.mediaFileId };
    const { kind, ratio } = classifyWatchEvent(position, dur);
    const eventBody = kind ? { kind: "watchEvent", itemType: item.itemType, itemId: item.itemId, eventKind: kind, ratio, seconds: position } : null;
    if (viaBeacon) {
      api.beacon("/api/state", progressBody);
      if (eventBody) api.beacon("/api/state", eventBody);
      return;
    }
    try {
      await api.post("/api/state", progressBody);
      if (eventBody) await api.post("/api/state", eventBody);
    } catch {
      /* best-effort — the periodic 10s save already got most of the way there */
    }
  }, []);

  // periodic save while playing
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(saveProgressNow, 10_000);
    return () => window.clearInterval(id);
  }, [playing, saveProgressNow]);

  // teardown: page close/reload (beacon, best-effort) AND normal unmount —
  // closing the player in-app or navigating away (awaited, then the shared
  // progress store is refreshed so Continue Watching reflects it immediately).
  useEffect(() => {
    const onUnload = () => void sendFinalState(false, true);
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onUnload);
      void (async () => {
        await sendFinalState(false, false);
        await useStateStore.getState().load();
      })();
    };
  }, [sendFinalState]);

  const advanceToNext = useCallback(async (): Promise<void> => {
    const item = currentRef.current;
    if (!nextEpisode || !item) return;
    await sendFinalState(true, false);
    setAudioIdx(undefined);
    setSelectedSubtitle(null);
    // Fresh episode, fresh preselection: the profile preference (updated by
    // any explicit pick made during THIS episode) applies to the next one.
    subtitleChosenRef.current = false;
    setNextUpVisible(false);
    setNextUpDismissed(false);
    setTarget({ kind: "episode", id: nextEpisode.id, topId: item.topId });
  }, [nextEpisode, sendFinalState]);

  const handleEnded = useCallback(() => {
    // In a party, only the host drives what comes next — a guest sits on the
    // last frame until the host advances (or picks something else), rather than
    // racing ahead into its own next episode.
    const party = useWatchPartyStore.getState();
    if (party.active && !party.isHost()) return;
    if (nextEpisode) void advanceToNext();
    else close();
  }, [nextEpisode, advanceToNext, close]);

  // --- <video> DOM event wiring ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const effectiveDuration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (currentRef.current?.duration ?? 0));

    const onTimeUpdate = () => {
      const dur = effectiveDuration();
      posRef.current = { time: video.currentTime, duration: dur };
      setCurrentTime(video.currentTime);
      if (dur > 0) setDuration(dur);
      if (nextEpisode && !nextUpDismissed && dur > 0) {
        // At the start of the end-credits chapter when the file has one,
        // else the historical duration-30s fallback (nextUpTriggerTime).
        const trigger = nextUpTriggerTime(decision?.chapters ?? [], dur);
        setNextUpVisible(video.currentTime >= trigger && video.currentTime < dur);
      }
    };
    const onLoadedMeta = () => {
      const dur = effectiveDuration();
      if (dur > 0) setDuration(dur);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      saveProgressNow();
    };
    const onVolumeChange = () => {
      setVolume(video.volume);
      setMuted(video.muted);
      writeStoredVolume(video.volume, video.muted);
    };
    const onEnded = () => handleEnded();
    const onBufferingStart = () => setBuffering(true);
    const onBufferingEnd = () => setBuffering(false);
    const onError = () => {
      // With hls.js attached, raw element errors are re-surfaced (with a
      // recovery attempt first) through Hls.Events.ERROR — don't short-circuit
      // that path here.
      if (hlsRef.current) return;
      setError(MEDIA_ERROR_MESSAGE);
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadedmetadata", onLoadedMeta);
    video.addEventListener("durationchange", onLoadedMeta);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("volumechange", onVolumeChange);
    video.addEventListener("ended", onEnded);
    video.addEventListener("waiting", onBufferingStart);
    video.addEventListener("seeking", onBufferingStart);
    video.addEventListener("playing", onBufferingEnd);
    video.addEventListener("canplay", onBufferingEnd);
    video.addEventListener("seeked", onBufferingEnd);
    video.addEventListener("error", onError);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", onLoadedMeta);
      video.removeEventListener("durationchange", onLoadedMeta);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("volumechange", onVolumeChange);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("waiting", onBufferingStart);
      video.removeEventListener("seeking", onBufferingStart);
      video.removeEventListener("playing", onBufferingEnd);
      video.removeEventListener("canplay", onBufferingEnd);
      video.removeEventListener("seeked", onBufferingEnd);
      video.removeEventListener("error", onError);
    };
  }, [nextEpisode, nextUpDismissed, saveProgressNow, handleEnded, decision]);

  // --- watch party: reconcile local <video> to the shared transport ---------
  // Runs on every room playback change (store subscription) and on a 1s tick to
  // absorb the drift that silently accrues while playing. Applies to host AND
  // guests. No-op until a party is active and THIS client has loaded the room's
  // current title (so we never fight a guest still buffering a fresh pick).
  useEffect(() => {
    const reconcile = () => {
      const st = useWatchPartyStore.getState();
      if (!st.active) return;
      const pb = st.playback;
      const video = videoRef.current;
      const item = currentRef.current;
      if (!pb.target || !video || !item) return;
      if (!targetMatches(pb.target, { kind: item.itemType, id: item.itemId, mediaFileId: item.mediaFileId })) return;
      // HAVE_FUTURE_DATA minimum: hard-seeking an element that is still
      // buffering skips content and cascades the stalls — wait for data.
      if (video.readyState < 3) return;
      const shared = computeLivePosition(pb, Date.now() + st.clockOffset);
      // Correct position first so a resume-from-pause doesn't race a big seek.
      if (shouldResync(video.currentTime, shared)) {
        try {
          video.currentTime = shared;
        } catch {
          /* not seekable yet — the next tick retries */
        }
      }
      if (pb.paused && !video.paused) video.pause();
      // Don't "resume" a video that has hit its end (a guest a beat ahead of the
      // host) — play() on an ended element would restart it from zero. The host
      // advancing remounts the player on the next title anyway.
      else if (!pb.paused && video.paused && !video.ended) void video.play().catch(() => {});
    };
    const unsub = useWatchPartyStore.subscribe(reconcile);
    const id = window.setInterval(reconcile, 1000);
    reconcile();
    return () => {
      unsub();
      window.clearInterval(id);
    };
  }, []);

  // --- watch party: host publishes what it's playing as the room's title -----
  // Fires whenever the host loads a new file (initial open, auto-advance,
  // version pick). Skipped when the room already shows this title — so a member
  // promoted to host mid-film (previous host left) doesn't yank everyone back to
  // its own resume point. Guests never push.
  useEffect(() => {
    if (!partyIsHost || !current) return;
    const st = useWatchPartyStore.getState();
    if (targetMatches(st.playback.target, { kind: current.itemType, id: current.itemId, mediaFileId: current.mediaFileId })) return;
    st.pushTarget(
      {
        kind: current.itemType,
        id: current.itemId,
        topId: current.topId,
        mediaFileId: current.mediaFileId,
        title: current.title,
        subtitle: current.subtitle,
      },
      resolveResumeOffset(current),
      true,
    );
  }, [current, partyIsHost]);

  // Host closing the player returns the room to the lobby (target → null) so
  // guests aren't stranded on a frozen frame. Only when the player is genuinely
  // closing — switching to another title remounts this session, and the new
  // one's host-push publishes the next target, so we must NOT flash the lobby in
  // between (request is already the new one by unmount time). No-op for guests
  // and for a party that already ended (code cleared).
  useEffect(() => {
    return () => {
      const st = useWatchPartyStore.getState();
      if (st.active && st.isHost() && usePlayerStore.getState().request === null) st.pushTarget(null);
    };
  }, []);

  // --- controls ---
  // In a watch party, the user's own transport intents (play/pause/seek) are
  // broadcast so every member follows — the "shared remote". Every UI path
  // (controls bar, video click, keyboard, seekbar, skip-intro) funnels through
  // these three callbacks; the reconcile effect's programmatic sync-seeks do
  // NOT, so a broadcast can never feed back on itself.
  const emitParty = useCallback((action: PartyControlAction, position: number) => {
    const st = useWatchPartyStore.getState();
    if (st.active) st.sendControl(action, position);
  }, []);
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => {});
      emitParty("play", video.currentTime);
    } else {
      video.pause();
      emitParty("pause", video.currentTime);
    }
  }, [emitParty]);
  // Tapping the video on a touch device (no mousemove there) first SURFACES
  // the hidden controls instead of toggling playback — otherwise a "show me
  // the controls" tap pauses playback, and everyone else's in a séance.
  const handleVideoClick = useCallback(
    (e: ReactMouseEvent<HTMLVideoElement>) => {
      const pointerType = (e.nativeEvent as { pointerType?: string }).pointerType;
      const coarse = pointerType ? pointerType === "touch" : window.matchMedia("(pointer: coarse)").matches;
      if (coarse && !showControlsRef.current) {
        controlsResetRef.current();
        return;
      }
      togglePlay();
    },
    [togglePlay],
  );
  const seekRelative = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (currentRef.current?.duration ?? Infinity);
      const next = Math.min(Math.max(0, video.currentTime + delta), dur);
      video.currentTime = next;
      emitParty("seek", next);
    },
    [emitParty],
  );
  const seekTo = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = seconds;
      emitParty("seek", seconds);
    },
    [emitParty],
  );
  const changeVolume = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video) return;
    const next = clampVolume(value);
    video.volume = next;
    video.muted = next === 0;
  }, []);
  const stepVolume = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      changeVolume(video.volume + delta);
      // Surface the controls (their volume slider is the visual feedback).
      controlsResetRef.current();
    },
    [changeVolume],
  );
  const retry = useCallback(() => {
    setError(null);
    if (currentRef.current) {
      // Media/pipeline failure: rebuild the pipeline, resuming where we were.
      if (posRef.current.time > 0) pendingResumeRef.current = posRef.current.time;
      setRetryNonce((n) => n + 1);
    } else {
      // Resolution failure (nothing playable yet): re-run the resolve effect
      // by handing it a fresh target identity.
      setTarget((t) => ({ ...t }));
    }
  }, []);
  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current?.requestFullscreen();
  }, []);

  useFullscreenSync(setFullscreen);

  usePlayerKeyboard({ togglePlay, seekRelative, stepVolume, toggleMute, toggleFullscreen, close, showTrackMenu, setShowTrackMenu });

  // --- auto-hide overlay ---
  useAutoHideControls({ containerRef, hideTimerRef, controlsResetRef, setShowControls, playing, showTrackMenu });

  // Persists a playback preference for the profile — fire-and-forget: no
  // spinner, and a failed write must never disturb playback (the server
  // re-validates everything anyway).
  const persistPreference = useCallback((prefs: { audioLang?: string; subtitleLang?: string }) => {
    void api.post("/api/settings", prefs).catch(() => {});
  }, []);

  const onSelectAudio = (streamIndex: number) => {
    pendingResumeRef.current = videoRef.current?.currentTime ?? 0;
    setAudioIdx(streamIndex);
    setShowTrackMenu(false);
    const lang = prefLangOf(decision?.audioTracks.find((t) => t.streamIndex === streamIndex)?.language);
    if (lang) persistPreference({ audioLang: lang });
  };
  const onSelectSubtitle = (subtitle: PlaybackSubtitleTrack | null) => {
    if (subtitle?.requiresBurnIn || selectedSubtitle?.requiresBurnIn) pendingResumeRef.current = videoRef.current?.currentTime ?? 0;
    subtitleChosenRef.current = true;
    setSelectedSubtitle(subtitle);
    setShowTrackMenu(false);
    if (subtitle === null) {
      persistPreference({ subtitleLang: "off" });
    } else {
      const lang = prefLangOf(subtitle.language);
      if (lang) persistPreference({ subtitleLang: lang });
    }
  };

  const trackMenuAvailable = !!decision && (decision.audioTracks.length > 1 || decision.subtitles.length > 0);

  // --- « Passer l'intro / le récap » (chapitres) ---
  // Netflix behaviour: pops for a few seconds when entering an intro/recap
  // chapter, then fades — but re-surfaces with the controls overlay for
  // whoever seeks into the middle of one.
  const chapters = decision?.chapters ?? [];
  const skipTarget = skipTargetFor(chapters, currentTime);
  const skipChapter = skipTarget !== null ? chapterAt(chapters, currentTime) : null;
  const skipKind = skipChapter ? classifyChapter(skipChapter.title) : null;
  const skipVisible = skipTarget !== null && skipChapter !== null && (showControls || currentTime - skipChapter.start <= SKIP_BUTTON_SECONDS);
  const skipLabel = skipKind === "recap" ? "Passer le récap" : "Passer l'intro";

  return (
    <div ref={containerRef} className="fixed inset-0 z-[100] bg-black">
      <video ref={videoRef} className="h-full w-full" playsInline onClick={handleVideoClick}>
        {activeTextSubtitle && (
          <track
            ref={textTrackRef}
            key={activeTextSubtitle.id}
            kind="subtitles"
            default
            src={`/api/subs/${activeTextSubtitle.id}`}
            srcLang={activeTextSubtitle.language ?? undefined}
            label={activeTextSubtitle.title ?? activeTextSubtitle.language ?? "Sous-titres"}
            // Belt-and-suspenders with the mode-forcing effect: once the cue
            // file has loaded, make sure this track is the one showing.
            onLoad={() => {
              if (textTrackRef.current?.track) textTrackRef.current.track.mode = "showing";
            }}
          />
        )}
      </video>

      {!current && !error && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4" role="status">
          <div className="size-14 animate-spin rounded-full border-4 border-white/20 border-t-accent" />
          <p className="text-base font-medium text-white/85">{initial.title ? `Chargement de « ${initial.title} »…` : "Chargement…"}</p>
        </div>
      )}

      {buffering && !error && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center" role="status" aria-label="Mise en mémoire tampon">
          <div className="size-16 animate-spin rounded-full border-4 border-white/20 border-t-accent" />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/90 p-6 text-center">
          <p className="text-lg font-semibold text-white">{error}</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button type="button" onClick={retry} className="rounded-full bg-white px-6 py-2 font-bold text-black hover:bg-white/80">
              Réessayer
            </button>
            <button type="button" onClick={close} className="rounded-full bg-white/15 px-6 py-2 font-bold text-white hover:bg-white/25">
              Fermer
            </button>
          </div>
        </div>
      )}

      {current && !error && skipVisible && skipTarget !== null && (
        <button
          type="button"
          onClick={() => seekTo(skipTarget)}
          className="absolute bottom-24 right-4 z-20 glass rounded-full px-5 py-2.5 text-sm font-bold text-white shadow-lg transition-colors hover:bg-white hover:text-black md:right-8"
        >
          {skipLabel}
        </button>
      )}

      {current && !error && showControls && (
        <PlayerControls
          title={current.title}
          subtitle={current.subtitle}
          playing={playing}
          currentTime={currentTime}
          duration={duration || current.duration}
          volume={volume}
          muted={muted}
          fullscreen={fullscreen}
          trackMenuAvailable={trackMenuAvailable}
          chapters={chapters}
          trickplay={trickplayMeta}
          trickplaySpriteUrl={trickplayMeta ? `/api/trickplay/${current.mediaFileId}?sprite=1` : null}
          onClose={close}
          onTogglePlay={togglePlay}
          onSeekRelative={seekRelative}
          onSeekTo={seekTo}
          onVolumeChange={changeVolume}
          onToggleMute={toggleMute}
          onToggleFullscreen={toggleFullscreen}
          onToggleTrackMenu={() => setShowTrackMenu((v) => !v)}
        />
      )}

      {showTrackMenu && decision && (
        <TrackMenu
          audioTracks={decision.audioTracks}
          subtitles={decision.subtitles}
          selectedAudioIndex={audioIdx ?? decision.audioStreamIndex ?? undefined}
          selectedSubtitleId={selectedSubtitle?.id ?? null}
          onSelectAudio={onSelectAudio}
          onSelectSubtitle={onSelectSubtitle}
          onClose={() => setShowTrackMenu(false)}
        />
      )}

      {nextUpVisible && !nextUpDismissed && nextEpisode && !partyIsGuest && (
        <NextEpisodeCard episode={nextEpisode} playing={playing} onPlayNext={() => void advanceToNext()} onDismiss={() => setNextUpDismissed(true)} />
      )}

      {partyActive && <PartyOverlay showControls={showControls} />}
    </div>
  );
}
