"use client";

// Destination picker shown for a freshly dropped file before it starts
// uploading. Pre-filled from the filename (an SxxEyy tag → Série with
// season/episode, otherwise Film with title/year) and shows a live preview of
// exactly where the file will land in the library.

import { useMemo, useState } from "react";
import { Film, Tv } from "lucide-react";
import { useUploadStore, type UploadItem } from "@/store/upload";
import { buildEpisodeFilename, movieRelPreview, episodeRelPreview, fileExt } from "@/lib/flix/naming";

export function UploadDestinationForm({ item }: { item: UploadItem }) {
  const setDestination = useUploadStore((s) => s.setDestination);
  const start = useUploadStore((s) => s.start);
  const cancel = useUploadStore((s) => s.cancel);

  const initial = item.destination;
  const [kind, setKind] = useState<"movie" | "episode">(initial?.kind ?? "movie");
  const [title, setTitle] = useState(initial?.kind === "movie" ? initial.title : initial?.kind === "episode" ? initial.show : "");
  const [year, setYear] = useState<string>(() => {
    const y = initial?.kind === "movie" ? initial.year : initial?.kind === "episode" ? initial.showYear : null;
    return y != null ? String(y) : "";
  });
  const [season, setSeason] = useState<string>(initial?.kind === "episode" ? String(initial.season) : "1");
  const [episode, setEpisode] = useState<string>(item.episode != null ? String(item.episode) : "1");

  const preview = useMemo(() => {
    const parsedYear = year.trim() ? Number(year.trim()) : null;
    if (kind === "movie") {
      return movieRelPreview(title || "Sans titre", Number.isFinite(parsedYear) ? parsedYear : null, fileExt(item.originalName));
    }
    const s = Number(season) || 1;
    const e = Number(episode) || 1;
    const outgoing = buildEpisodeFilename(item.originalName, s, e);
    return episodeRelPreview(title || "Sans titre", Number.isFinite(parsedYear) ? parsedYear : null, s, outgoing);
  }, [kind, title, year, season, episode, item.originalName]);

  const canStart = title.trim().length > 0;

  function submit() {
    if (!canStart) return;
    const parsedYear = year.trim() ? Number(year.trim()) : null;
    const y = parsedYear != null && Number.isFinite(parsedYear) ? parsedYear : null;
    if (kind === "movie") {
      setDestination(item.id, { kind: "movie", title: title.trim(), year: y }, null);
    } else {
      const s = Number(season) || 1;
      const e = Number(episode) || 1;
      setDestination(item.id, { kind: "episode", show: title.trim(), showYear: y, season: s }, e);
    }
    start(item.id);
  }

  const seg = (active: boolean) => "flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors " + (active ? "bg-white text-black" : "text-muted hover:text-white");
  const field = "w-full rounded-field bg-white/5 px-3 py-1.5 text-sm text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-accent/60";

  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-full bg-black/30 p-1">
        <button type="button" onClick={() => setKind("movie")} className={seg(kind === "movie")}>
          <Film className="size-4" /> Film
        </button>
        <button type="button" onClick={() => setKind("episode")} className={seg(kind === "episode")}>
          <Tv className="size-4" /> Série
        </button>
      </div>

      <div className="space-y-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={kind === "movie" ? "Titre du film" : "Nom de la série"}
          aria-label={kind === "movie" ? "Titre du film" : "Nom de la série"}
          className={field}
        />
        <div className="flex gap-2">
          <input value={year} onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))} inputMode="numeric" placeholder="Année" aria-label="Année" className={field + " tabular-nums"} />
          {kind === "episode" && (
            <>
              <input value={season} onChange={(e) => setSeason(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))} inputMode="numeric" placeholder="Saison" aria-label="Saison" className={field + " tabular-nums"} />
              <input value={episode} onChange={(e) => setEpisode(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))} inputMode="numeric" placeholder="Épisode" aria-label="Épisode" className={field + " tabular-nums"} />
            </>
          )}
        </div>
      </div>

      <p className="truncate rounded-field bg-black/25 px-3 py-1.5 font-mono text-[11px] text-muted ring-1 ring-white/5" title={preview}>
        {preview}
      </p>

      <div className="flex gap-2">
        <button type="button" onClick={submit} disabled={!canStart} className="flex-1 rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
          Démarrer
        </button>
        <button type="button" onClick={() => cancel(item.id)} className="rounded-full bg-white/10 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-white/15">
          Annuler
        </button>
      </div>
    </div>
  );
}
