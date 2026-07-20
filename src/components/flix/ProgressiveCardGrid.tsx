"use client";

// Progressive grid rendering: only the first BATCH tiles mount, and an
// IntersectionObserver sentinel appends the next batch as the user nears the
// bottom. This bounds the DOM on large catalogues (Browse used to mount every
// title at once). Chosen over content-visibility — whose permanent paint
// containment clips the cards' hover shadow/ring at the border-box — and over
// a windowing library (scroll-restore/focus complexity for little extra gain:
// tiles are images, the win is simply not mounting thousands of them).
//
// The batch counter lives HERE so consumers reset it the idiomatic way: mount
// with a `key` derived from whatever defines the list (filters/sort/query) —
// see CLAUDE.md "reset local state by remounting via key=".

import { useEffect, useRef, useState } from "react";
import type { CatalogEntry } from "@/lib/flix/types";
import { Card } from "./Card";

const BATCH = 42; // a few viewports of the densest (7-column) layout

export function ProgressiveCardGrid({ items, gridClassName }: { items: CatalogEntry[]; gridClassName: string }) {
  const [count, setCount] = useState(BATCH);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Clamp instead of syncing state to props: a list that shrank below the
  // counter just renders fully; the sentinel unmounts and growth stops.
  const hasMore = count < items.length;

  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    // Generous rootMargin: the next batch mounts well before the sentinel is
    // actually visible, so normal scrolling never hits a blank gap.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setCount((c) => c + BATCH);
      },
      { rootMargin: "1200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore]);

  return (
    <>
      <div className={gridClassName}>
        {items.slice(0, count).map((item) => (
          <Card key={`${item.type}-${item.id}`} item={item} />
        ))}
      </div>
      {hasMore && <div ref={sentinelRef} aria-hidden className="h-px" />}
    </>
  );
}
