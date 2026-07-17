"use client";

import { useLibraryStore } from "@/store/library";

const PHASE_LABELS: Record<string, string> = {
  walking: "Parcours des dossiers…",
  indexing: "Indexation…",
  probing: "Analyse des fichiers…",
  nfo: "Lecture des métadonnées…",
  pruning: "Nettoyage…",
  "indexing-fts": "Indexation de la recherche…",
  done: "Terminé",
  "no-media-dir": "Dossier introuvable",
  error: "Erreur",
};

export function ScanProgressBar() {
  const scan = useLibraryStore((s) => s.scan);
  if (!scan) return null;

  const scanning = scan.status === "scanning";
  const imaging = scan.imaging;
  if (!scanning && !imaging) return null;

  let label: string;
  let done = 0;
  let total = 0;
  if (scanning) {
    label = PHASE_LABELS[scan.phase] ?? scan.phase;
    if (scan.phase === "probing") {
      done = scan.probed;
      total = scan.probeTotal;
    } else {
      done = scan.processed;
      total = scan.total;
    }
  } else {
    label = "Extraction des images…";
    done = scan.imaged;
    total = scan.imageTotal;
  }
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-baseline justify-between text-xs text-muted">
        <span>{label}</span>
        <span>{total > 0 ? `${done} / ${total}` : ""}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={"h-full rounded-full bg-accent shadow-glow transition-[width] duration-300" + (percent === null ? " w-1/4 animate-pulse" : "")}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
