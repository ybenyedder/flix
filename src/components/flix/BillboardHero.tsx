"use client";

// Full-bleed featured item. The caller resolves which item to feature — Home
// uses the Phase 7 taste engine's pickBillboard() (src/server/reco/engine.ts),
// falling back to the most recent addition for a cold-start profile.

import Image from "next/image";
import { Play, Info } from "lucide-react";
import { api } from "@/lib/flix/api";
import type { CatalogEntry } from "@/lib/flix/types";
import { hasResumePoint } from "@/lib/flix/playerLogic";
import { useUiStore } from "@/store/ui";
import { usePlayerStore } from "@/store/player";
import { useStateStore } from "@/store/state";

export function BillboardHero({ item }: { item: CatalogEntry }) {
  const openDetail = useUiStore((s) => s.openDetail);
  const openPlayer = usePlayerStore((s) => s.open);
  const backdrop = item.backdropHash ? api.imageUrl(item.backdropHash, 1440) : null;
  const logo = item.logoHash ? api.imageUrl(item.logoHash, 960) : null;
  // "Reprendre" when this title (movie, or an episode of this show) is in
  // progress — the player resolves the exact offset, this only picks the word.
  const resumable = useStateStore((s) =>
    s.progress.some((p) => p.topType === item.type && p.topId === item.id && !p.watched && hasResumePoint(p.position, p.duration)),
  );

  return (
    <section className="relative h-[56vw] max-h-[80vh] min-h-[420px] w-full overflow-hidden">
      {backdrop ? (
        <Image src={backdrop} alt="" fill priority sizes="100vw" className="object-cover" />
      ) : (
        <div className="h-full w-full bg-gradient-to-br from-surface-hover to-background" />
      )}
      <div className="hero-fade-left absolute inset-0" />
      <div className="hero-fade-bottom absolute inset-0" />

      <div className="absolute bottom-[14%] left-4 max-w-xl animate-fade-up md:left-12 md:max-w-2xl">
        {logo ? (
          <div className="relative mb-4 h-24 w-full max-w-md md:h-32">
            <Image src={logo} alt={item.title} fill sizes="480px" className="object-contain object-left" />
          </div>
        ) : (
          <h1 className="mb-4 font-display text-4xl font-black text-white drop-shadow-lg md:text-6xl">{item.title}</h1>
        )}
        {item.synopsis && <p className="mb-5 line-clamp-3 text-sm text-white drop-shadow md:text-lg">{item.synopsis}</p>}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => openPlayer({ kind: item.type, id: item.id, title: item.title })}
            className="flex items-center gap-2 rounded-full bg-white px-6 py-2.5 font-bold text-black transition duration-200 hover:scale-[1.02] hover:bg-white/80 hover:shadow-glow md:px-8 md:py-3"
          >
            <Play className="size-5 fill-black" /> {resumable ? "Reprendre" : "Lecture"}
          </button>
          <button
            type="button"
            onClick={() => openDetail({ type: item.type, id: item.id })}
            className="flex items-center gap-2 rounded-full glass px-6 py-2.5 font-bold text-white transition-colors hover:bg-white/35 md:px-8 md:py-3"
          >
            <Info className="size-5" /> Plus d’infos
          </button>
        </div>
      </div>
    </section>
  );
}
