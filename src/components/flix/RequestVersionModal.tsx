"use client";

// Cascading "version picker" for a requestable title: probes what's ACTUALLY
// available (POST /api/arr/releases → interactive search), then walks the user
// language → quality, offering only what really exists. Picking a quality grabs
// that exact release (POST /api/arr/grab). Closing without grabbing cleans up any
// movie the probe had to add to Radarr (DELETE /api/arr/releases).

import { useEffect, useRef, useState } from "react";
import { X, Loader2, ChevronLeft, Film, HardDrive, Users } from "lucide-react";
import { api, ApiError } from "@/lib/flix/api";
import type { ArrDiscoverItem, ReleaseOptions, ReleaseLanguageOption } from "@/lib/flix/types";
import { useUiStore } from "@/store/ui";

function formatSize(bytes: number): string {
  if (!bytes) return "—";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} Go` : `${Math.max(1, Math.round(bytes / 1e6))} Mo`;
}

export function RequestVersionModal({ item, onClose, onRequested }: { item: ArrDiscoverItem; onClose: () => void; onRequested: () => void }) {
  const notify = useUiStore((s) => s.notify);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<ReleaseOptions | null>(null);
  const [lang, setLang] = useState<ReleaseLanguageOption | null>(null);
  const [grabbing, setGrabbing] = useState<string | null>(null); // guid being grabbed
  const grabbedRef = useRef(false);
  const optionsRef = useRef<ReleaseOptions | null>(null);

  // Probe availability once on open.
  useEffect(() => {
    let alive = true;
    api
      .post<{ options: ReleaseOptions }>("/api/arr/releases", { tmdbId: item.tmdbId })
      .then((data) => {
        if (!alive) return;
        optionsRef.current = data.options;
        setOptions(data.options);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof ApiError ? e.message : "Échec de la recherche des versions");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [item.tmdbId]);

  // Close cleanup: if the probe ADDED a movie to Radarr and nothing was grabbed,
  // remove it so browsing doesn't leave orphans behind.
  const close = () => {
    const opts = optionsRef.current;
    if (opts?.wasAdded && !grabbedRef.current) {
      void api.del(`/api/arr/releases?arrId=${opts.arrId}&wasAdded=1`).catch(() => {});
    }
    onClose();
  };

  // Escape to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grab = async (guid: string, indexerId: number, qualityLabel: string) => {
    if (grabbing || !options) return;
    setGrabbing(guid);
    try {
      await api.post("/api/arr/grab", { tmdbId: item.tmdbId, arrId: options.arrId, guid, indexerId });
      grabbedRef.current = true;
      notify(`« ${item.title} » demandé — ${lang?.label} ${qualityLabel}`);
      onRequested();
      onClose();
    } catch (e) {
      setGrabbing(null);
      notify(e instanceof ApiError ? e.message : "Échec de la demande");
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={close} role="dialog" aria-modal="true">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-dialog bg-surface shadow-pop ring-1 ring-white/10 animate-scale-in" onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-white/10 p-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{item.title}</p>
            {item.year && <p className="text-xs text-muted">{item.year}</p>}
          </div>
          <button type="button" onClick={close} aria-label="Fermer" className="shrink-0 grid place-items-center glass rounded-full p-1.5 text-muted transition-colors hover:text-white">
            <X className="size-4" />
          </button>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted">
              <Loader2 className="size-6 animate-spin text-accent" />
              <span>Recherche des versions disponibles…</span>
              <span className="text-xs text-muted">{"Balayage de tous les indexeurs — ça peut prendre jusqu'à une minute."}</span>
            </div>
          )}

          {!loading && error && <p className="py-8 text-center text-sm text-accent">{error}</p>}

          {!loading && !error && options && options.languages.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted">
              <Film className="size-6" />
              <span>Aucune version disponible pour ce titre.</span>
            </div>
          )}

          {/* step 1: language */}
          {!loading && !error && options && options.languages.length > 0 && !lang && (
            <div className="flex flex-col gap-2">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Choisir la langue</p>
              {options.languages.map((l) => (
                <button
                  key={l.language}
                  type="button"
                  onClick={() => setLang(l)}
                  className="flex items-center justify-between rounded-field bg-surface-hover px-3 py-2.5 text-left text-sm text-white transition-colors hover:bg-white/10"
                >
                  <span className="font-medium">{l.label}</span>
                  <span className="text-xs text-muted">
                    {l.qualities.length} qualité{l.qualities.length > 1 ? "s" : ""}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* step 2: quality */}
          {!loading && !error && lang && (
            <div className="flex flex-col gap-2">
              <button type="button" onClick={() => setLang(null)} className="mb-1 flex items-center gap-1 self-start text-xs text-muted hover:text-white">
                <ChevronLeft className="size-3.5" /> Langue : {lang.label}
              </button>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Choisir la qualité</p>
              {lang.qualities.map((q) => (
                <button
                  key={q.quality}
                  type="button"
                  disabled={grabbing !== null}
                  onClick={() => void grab(q.guid, q.indexerId, q.label)}
                  className="flex items-center justify-between gap-2 rounded-field bg-surface-hover px-3 py-2.5 text-left text-sm text-white transition-colors hover:bg-white/10 disabled:opacity-60"
                >
                  <span className="font-medium">{q.label}</span>
                  <span className="flex items-center gap-3 text-xs text-muted">
                    <span className="flex items-center gap-1">
                      <HardDrive className="size-3" /> {formatSize(q.sizeBytes)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Users className="size-3" /> {q.seeders}
                    </span>
                    {grabbing === q.guid && <Loader2 className="size-3.5 animate-spin text-accent" />}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
