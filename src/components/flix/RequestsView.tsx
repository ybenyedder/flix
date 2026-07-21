"use client";

// « Demandes » — the household's external requests and their live status. Polls
// every 15s while mounted (request states change on download timescales; an SSE
// stream per client isn't worth it). Available titles deep-link into their
// library detail; the requester (or an admin) can drop a request.

import { useEffect, useState } from "react";
import { Film, Tv, Trash2, Play } from "lucide-react";
import type { ArrRequest } from "@/lib/flix/types";
import { useArrStore } from "@/store/arr";
import { useProfileStore } from "@/store/profile";
import { useUiStore } from "@/store/ui";

const POLL_MS = 15_000;

function statusChip(req: ArrRequest): { label: string; className: string } {
  switch (req.status) {
    case "requested":
    case "searching":
      return { label: "Recherche en cours…", className: "text-sky-400" };
    case "downloading":
      return { label: `Téléchargement ${Math.round(req.progress)} %`, className: "text-sky-400" };
    case "importing":
      return { label: "Importation…", className: "text-amber-400" };
    case "available":
      return { label: "Disponible", className: "text-emerald-400" };
    case "failed":
      return { label: "Échec", className: "text-accent" };
    default:
      return { label: req.status, className: "text-muted" };
  }
}

function RequestRow({ req }: { req: ArrRequest }) {
  const username = useProfileStore((s) => s.username);
  const isAdmin = useProfileStore((s) => s.isAdmin);
  const removeRequest = useArrStore((s) => s.removeRequest);
  const openDetail = useUiStore((s) => s.openDetail);
  const [confirming, setConfirming] = useState(false);

  const chip = statusChip(req);
  const canOpen = req.status === "available" && req.libraryItemId != null;
  // Admin removes any; the requester removes their own until it becomes available.
  const canDelete = isAdmin || (req.requestedBy === username && req.status !== "available");

  const open = () => {
    if (canOpen) openDetail({ type: req.mediaType, id: req.libraryItemId as number });
  };
  const remove = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    void removeRequest(req.id);
  };

  return (
    <li className="card-surface flex items-center gap-3 p-3">
      <div className="relative h-20 w-14 shrink-0 overflow-hidden rounded-card bg-surface-hover">
        {req.posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={req.posterUrl} alt={req.title} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-muted">{req.mediaType === "movie" ? <Film className="size-5" /> : <Tv className="size-5" />}</div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">
          {req.title}
          {req.year ? <span className="text-muted"> ({req.year})</span> : null}
        </p>
        <p className={"mt-0.5 text-xs " + chip.className} title={req.error ?? undefined}>
          {chip.label}
          {req.status === "failed" && req.error ? ` — ${req.error}` : ""}
        </p>
        {req.status === "downloading" && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(2, Math.min(100, req.progress))}%` }} />
          </div>
        )}
        <p className="mt-1 text-[11px] text-muted">
          {req.mediaType === "movie" ? "Film" : "Série"}
          {req.requestedBy ? ` · demandé par ${req.requestedBy}` : ""}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {canOpen && (
          <button
            type="button"
            onClick={open}
            className="flex items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover"
          >
            <Play className="size-3.5" /> Regarder
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={remove}
            onMouseLeave={() => setConfirming(false)}
            className={"flex items-center gap-1 rounded-full px-2 py-1.5 text-xs " + (confirming ? "bg-accent text-white" : "text-muted hover:bg-surface-hover hover:text-white")}
            aria-label="Supprimer la demande"
          >
            <Trash2 className="size-3.5" />
            {confirming ? "Confirmer ?" : ""}
          </button>
        )}
      </div>
    </li>
  );
}

export function RequestsView() {
  const enabled = useArrStore((s) => s.enabled);
  const requests = useArrStore((s) => s.requests);
  const refreshRequests = useArrStore((s) => s.refreshRequests);

  useEffect(() => {
    void refreshRequests();
    const timer = window.setInterval(() => void refreshRequests(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshRequests]);

  return (
    <div className="min-h-screen px-4 pb-20 pt-24 md:px-12">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-6 font-display text-3xl font-bold tracking-tight text-white">Demandes</h1>
        {!enabled ? (
          <p className="text-sm text-muted">Les téléchargements automatiques sont désactivés.</p>
        ) : requests.length === 0 ? (
          <p className="text-sm text-muted">
            Aucune demande pour le moment. Recherchez un titre absent de votre bibliothèque, puis cliquez sur « Demander ».
          </p>
        ) : (
          <ul className="space-y-2">
            {requests.map((req) => (
              <RequestRow key={req.id} req={req} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
