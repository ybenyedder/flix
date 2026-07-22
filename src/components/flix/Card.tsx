"use client";

// The workhorse catalogue card: a 2:3 poster ("cover") with the title always
// shown beneath it, that on a sustained hover (500ms, matching real Netflix)
// grows into a small LANDSCAPE info panel rendered via a portal so it can
// escape the row's horizontal-scroll clipping. Recently added, never-watched
// titles wear a small « Nouveau » badge.

import { memo, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { Play, Plus, Check, ThumbsUp, ThumbsDown, ChevronDown } from "lucide-react";
import { api } from "@/lib/flix/api";
import type { CatalogEntry, MovieDetail, ShowDetail, TrickplayMeta } from "@/lib/flix/types";
import { qualityLabel } from "@/lib/flix/quality";
import { formatDuration, isNew } from "@/lib/flix/format";
import { trickplayTileFor } from "@/lib/flix/playerLogic";
import { useUiStore } from "@/store/ui";
import { usePlayerStore } from "@/store/player";
import { useStateStore } from "@/store/state";
import { useRecoStore } from "@/store/reco";

const HOVER_DELAY_MS = 500;
const OVERLAY_SCALE = 1.4;
// Hover "preview": once the overlay is open, cycle through the title's
// trickplay sprite tiles like a time-lapse — the closest 100%-offline stand-in
// for Netflix's hover video previews. One tile every PREVIEW_TICK_MS, looping
// over the middle of the film (skip credits/studio logos at both ends).
const PREVIEW_TICK_MS = 700;
// The overlay's action row (6 size-8 buttons + gaps + padding) needs ~256px;
// 1.4× a narrow 2:3 poster tile (11vw at lg) stays under that on anything
// below ~1660px wide, squashing the round buttons into ellipses. Floor the
// overlay width instead — the existing `left` clamp absorbs the overhang.
const OVERLAY_MIN_WIDTH = 280;

// The tile is a vertical "cover": prefer the real 2:3 poster, then fall back
// to a cropped backdrop/thumb.
function posterImage(item: CatalogEntry): string | null {
  if (item.posterHash) return item.posterHash;
  if (item.backdropHash) return item.backdropHash;
  return (item.type === "movie" ? item.thumbHash : null) ?? null;
}

// The hover overlay is a LANDSCAPE preview (like a mini trailer frame), so it
// prefers the backdrop.
function landscapeImage(item: CatalogEntry): string | null {
  if (item.backdropHash) return item.backdropHash;
  if (item.type === "movie" && item.thumbHash) return item.thumbHash;
  return item.posterHash ?? null;
}

// --- trickplay hover preview ------------------------------------------------
// Module-level memo so re-hovering a card never refetches the detail JSON or
// the (possibly 404) trickplay meta. The sprite JPEG itself is one request,
// cached by the browser (private max-age + ETag). All failures resolve to
// null — the overlay just keeps its static backdrop, exactly as before.
const previewFileIdCache = new Map<string, number | null>();
const previewMetaCache = new Map<number, TrickplayMeta | null>();

async function resolvePreview(item: CatalogEntry): Promise<{ fileId: number; meta: TrickplayMeta } | null> {
  const key = `${item.type}:${item.id}`;
  let fileId = previewFileIdCache.get(key);
  if (fileId === undefined) {
    try {
      if (item.type === "movie") {
        const detail = await api.get<MovieDetail>(`/api/items/movie/${item.id}`);
        fileId = detail.files[0]?.id ?? null;
      } else {
        // A show previews its very first episode — the natural "trailer".
        const detail = await api.get<ShowDetail>(`/api/items/show/${item.id}`);
        fileId = detail.seasons[0]?.episodes[0]?.files[0]?.id ?? null;
      }
    } catch {
      fileId = null;
    }
    previewFileIdCache.set(key, fileId);
  }
  if (fileId === null) return null;
  let meta = previewMetaCache.get(fileId);
  if (meta === undefined) {
    try {
      meta = await api.get<TrickplayMeta>(`/api/trickplay/${fileId}`);
    } catch {
      meta = null; // sprite not generated (flag off) or kids-gated → static image
    }
    previewMetaCache.set(fileId, meta);
  }
  return meta ? { fileId, meta } : null;
}

function metaParts(item: CatalogEntry): string {
  const parts: string[] = [];
  if (item.year) parts.push(String(item.year));
  if (item.type === "movie") {
    // duration = 0 means "ffprobe failed" (failure-tolerant scan), not a
    // zero-minute film — showing "0 min" forever would just look broken.
    if (item.duration > 0) parts.push(formatDuration(item.duration));
  } else if (item.seasonCount) {
    parts.push(`${item.seasonCount} saison${item.seasonCount > 1 ? "s" : ""}`);
  }
  return parts.join(" · ");
}

function CardBase({ item }: { item: CatalogEntry }) {
  const ref = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  const openDetail = useUiStore((s) => s.openDetail);
  const closeDetail = useUiStore((s) => s.closeDetail);
  const notify = useUiStore((s) => s.notify);
  const openPlayer = usePlayerStore((s) => s.open);
  const inMyList = useStateStore((s) => s.isInMyList(item.type, item.id));
  const toggleMyList = useStateStore((s) => s.toggleMyList);
  const rating = useStateStore((s) => s.ratingFor(item.type, item.id));
  const setRating = useStateStore((s) => s.setRating);
  const setWatched = useStateStore((s) => s.setWatched);
  // « Nouveau » only while the title is both recent AND still unseen — same
  // "seen" semantics as rows.ts's buildSeenKeys (any watched progress row on
  // the title). The overlay's check button instead reflects FULLY watched
  // (every indexed episode for a show), since that's what it toggles.
  const seen = useStateStore((s) => s.seenTopKeys.has(`${item.type}:${item.id}`));
  const watched = useStateStore((s) => s.isWatched(item.type, item.id, item.type === "show" ? item.episodeCount : undefined));
  const match = useRecoStore((s) => s.matchFor(item.type, item.id));
  const showNewBadge = isNew(item.addedAt) && !seen;

  const clearTimer = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  const onEnter = () => {
    clearTimer();
    hoverTimer.current = window.setTimeout(() => {
      const box = ref.current?.getBoundingClientRect();
      if (box) setRect({ top: box.top, left: box.left, width: box.width });
      setExpanded(true);
    }, HOVER_DELAY_MS);
  };
  const onLeave = () => {
    clearTimer();
    setExpanded(false);
  };

  // The tile itself opens the detail sheet — mouse click, tap, or
  // Enter/Espace once the tile is focused. Keydowns bubbling up from the
  // portal overlay's own buttons are ignored (target !== currentTarget).
  const activate = () => {
    clearTimer();
    setExpanded(false);
    openDetail({ type: item.type, id: item.id });
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  };

  useEffect(() => clearTimer, []);

  // The expanded overlay is position:fixed via a portal, so any scroll —
  // window or a row rail (hence capture) — would leave it stranded at its old
  // coordinates. Close it instead, like Netflix does.
  useEffect(() => {
    if (!expanded) return;
    const onScroll = () => setExpanded(false);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [expanded]);

  const image = posterImage(item);
  const imageUrl = image ? api.imageUrl(image, 480) : null;
  const label = qualityLabel(item.quality.height);
  const meta = metaParts(item);

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={`Plus d’infos sur ${item.title}`}
      onClick={activate}
      onKeyDown={onKeyDown}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="group relative w-full cursor-pointer transition duration-200 ease-out-quart hover:-translate-y-1"
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-card bg-surface ring-1 ring-white/5 transition-shadow duration-200 group-hover:shadow-lift group-hover:ring-2 group-hover:ring-white/25">
        {imageUrl ? (
          <Image
            src={imageUrl}
            alt={item.title}
            fill
            sizes="(max-width: 768px) 30vw, 14vw"
            className="object-cover transition-transform duration-300 ease-out-quart group-hover:scale-[1.06]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-hover to-surface p-3 text-center text-sm font-semibold text-muted">
            {item.title}
          </div>
        )}
        {showNewBadge && <span className="absolute left-1.5 top-1.5 rounded-full bg-gradient-to-r from-accent to-[#ff4d55] px-2 py-px text-[10px] font-bold text-white shadow">Nouveau</span>}
        {label && <span className="absolute right-1.5 top-1.5 rounded-full glass px-2 py-px text-[10px] font-bold text-white">{label}</span>}
      </div>
      {/* Title + meta ALWAYS visible under the cover (not only on hover). */}
      <div className="mt-1.5 px-0.5">
        <p className="line-clamp-1 text-[13px] font-semibold text-white">{item.title}</p>
        {meta && <p className="line-clamp-1 text-[11px] text-muted/80">{meta}</p>}
      </div>

      {expanded &&
        rect &&
        typeof document !== "undefined" &&
        createPortal(
          <CardOverlay
            item={item}
            rect={rect}
            onMouseEnter={clearTimer}
            onMouseLeave={onLeave}
            inMyList={inMyList}
            rating={rating}
            watched={watched}
            match={match}
            onPlay={() => {
              setExpanded(false);
              // A play started from "Plus comme ça" inside the detail modal
              // should also dismiss the modal under the player (no-op otherwise).
              closeDetail();
              openPlayer({ kind: item.type, id: item.id, title: item.title });
            }}
            onToggleList={() => {
              void toggleMyList(item.type, item.id);
              notify(inMyList ? "Retiré de Ma liste" : "Ajouté à Ma liste");
            }}
            onRate={(value) => void setRating(item.type, item.id, value)}
            onToggleWatched={() => {
              void setWatched(item.type, item.id, !watched);
              notify(watched ? "Marqué comme non vu" : "Marqué comme vu");
            }}
            onOpenDetail={() => openDetail({ type: item.type, id: item.id })}
          />,
          document.body,
        )}
    </div>
  );
}

interface CardOverlayProps {
  item: CatalogEntry;
  rect: { top: number; left: number; width: number };
  inMyList: boolean;
  rating: number;
  watched: boolean;
  match: number | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onPlay: () => void;
  onToggleList: () => void;
  onRate: (value: number) => void;
  onToggleWatched: () => void;
  onOpenDetail: () => void;
}

function CardOverlay({ item, rect, inMyList, rating, watched, match, onMouseEnter, onMouseLeave, onPlay, onToggleList, onRate, onToggleWatched, onOpenDetail }: CardOverlayProps) {
  // Trickplay time-lapse preview. The overlay only mounts after the 500ms
  // hover intent, so this never fires on a casual mouse pass over a rail.
  const [preview, setPreview] = useState<{ fileId: number; meta: TrickplayMeta } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void resolvePreview(item).then((p) => {
      if (alive && p) setPreview(p);
    });
    return () => {
      alive = false;
    };
  }, [item]);

  useEffect(() => {
    if (!preview) return;
    const id = window.setInterval(() => setTick((t) => t + 1), PREVIEW_TICK_MS);
    return () => window.clearInterval(id);
  }, [preview]);

  const width = Math.max(rect.width * OVERLAY_SCALE, OVERLAY_MIN_WIDTH);
  const maxLeft = typeof window !== "undefined" ? window.innerWidth - width - 8 : rect.left;
  const left = Math.min(Math.max(8, rect.left - (width - rect.width) / 2), Math.max(8, maxLeft));
  // Anchor the LANDSCAPE preview near the top of the (taller) poster tile and
  // let it grow downward — centering a 16:9 panel on a 2:3 tile would float it
  // too high.
  const top = Math.max(8, rect.top - 12);

  const image = landscapeImage(item);
  const imageUrl = image ? api.imageUrl(image, 480) : null;
  const label = qualityLabel(item.quality.height);

  // Current sprite tile, scaled from the sprite's native tile size up to the
  // overlay width. Loops over the middle 8–92% of the runtime so the preview
  // never dwells on studio logos or end credits.
  const previewStyle = ((): CSSProperties | null => {
    if (!preview) return null;
    const { meta } = preview;
    const count = Math.max(1, Math.floor(meta.count));
    const start = Math.floor(count * 0.08);
    const span = Math.max(1, Math.floor(count * 0.92) - start);
    const index = start + (tick % span);
    const tile = trickplayTileFor(meta, index * Math.max(meta.interval, 1));
    const scale = meta.tileWidth > 0 ? width / meta.tileWidth : 1;
    return {
      backgroundImage: `url(/api/trickplay/${preview.fileId}?sprite=1)`,
      backgroundPosition: `${tile.offsetX * scale}px ${tile.offsetY * scale}px`,
      backgroundSize: `${meta.cols * meta.tileWidth * scale}px auto`,
    };
  })();

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // React portal events bubble through the *component* tree: without this,
      // clicking any overlay button would also trigger the card's own
      // openDetail click handler.
      onClick={(e) => e.stopPropagation()}
      style={{ position: "fixed", top, left, width, zIndex: 60 }}
      className="card-pop overflow-hidden rounded-panel bg-surface shadow-pop ring-1 ring-white/10"
    >
      <div className="relative aspect-video w-full overflow-hidden">
        {imageUrl ? (
          <Image src={imageUrl} alt={item.title} fill sizes="30vw" className="object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-surface-hover text-sm font-semibold text-muted">{item.title}</div>
        )}
        {/* Time-lapse preview fades in OVER the static backdrop once the
         * sprite is ready; a soft bottom scrim keeps it cinematic. */}
        {previewStyle && (
          <>
            <div aria-hidden className="animate-fade-up absolute inset-0" style={previewStyle} />
            <div aria-hidden className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/50 to-transparent" />
          </>
        )}
      </div>
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onPlay} aria-label="Lecture" className="icon-btn size-8 bg-white text-black hover:bg-white/80">
            <Play className="size-4 fill-black" />
          </button>
          <button
            type="button"
            onClick={onToggleList}
            aria-label={inMyList ? "Retirer de ma liste" : "Ajouter à ma liste"}
            className="icon-btn size-8 border border-white/25 bg-white/5 text-white hover:bg-white/15 hover:border-white/60"
          >
            {inMyList ? <Check className="size-4" /> : <Plus className="size-4" />}
          </button>
          <button
            type="button"
            onClick={() => onRate(1)}
            aria-label="J’aime"
            className={"icon-btn size-8 border text-white " + (rating >= 1 ? "border-white bg-white/10" : "border-white/25 bg-white/5 hover:bg-white/15 hover:border-white/60")}
          >
            <ThumbsUp className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => onRate(-1)}
            aria-label="Je n’aime pas"
            className={"icon-btn size-8 border text-white " + (rating === -1 ? "border-white bg-white/10" : "border-white/25 bg-white/5 hover:bg-white/15 hover:border-white/60")}
          >
            <ThumbsDown className="size-4" />
          </button>
          <button
            type="button"
            onClick={onToggleWatched}
            aria-label={watched ? "Marquer comme non vu" : "Marquer comme vu"}
            title={watched ? "Marquer comme non vu" : "Marquer comme vu"}
            className={
              "icon-btn size-8 border " +
              (watched ? "border-white bg-white/10 text-match" : "border-white/25 bg-white/5 text-white hover:bg-white/15 hover:border-white/60")
            }
          >
            <Check className="size-4" />
          </button>
          <button
            type="button"
            onClick={onOpenDetail}
            aria-label="Plus d’infos"
            className="icon-btn ml-auto size-8 border border-white/25 bg-white/5 text-white hover:bg-white/15 hover:border-white/60"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted">
          {match !== null && <span className="font-bold text-match">{match}% de correspondance</span>}
          {item.year && <span>{item.year}</span>}
          {/* duration = 0 means "ffprobe failed", not a 0-minute film */}
          {item.type === "movie" ? item.duration > 0 && <span>{formatDuration(item.duration)}</span> : <span>{item.seasonCount} saison{item.seasonCount > 1 ? "s" : ""}</span>}
          {label && <span className="rounded-full border border-white/30 px-1.5 text-[10px]">{label}</span>}
          {item.quality.hdr && <span className="rounded-full border border-white/30 px-1.5 text-[10px]">HDR</span>}
        </div>
        <p className="line-clamp-1 text-sm font-semibold text-white">{item.title}</p>
      </div>
    </div>
  );
}

// Memoised: HomeView re-renders on every progress/myList mutation (mark
// watched, add to list, rating), and without this every catalogue card in
// every row would re-run its five store selectors on each such action. `item`
// references are stable across those mutations (memoised on [movies, shows]),
// so memo skips the parent-driven re-render; a card whose OWN derived state
// changed still updates through its individual store subscriptions.
export const Card = memo(CardBase);
