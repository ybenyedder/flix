"use client";

// Full-screen detail overlay: backdrop, logo/title, action buttons, metadata,
// and — for shows — a season picker over EpisodeRow. Movies with several
// files additionally get a version picker (« 2160p », « Director's Cut »…)
// whose choice rides the play request as mediaFileId. "Plus comme ça" here is a
// deliberately simple shared-genre heuristic (relatedItems): the full reco
// engine drives the Home rows, while the modal keeps this lightweight local
// version rather than round-tripping the server for one panel.
//
// DetailModalContent is remounted (via `key`) whenever the target changes, so
// its local state (detail/loading/seasonId) starts fresh for every item —
// deliberately avoiding an effect that resets state when a prop changes,
// which react-hooks/set-state-in-effect flags as a footgun.

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { X, Play, Plus, Check, ThumbsUp, ThumbsDown } from "lucide-react";
import { api } from "@/lib/flix/api";
import type { MovieDetail, ShowDetail } from "@/lib/flix/types";
import { qualityLabel, versionLabel } from "@/lib/flix/quality";
import { formatDuration } from "@/lib/flix/format";
import { relatedItems } from "@/lib/flix/rows";
import { useUiStore, type DetailTarget } from "@/store/ui";
import { usePlayerStore } from "@/store/player";
import { useStateStore } from "@/store/state";
import { useCatalog } from "@/lib/flix/useCatalog";
import { Card } from "./Card";
import { EpisodeRow } from "./EpisodeRow";
import { SkeletonDetail } from "./Skeletons";

type Detail = MovieDetail | ShowDetail;

export function DetailModal() {
  const target = useUiStore((s) => s.detail);
  if (!target) return null;
  return <DetailModalContent key={`${target.type}-${target.id}`} target={target} />;
}

