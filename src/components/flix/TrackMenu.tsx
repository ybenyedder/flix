"use client";

// Audio/subtitle track picker, popped over the player. Selecting a non-default
// audio track, or a bitmap (burn-in) subtitle, makes PlayerView tear down and
// recreate the HLS session (decide() never allows those over direct play) —
// this component only reports the selection, it has no idea what that costs.

import type { PlaybackAudioTrack, PlaybackSubtitleTrack } from "@/lib/flix/types";

function trackLabel(language: string | null, title: string | null, fallback: string): string {
  if (title) return title;
  if (language) return language.toUpperCase();
  return fallback;
}

interface TrackMenuProps {
  audioTracks: PlaybackAudioTrack[];
  subtitles: PlaybackSubtitleTrack[];
  selectedAudioIndex?: number;
  selectedSubtitleId: number | null;
  onSelectAudio: (streamIndex: number) => void;
  onSelectSubtitle: (subtitle: PlaybackSubtitleTrack | null) => void;
  onClose: () => void;
}

export function TrackMenu({ audioTracks, subtitles, selectedAudioIndex, selectedSubtitleId, onSelectAudio, onSelectSubtitle, onClose }: TrackMenuProps) {
  return (
    <div className="absolute bottom-24 right-4 z-20 w-72 glass rounded-panel p-4 text-sm text-white shadow-pop animate-scale-in origin-bottom-right md:right-8">
      {audioTracks.length > 1 && (
        <div className="mb-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Audio</p>
          <ul className="space-y-1">
            {audioTracks.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onSelectAudio(t.streamIndex)}
                  className={"w-full rounded-field px-2 py-1.5 text-left transition-colors hover:bg-white/10 " + (selectedAudioIndex === t.streamIndex ? "bg-white/10 text-accent" : "")}
                >
                  {trackLabel(t.language, t.title, `Piste ${t.streamIndex}`)}
                  {t.channels ? ` · ${t.channels}.0` : ""}
                  {!t.supported ? " (transcodage)" : ""}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {subtitles.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Sous-titres</p>
          <ul className="space-y-1">
            <li>
              <button
                type="button"
                onClick={() => onSelectSubtitle(null)}
                className={"w-full rounded-field px-2 py-1.5 text-left transition-colors hover:bg-white/10 " + (selectedSubtitleId === null ? "bg-white/10 text-accent" : "")}
              >
                Désactivés
              </button>
            </li>
            {subtitles.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelectSubtitle(s)}
                  className={"w-full rounded-field px-2 py-1.5 text-left transition-colors hover:bg-white/10 " + (selectedSubtitleId === s.id ? "bg-white/10 text-accent" : "")}
                >
                  {trackLabel(s.language, s.title, `Piste ${s.id}`)}
                  {s.isSdh ? " · SME" : ""}
                  {s.requiresBurnIn ? " (incrustés)" : ""}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button type="button" onClick={onClose} className="mt-3 w-full rounded-field bg-white/10 py-1.5 text-center text-xs text-muted hover:text-white">
        Fermer
      </button>
    </div>
  );
}
