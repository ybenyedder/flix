"use client";

// Download-manager-style dock, bottom-right. Sits above the header (z-40) but
// below the detail modal (z-50) and player (z-100) so it yields to content the
// admin is actually watching. Only present when there's something in the queue.

import { ChevronDown, ChevronUp, Upload, Lock } from "lucide-react";
import { useUploadStore } from "@/store/upload";
import { UploadItemCard } from "@/components/flix/upload/UploadItemCard";

export function UploadDock() {
  const items = useUploadStore((s) => s.items);
  const collapsed = useUploadStore((s) => s.dockCollapsed);
  const setCollapsed = useUploadStore((s) => s.setDockCollapsed);
  const writable = useUploadStore((s) => s.writable);
  const capabilityError = useUploadStore((s) => s.capabilityError);

  if (items.length === 0) return null;

  const activeCount = items.filter((it) => it.status === "uploading" || it.status === "finalizing" || it.status === "indexing" || it.status === "queued").length;

  return (
    <div className="glass animate-slide-in-right fixed bottom-4 right-4 z-[45] flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-dialog shadow-pop">
      <button type="button" onClick={() => setCollapsed(!collapsed)} className="flex items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-white/5" aria-expanded={!collapsed}>
        <Upload className="size-4 text-accent" />
        <span className="font-display text-sm font-semibold text-white">Téléversements{activeCount > 0 ? ` (${activeCount})` : ""}</span>
        <span className="ml-auto text-muted">{collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</span>
      </button>

      {!collapsed && (
        <div className="max-h-[60vh] space-y-2 overflow-y-auto px-3 pb-3">
          {!writable && (
            <p className="inline-flex items-start gap-1.5 rounded-field bg-black/25 px-3 py-2 text-xs text-muted ring-1 ring-white/5">
              <Lock className="mt-px size-3.5 shrink-0" />
              {capabilityError ?? "Téléversement désactivé : le dossier médias est en lecture seule."}
            </p>
          )}
          {items.map((item) => (
            <UploadItemCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