function DetailModalContent({ target }: { target: DetailTarget }) {
  const closeDetail = useUiStore((s) => s.closeDetail);
  const notify = useUiStore((s) => s.notify);
  const openPlayer = usePlayerStore((s) => s.open);
  const { movies, shows } = useCatalog();

  const inMyList = useStateStore((s) => s.isInMyList(target.type, target.id));
  const toggleMyList = useStateStore((s) => s.toggleMyList);
  const rating = useStateStore((s) => s.ratingFor(target.type, target.id));
  const setRating = useStateStore((s) => s.setRating);
  const setWatched = useStateStore((s) => s.setWatched);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [seasonId, setSeasonId] = useState<number | null>(null);
  // Version (media file) picked for a multi-file movie — null = the default
  // (files[0], the player's historical pick). Reset per item via the
  // component's remount key. Single-file movies never show the picker.
  const [versionFileId, setVersionFileId] = useState<number | null>(null);

  // "Vu" for a show means every indexed episode is watched — computed against
  // the loaded detail (the authoritative episode list) rather than a count.
  const episodeIds = detail?.type === "show" ? detail.seasons.flatMap((s) => s.episodes.map((e) => e.id)) : null;
  const watched = useStateStore((s) => (episodeIds ? s.isWatched("show", target.id, episodeIds.length) : s.isWatched("movie", target.id)));

  useEffect(() => {
    let alive = true;
    const path = target.type === "movie" ? `/api/items/movie/${target.id}` : `/api/items/show/${target.id}`;
    api
      .get<Detail>(path)
      .then((data) => {
        if (!alive) return;
        setDetail(data);
        if (data.type === "show") setSeasonId(data.seasons[0]?.id ?? null);
      })
      .catch(() => {
        if (!alive) return;
        notify("Impossible de charger la fiche");
        closeDetail();
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [target, closeDetail, notify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // While playback runs on top of the modal, Escape belongs to the player;
      // without this guard one press would close both layers at once.
      if (usePlayerStore.getState().request) return;
      closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDetail]);

  // A11y: lock body scroll behind the modal, move focus onto the close
  // button, and hand it back to the triggering element once the modal closes.
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // aria-modal alone doesn't trap anything: Tab happily walked out of the
  // dialog into the visually-hidden page behind it. Cycle Tab/Shift+Tab over
  // the dialog's focusable elements — the native <dialog> behaviour,
  // hand-rolled because this modal predates useable ::backdrop styling.
  const trapFocus = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(
      (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  // A dismiss must be a full press ON the backdrop: pointerdown memorised
  // here, re-checked on click — so clicking the modal's scrollbar or dragging
  // from the content out to the backdrop doesn't close the modal.
  const backdropPressRef = useRef(false);
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, []);

  const backdrop = detail?.backdropHash ? api.imageUrl(detail.backdropHash, 1440) : null;
  const logo = detail?.logoHash ? api.imageUrl(detail.logoHash, 960) : null;
  const label = detail ? qualityLabel(detail.quality.height) : null;
  const related = detail ? relatedItems(detail, [...movies, ...shows], 18) : [];
  const activeSeason = detail && detail.type === "show" ? (detail.seasons.find((s) => s.id === seasonId) ?? detail.seasons[0]) : undefined;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/70 py-6 backdrop-blur-sm md:py-12"
      onPointerDown={(e) => {
        backdropPressRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (backdropPressRef.current && e.target === e.currentTarget) closeDetail();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={detail?.title ?? "Fiche du titre"}
        className="relative mx-auto max-w-4xl overflow-hidden rounded-dialog bg-surface shadow-pop ring-1 ring-white/10 animate-scale-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapFocus}
      >
        <button
          ref={closeButtonRef}
          type="button"
          onClick={closeDetail}
          aria-label="Fermer"
          className="absolute right-4 top-4 z-10 grid size-9 place-items-center glass rounded-full text-white transition-colors hover:bg-white/15"
        >
          <X className="size-5" />
        </button>

        {loading && !detail && <SkeletonDetail />}

        {detail && (
          <>
            <div className="relative aspect-video w-full">
              {backdrop ? (
                <Image src={backdrop} alt="" fill sizes="900px" className="object-cover" />
              ) : (
                <div className="h-full w-full bg-gradient-to-br from-surface-hover to-surface" />
              )}
              <div className="detail-fade-bottom absolute inset-0" />
              <div className="absolute bottom-6 left-6 right-6">
                {logo ? (
                  <div className="relative mb-3 h-16 w-2/3 max-w-sm">
                    <Image src={logo} alt={detail.title} fill sizes="400px" className="object-contain object-left" />
                  </div>
                ) : (
                  <h2 className="mb-3 font-display text-2xl font-black text-white md:text-4xl">{detail.title}</h2>
                )}
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      openPlayer({
                        kind: target.type,
                        id: target.id,
                        title: detail.title,
                        mediaFileId: detail.type === "movie" && versionFileId !== null ? versionFileId : undefined,
                      });
                      closeDetail();
                    }}
                    className="flex items-center gap-2 rounded-full bg-white px-5 py-2 font-bold text-black transition-colors hover:bg-white/80"
                  >
                    <Play className="size-5 fill-black" /> Lecture
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void toggleMyList(target.type, target.id);
                      notify(inMyList ? "Retiré de Ma liste" : "Ajouté à Ma liste");
                    }}
                    aria-label={inMyList ? "Retirer de ma liste" : "Ajouter à ma liste"}
                    className="grid size-10 place-items-center rounded-full border border-white/25 bg-white/5 text-white backdrop-blur-sm transition-colors hover:border-white/60 hover:bg-white/15"
                  >
                    {inMyList ? <Check className="size-5" /> : <Plus className="size-5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void setWatched(target.type, target.id, !watched, episodeIds ? { episodeIds } : undefined);
                      notify(watched ? "Marqué comme non vu" : "Marqué comme vu");
                    }}
                    aria-label={watched ? "Marquer comme non vu" : "Marquer comme vu"}
                    title={watched ? "Marquer comme non vu" : "Marquer comme vu"}
                    className={
                      "grid size-10 place-items-center rounded-full border backdrop-blur-sm transition-colors " +
                      (watched ? "border-white/60 bg-white/15 text-green-500" : "border-white/25 bg-white/5 text-white hover:border-white/60 hover:bg-white/15")
                    }
                  >
                    <Check className="size-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void setRating(target.type, target.id, 1)}
                    aria-label="J’aime"
                    className={"grid size-10 place-items-center rounded-full border text-white backdrop-blur-sm transition-colors " + (rating >= 1 ? "border-white/60 bg-white/15" : "border-white/25 bg-white/5 hover:border-white/60 hover:bg-white/15")}
                  >
                    <ThumbsUp className="size-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void setRating(target.type, target.id, -1)}
                    aria-label="Je n’aime pas"
                    className={"grid size-10 place-items-center rounded-full border text-white backdrop-blur-sm transition-colors " + (rating === -1 ? "border-white/60 bg-white/15" : "border-white/25 bg-white/5 hover:border-white/60 hover:bg-white/15")}
                  >
                    <ThumbsDown className="size-5" />
                  </button>
                </div>
                {detail.type === "movie" && detail.files.length > 1 && (
                  <div className="mt-3 flex items-center gap-2">
                    <label htmlFor="detail-version" className="text-xs font-semibold uppercase tracking-wide text-white/70">
                      Version
                    </label>
                    <select
                      id="detail-version"
                      value={versionFileId ?? detail.files[0].id}
                      onChange={(e) => setVersionFileId(Number(e.target.value))}
                      className="rounded-field bg-white/5 px-3 py-1.5 text-sm text-white outline-none ring-1 ring-white/10"
                    >
                      {detail.files.map((file, index) => (
                        <option key={file.id} value={file.id}>
                          {versionLabel(file, index)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            <div className="grid gap-6 p-6 md:grid-cols-[2fr_1fr]">
              <div>
                <div className="mb-3 flex flex-wrap items-center gap-3 text-sm text-muted">
                  {detail.year && <span className="font-semibold text-green-500">{detail.year}</span>}
                  {detail.contentRating && <span className="rounded-full border border-white/30 px-1.5 py-0.5 text-xs">{detail.contentRating}</span>}
                  {/* duration = 0 means "ffprobe failed", not a 0-minute film */}
                  {detail.type === "movie" ? (
                    detail.duration > 0 && <span>{formatDuration(detail.duration)}</span>
                  ) : (
                    <span>
                      {detail.seasonCount} saison{detail.seasonCount > 1 ? "s" : ""}
                    </span>
                  )}
                  {label && <span className="rounded-full border border-white/30 px-1.5 py-0.5 text-xs">{label}</span>}
                  {detail.quality.hdr && <span className="rounded-full border border-white/30 px-1.5 py-0.5 text-xs">HDR</span>}
                </div>
                {detail.type === "movie" && detail.tagline && <p className="mb-2 text-sm italic text-muted">{detail.tagline}</p>}
                {detail.synopsis && <p className="text-sm text-white">{detail.synopsis}</p>}
              </div>
              <div className="space-y-2 text-sm text-muted">
                {detail.genres.length > 0 && (
                  <p>
                    <span className="text-muted/70">Genres : </span>
                    {detail.genres.join(", ")}
                  </p>
                )}
                {detail.type === "movie" && detail.directors.length > 0 && (
                  <p>
                    <span className="text-muted/70">Réalisation : </span>
                    {detail.directors.join(", ")}
                  </p>
                )}
                {detail.actors.length > 0 && (
                  <p>
                    <span className="text-muted/70">Avec : </span>
                    {detail.actors
                      .slice(0, 6)
                      .map((a) => a.name)
                      .join(", ")}
                  </p>
                )}
                {detail.studio && (
                  <p>
                    <span className="text-muted/70">Studio : </span>
                    {detail.studio}
                  </p>
                )}
              </div>
            </div>

            {detail.type === "show" && (
              <div className="p-6">
                <div className="divider-fade -mx-6 -mt-6 mb-6" />
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-white">Épisodes</h3>
                  {detail.seasons.length > 1 && (
                    <select
                      value={activeSeason?.id ?? ""}
                      onChange={(e) => setSeasonId(Number(e.target.value))}
                      className="rounded-field bg-white/5 px-3 py-1.5 text-sm text-white outline-none ring-1 ring-white/10"
                    >
                      {detail.seasons.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.seasonNumber === 0 ? "Spéciaux" : `Saison ${s.seasonNumber}`}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div>
                  {(activeSeason?.episodes ?? []).map((episode) => (
                    <EpisodeRow key={episode.id} episode={episode} showId={detail.id} showTitle={detail.title} />
                  ))}
                  {(activeSeason?.episodes ?? []).length === 0 && <p className="text-sm text-muted">Aucun épisode indexé pour cette saison.</p>}
                </div>
              </div>
            )}

            {related.length > 0 && (
              <div className="p-6">
                <div className="divider-fade -mx-6 -mt-6 mb-6" />
                <h3 className="mb-4 text-lg font-semibold text-white">Plus comme ça</h3>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {related.map((item) => (
                    <Card key={`${item.type}-${item.id}`} item={item} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
