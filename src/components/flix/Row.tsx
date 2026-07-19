"use client";

// Generic horizontal carousel: title, scroll-snapped track, hover chevrons.
// Generic over T so it can host catalogue cards, Top 10 cards or Continue
// Watching cards without any unsafe casting at the call site.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function Row<T>({
  title,
  items,
  keyFor,
  renderItem,
  // Default sizing suits the 2:3 POSTER cards (most rows). Rows of landscape
  // cards (Continuer à regarder, Top 10) pass a wider itemClassName.
  itemClassName = "w-[30vw] sm:w-[20vw] md:w-[14vw] lg:w-[11vw]",
}: {
  title: string;
  items: T[];
  keyFor: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  itemClassName?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const updateArrows = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateArrows();
    const el = trackRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateArrows, { passive: true });
    window.addEventListener("resize", updateArrows);
    return () => {
      el.removeEventListener("scroll", updateArrows);
      window.removeEventListener("resize", updateArrows);
    };
  }, [updateArrows, items.length]);

  const scrollByPage = (direction: 1 | -1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.9, behavior: "smooth" });
  };

  if (!items.length) return null;

  return (
    <section className="relative py-3">
      <h2 className="mb-2 px-4 font-display text-lg font-semibold tracking-tight text-white md:px-12 md:text-xl">{title}</h2>
      <div className="group/row relative">
        {canLeft && (
          <button
            type="button"
            onClick={() => scrollByPage(-1)}
            aria-label="Précédent"
            className="absolute left-0 top-0 z-10 hidden h-full w-12 items-center justify-center bg-gradient-to-r from-black/70 to-transparent text-white opacity-0 transition-opacity group-hover/row:opacity-100 md:flex"
          >
            <span className="grid size-9 place-items-center rounded-full glass">
              <ChevronLeft className="size-6" />
            </span>
          </button>
        )}
        <div ref={trackRef} className="no-scrollbar scroll-snap-row stagger-children flex gap-3 overflow-x-auto px-4 md:px-12">
          {items.map((item, index) => (
            <div key={keyFor(item)} className={"scroll-snap-item shrink-0 " + itemClassName}>
              {renderItem(item, index)}
            </div>
          ))}
        </div>
        {canRight && (
          <button
            type="button"
            onClick={() => scrollByPage(1)}
            aria-label="Suivant"
            className="absolute right-0 top-0 z-10 hidden h-full w-12 items-center justify-center bg-gradient-to-l from-black/70 to-transparent text-white opacity-0 transition-opacity group-hover/row:opacity-100 md:flex"
          >
            <span className="grid size-9 place-items-center rounded-full glass">
              <ChevronRight className="size-6" />
            </span>
          </button>
        )}
      </div>
    </section>
  );
}
