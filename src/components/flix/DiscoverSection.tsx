"use client";

// Rendered by SearchView below the library results: external titles (Radarr/
// Sonarr metadata lookup) not in the library, each requestable in one click.
// Self-guards — renders nothing for kids profiles or when the feature is off —
// and runs its own slower debounce so the main 250ms library search is untouched.

import { useEffect, useState } from "react";
import { Film, Tv, Plus, Check, Loader2 } from "lucide-react";
import { api } from "@/lib/flix/api";
import type { ArrDiscoverItem, ArrRequestStatus } from "@/lib/flix/types";
import { useArrStore } from "@/store/arr";
import { useProfileStore } from "@/store/profile";
import { useUiStore } from "@/store/ui";
import { RequestVersionModal } from "./RequestVersionModal";

const DEBOUNCE_MS = 600;
const MIN_CHARS = 3;

function itemKey(item: ArrDiscoverItem): string {
  return `${item.mediaType}:${item.tmdbId ?? item.tvdbId ?? item.title}`;
}

const STATUS_LABELS: Record<ArrRequestStatus, string> = {
  requested: "Demandé",
  searching: "Recherche…",
  downloading: "Téléchargement…",
  importing: "Importation…",
  available: "Disponible",
  failed: "Échec",
};

function DiscoverCard({ item }: { item: ArrDiscoverItem }) {
  const request = useArrStore((s) => s.request);
  const notify = useUiStore((s) => s.notify);
  const [state, setState] = useState<"idle" | "pending" | "requested">(item.requestStatus ? "requested" : "idle");
  const [pickerOpen, setPickerOpen] = useState(false);
  const isMovie = item.mediaType === "movie";

  // Movies open the real-availability version picker (language → quality). Shows
  // (Sonarr) keep the one-click request — no interactive picker for series yet.
  const onDemander = async () => {
    if (state !== "idle") return;
    if (isMovie) {
      setPickerOpen(true);
      return;
    }
    setState("pending");
    const res = await request({ mediaType: item.mediaType, tvdbId: item.tvdbId ?? undefined });
    if (res.ok) {
      setState("requested");
      notify(`« ${item.title} » demandé`);
    } else {
      setState("idle");
      notify(res.error ?? "Échec de la demande");
    }
  };

  const label =
    item.requestStatus && state === "requested"
      ? STATUS_LABELS[item.requestStatus]
      : state === "requested"
        ? "Demandé"
        : state === "pending"
          ? "…"
          : "Demander";

  return (
    <div className="card-surface flex flex-col overflow-hidden transition duration-200 ease-out-quart hover:-translate-y-1 hover:shadow-lift">
      <div className="relative aspect-[2/3] bg-surface-hover">
        {item.posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.posterUrl} alt={item.title} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-muted">{item.mediaType === "movie" ? <Film className="size-8" /> : <Tv className="size-8" />}</div>
        )}
        <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[11px] text-white">
          {item.mediaType === "movie" ? <Film className="size-3" /> : <Tv className="size-3" />}
          {item.mediaType === "movie" ? "Film" : "Série"}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-2">
        <div>
          <p className="line-clamp-2 text-sm font-medium text-white" title={item.title}>
            {item.title}
          </p>
          {item.year && <p className="text-xs text-muted">{item.year}</p>}
        </div>
        {item.inLibrary ? (
          <span className="mt-auto flex items-center justify-center gap-1 rounded-full bg-surface-hover px-2 py-1.5 text-xs font-semibold text-muted">
            <Check className="size-3.5" /> Déjà disponible
          </span>
        ) : (
          <button
            type="button"
            disabled={state !== "idle"}
            onClick={() => void onDemander()}
            className={
              "mt-auto flex items-center justify-center gap-1 rounded-full px-2 py-1.5 text-xs font-semibold transition-colors disabled:cursor-default " +
              (state === "idle" ? "bg-accent text-white hover:bg-accent-hover" : "bg-surface-hover text-muted")
            }
          >
            {state === "pending" ? <Loader2 className="size-3.5 animate-spin" /> : state === "requested" ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
            {label}
          </button>
        )}
      </div>

      {pickerOpen && <RequestVersionModal item={item} onClose={() => setPickerOpen(false)} onRequested={() => setState("requested")} />}
    </div>
  );
}

export function DiscoverSection({ query }: { query: string }) {
  const enabled = useArrStore((s) => s.enabled);
  const isKids = useProfileStore((s) => s.isKids);
  // Results are tagged with the query they answered; "loading" and "current" are
  // DERIVED from comparing that tag to the live query — deliberately no separate
  // loading state set synchronously in the effect (react-hooks/set-state-in-effect).
  const [results, setResults] = useState<{ query: string; items: ArrDiscoverItem[] } | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || isKids || trimmed.length < MIN_CHARS) return;
    let alive = true;
    const handle = window.setTimeout(() => {
      api
        .get<{ enabled: boolean; results: ArrDiscoverItem[] }>(`/api/arr/search?q=${encodeURIComponent(trimmed)}`)
        .then((data) => {
          if (alive) setResults({ query: trimmed, items: data.results ?? [] });
        })
        .catch(() => {
          if (alive) setResults({ query: trimmed, items: [] });
        });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, [query, enabled, isKids]);

  const trimmed = query.trim();
  if (!enabled || isKids || trimmed.length < MIN_CHARS) return null;
  const current = results?.query === trimmed ? results : null;
  const loading = current === null;

  return (
    <section className="mt-10">
      <div aria-hidden className="divider-fade mb-6" />
      <h2 className="mb-4 flex items-center gap-2 font-display text-lg font-semibold text-white">
        Pas dans votre bibliothèque ?{loading && <Loader2 className="size-4 animate-spin text-muted" />}
      </h2>
      {current && current.items.length === 0 && <p className="text-sm text-muted">Aucun titre à demander pour cette recherche.</p>}
      {current && current.items.length > 0 && (
        <div className="stagger-children grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {current.items.map((item) => (
            <DiscoverCard key={itemKey(item)} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}
