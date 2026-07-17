"use client";

// Fullscreen veil shown while an admin drags files over the window. z-[90] sits
// above the toast (70) but below the player (100). When the media folder is
// read-only it turns into a clear disabled message instead of a drop target.

import { UploadCloud, Ban } from "lucide-react";
import { useUploadStore } from "@/store/upload";

export function UploadDropOverlay() {
  const dragActive = useUploadStore((s) => s.dragActive);
  const writable = useUploadStore((s) => s.writable);
  const capabilityError = useUploadStore((s) => s.capabilityError);

  if (!dragActive) return null;

  return (
    <div className="glass animate-scale-in fixed inset-0 z-[90] grid place-items-center p-6">
      {writable ? (
        <div className="flex flex-col items-center gap-4 rounded-dialog border-2 border-dashed border-white/40 bg-white/5 px-10 py-16 text-center">
          <UploadCloud className="size-14 text-accent" />
          <p className="font-display text-2xl font-bold text-white">Déposez vos fichiers vidéo</p>
          <p className="max-w-sm text-sm text-muted">Films ou épisodes de séries. Vous choisirez la destination juste après le dépôt.</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-dialog border border-white/20 bg-white/5 px-10 py-16 text-center">
          <Ban className="size-14 text-muted" />
          <p className="font-display text-2xl font-bold text-white">Téléversement indisponible</p>
          <p className="max-w-sm text-sm text-muted">{capabilityError ?? "Le dossier médias est monté en lecture seule."}</p>
        </div>
      )}
    </div>
  );
}
