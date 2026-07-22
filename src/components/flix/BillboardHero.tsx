"use client";

// Full-bleed featured item. The caller resolves which item to feature — Home
// uses the Phase 7 taste engine's pickBillboard() (src/server/reco/engine.ts),
// falling back to the most recent addition for a cold-start profile.
//
// 2026 look: the backdrop gets a slow Ken Burns push-in, and a blurred copy of
// the same artwork bleeds an ambient glow below the hero, under the first rows
// (which overlap via -mt in HomeView) — the page is lit by the featured title
// instead of cutting to flat black. The glow uses the 480px variant: it's
// blurred beyond recognition, so decoding the 1440px asset twice is waste.

import Image from "next/image";
import { Play, Info } from "lucide-react";
import { api } from "@/lib/flix/api";
import type { CatalogEntry } from "@/lib/flix/types";
import { qualityLabel } from "@/lib/flix/quality";
import { formatDuration } from "@/lib/flix/format";
import { hasResumePoint } from "@/lib/flix/playerLogic";
import { useUiStore } from "@/store/ui";
import { usePlayerStore } from "@/store/player";
import { useStateStore } from "@/store/state";
import { useRecoStore } from "@/store/reco";

export function BillboardHero({ item, topRank = null }: { item: CatalogEntry; topRank?: number | null }) {
  const openDetail = useUiStore((s) => s.openDetail);
  const openPlayer = usePlayerStore((s) => s.open);
  const match = useRecoStore((s) => s.matchFor(item.type, item.id));
  const backdrop = item.backdropHash ? api.imageUrl(item.backdropHash, 1440) : null;
  const ambient = item.backdropHash ? api.imageUrl(item.backdropHash, 480) : null;
  const logo = item.logoHash ? api.imageUrl(item.logoHash, 960) : null;
  // "Reprendre" when this title (movie, or an episode of this show) is in
  // progress — the player resolves the exact offset, this only picks the word.
  const resumable = useStateStore((s) =>
    s.progress.some((p) => p.topType === item.type && p.topId === item.id && !p.watched && hasResumePoint(p.position, p.duration)),
  );

  const label = qualityLabel(item.quality.height);
  const genres = item.genres.slice(0, 3);

  return (
    <div className="relative">
      <section className="relative h-[60vw] max-h-[85vh] min-h-[440px] w-full overflow-hidden">
        {backdrop ? (
          <Image src={backdrop} alt="" fill priority sizes="100vw" className="hero-kenburns object-cover" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-surface-hover to-background" />
        )}
        <div className="hero-fade-left absolute inset-0" />
        <div className="hero-fade-bottom absolute inset-0" />
        <div className="hero-fade-top absolute inset-0" />

        <div className="absolute bottom-[12%] left-4 max-w-xl animate-fade-up md:left-12 md:max-w-2xl">
          {logo ? (
            <div className="relative mb-5 h-24 w-full max-w-md md:h-36">
              <Image src={logo} alt={item.title} fill sizes="480px" className="object-contain object-left drop-shadow-lg" />
            </div>
          ) : (
            <h1 className="mb-4 font-display text-5xl font-black leading-[0.95] tracking-[-0.02em] text-white drop-shadow-xl md:text-6xl">{item.title}</h1>
          )}

          {/* Netflix "N°X aujourd'hui" flag: shown only when the featured title
           * actually sits in today's Top 10 row (rank computed by HomeView). */}
          {topRank !== null && (
            <div className="mb-3 flex items-center gap-2.5">
              <span aria-hidden className="grid size-7 place-items-center rounded-[5px] bg-accent text-center font-display text-[8px] font-black leading-[1.05] text-white shadow">
                TOP
                <br />
                10
              </span>
              <span className="text-sm font-bold text-white drop-shadow md:text-base">
                N°{topRank} des {item.type === "movie" ? "films" : "séries"} aujourd’hui
              </span>
            </div>
          )}

          {/* Metadata line: match %, year, runtime/seasons, genres, badges. */}
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm font-medium text-white/75 drop-shadow md:text-[15px]">
            {match !== null && <span className="font-bold text-match">{match}% de correspondance</span>}
            {item.year && <span className="text-white/80">{item.year}</span>}
            {/* duration = 0 means "ffprobe failed", not a 0-minute film */}
            {item.type === "movie"
              ? item.duration > 0 && <span className="text-white/80">{formatDuration(item.duration)}</span>
              : item.seasonCount > 0 && <span className="text-white/80">{item.seasonCount} saison{item.seasonCount > 1 ? "s" : ""}</span>}
            {genres.length > 0 && <span className="text-white/55">{genres.join(" · ")}</span>}
            {label && <span className="rounded-full glass px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">{label}</span>}
            {item.quality.hdr && <span className="rounded-full glass px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">HDR</span>}
          </div>

          {item.synopsis && <p className="mb-6 line-clamp-2 max-w-xl text-sm text-white/85 drop-shadow md:line-clamp-3 md:text-lg">{item.synopsis}</p>}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => openPlayer({ kind: item.type, id: item.id, title: item.title })}
              className="flex items-center gap-2 rounded-full bg-white px-6 py-2.5 text-[15px] font-bold text-black transition duration-200 ease-out-quart hover:scale-[1.03] hover:bg-white/85 hover:shadow-glow active:scale-[0.98] md:px-8 md:py-3 md:text-base"
            >
              <Play className="size-5 fill-black" /> {resumable ? "Reprendre" : "Lecture"}
            </button>
            <button
              type="button"
              onClick={() => openDetail({ type: item.type, id: item.id })}
              className="flex items-center gap-2 rounded-full glass px-6 py-2.5 text-[15px] font-bold text-white transition duration-200 ease-out-quart hover:scale-[1.03] hover:bg-white/25 active:scale-[0.98] md:px-8 md:py-3 md:text-base"
            >
              <Info className="size-5" /> Plus d’infos
            </button>
          </div>
        </div>

        {/* Netflix's iconic maturity-rating flag: pinned to the hero's right
         * edge, a hairline white left border over frosted black. */}
        {item.contentRating && (
          <div className="absolute bottom-[14%] right-0 hidden items-center border-l-[3px] border-white/70 bg-black/40 py-1.5 pl-3 pr-8 text-sm font-semibold text-white/90 backdrop-blur-sm md:flex">
            {item.contentRating}
          </div>
        )}
      </section>

      {/* Lumière ambiante: the artwork's glow spills below the hero, behind the
       * overlapping rows. Pure decoration — no pointer events, no a11y noise. */}
      {ambient && (
        <div aria-hidden className="ambient-mask pointer-events-none absolute inset-x-0 top-full -mt-2 h-[38vh] overflow-hidden">
          <Image src={ambient} alt="" fill sizes="480px" className="ambient-glow object-cover" />
        </div>
      )}
    </div>
  );
}
