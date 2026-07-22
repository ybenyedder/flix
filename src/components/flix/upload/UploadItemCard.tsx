"use client";

// One row in the upload dock. Renders a destination form while pending, a live
// progress bar while transferring, and terminal states (indexing → added, or
// error) with the right actions.

import { Pause, Play, X, RotateCcw, Check, Loader2, FileVideo, AlertTriangle } from "lucide-react";
import { useUploadStore, type UploadItem } from "@/store/upload";
import { useUiStore } from "@/store/ui";
import { UploadDestinationForm } from "@/components/flix/upload/UploadDestinationForm";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function formatSpeed(bps: number | null): string {
  if (!bps || bps <= 0) return "—";
  return `${formatBytes(bps)}/s`;
}

function formatEta(remaining: number, bps: number | null): string {
  if (!bps || bps <= 0) return "—";
  const secs = Math.round(remaining / bps);
  if (secs < 60) return `${secs} s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m} min ${String(s).padStart(2, "0")} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

function destinationLabel(item: UploadItem): string | null {
  if (!item.destination) return null;
  if (item.destination.kind === "movie") {
    return `Film · ${item.destination.title}${item.destination.year ? ` (${item.destination.year})` : ""}`;
  }
  const e = item.episode != null ? `E${String(item.episode).padStart(2, "0")}` : "";
  return `Série · ${item.destination.show} · S${String(item.destination.season).padStart(2, "0")}${e}`;
}

function iconBtn(): string {
  return "grid size-8 place-items-center rounded-full text-white transition-colors hover:bg-white/15";
}

export function UploadItemCard({ item }: { item: UploadItem }) {
  const pause = useUploadStore((s) => s.pause);
  const resume = useUploadStore((s) => s.resume);
  const cancel = useUploadStore((s) => s.cancel);
  const retry = useUploadStore((s) => s.retry);
  const dismiss = useUploadStore((s) => s.dismiss);
  const navigate = useUiStore((s) => s.navigate);
  const openDetail = useUiStore((s) => s.openDetail);

  const pct = item.size > 0 ? Math.min(100, Math.round((item.received / item.size) * 100)) : 0;
  const active = item.status === "uploading";
  const label = destinationLabel(item);
  const link = item.libraryLink;

  return (
    <div className="rounded-panel bg-black/25 p-3 ring-1 ring-white/5">
      <div className="flex items-start gap-2">
        <FileVideo className="mt-0.5 size-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white" title={item.originalName}>
            {item.originalName}
          </p>
          {label && <p className="truncate text-xs text-muted">{label}</p>}
        </div>
        {(item.status === "done" || item.status === "error" || item.status === "orphan") && (
          <button type="button" onClick={() => dismiss(item.id)} aria-label="Retirer" className={iconBtn()}>
            <X className="size-4" />
          </button>
        )}
      </div>

      {item.status === "pending-destination" && (
        <div className="mt-3">
          <UploadDestinationForm item={item} />
        </div>
      )}

      {item.status === "orphan" && <p className="mt-2 text-xs text-muted">{item.note}</p>}

      {(item.status === "queued" || item.status === "uploading" || item.status === "paused" || item.status === "finalizing" || item.status === "indexing") && (
        <div className="mt-3 space-y-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className={"h-full rounded-full bg-accent transition-[width] duration-300 " + (active ? "shadow-glow" : "")} style={{ width: `${item.status === "indexing" ? 100 : pct}%` }} />
          </div>
          <div className="flex items-center justify-between text-xs text-muted">
            <span className="tabular-nums">
              {item.status === "queued" && "En attente…"}
              {item.status === "uploading" && `${formatBytes(item.received)} / ${formatBytes(item.size)} · ${pct}%`}
              {item.status === "paused" && `En pause · ${pct}%`}
              {item.status === "finalizing" && "Finalisation…"}
              {item.status === "indexing" && (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" /> Indexation en cours…
                </span>
              )}
            </span>
            <div className="flex items-center gap-1">
              {item.status === "uploading" && (
                <span className="tabular-nums">
                  {formatSpeed(item.bytesPerSec)} · {formatEta(item.size - item.received, item.bytesPerSec)}
                </span>
              )}
              {item.status === "uploading" && (
                <button type="button" onClick={() => pause(item.id)} aria-label="Mettre en pause" className={iconBtn()}>
                  <Pause className="size-4" />
                </button>
              )}
              {item.status === "paused" && (
                <button type="button" onClick={() => resume(item.id)} aria-label="Reprendre" className={iconBtn()}>
                  <Play className="size-4" />
                </button>
              )}
              {(item.status === "uploading" || item.status === "paused" || item.status === "queued") && (
                <button type="button" onClick={() => cancel(item.id)} aria-label="Annuler" className={iconBtn()}>
                  <X className="size-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {item.status === "done" && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-match">
            <Check className="size-4" /> Ajouté à la bibliothèque
          </span>
          {link && (
            <button
              type="button"
              onClick={() => {
                navigate(link.type === "movie" ? "movies" : "shows");
                openDetail({ type: link.type, id: link.id });
              }}
              className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-white/15"
            >
              Voir la fiche
            </button>
          )}
        </div>
      )}
      {item.status === "done" && item.note && <p className="mt-1 text-xs text-muted">{item.note}</p>}

      {item.status === "error" && (
        <div className="mt-2 space-y-2">
          <p className="inline-flex items-start gap-1.5 text-xs text-accent">
            <AlertTriangle className="mt-px size-4 shrink-0" /> {item.error}
          </p>
          <button type="button" onClick={() => retry(item.id)} className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-white/15">
            <RotateCcw className="size-3" /> Réessayer
          </button>
        </div>
      )}
    </div>
  );
}
