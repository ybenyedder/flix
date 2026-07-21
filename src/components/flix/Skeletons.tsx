// Loading placeholders reusing the global `.shimmer` sweep (globals.css), so
// a cold Home/Browse/Search/Detail load reads as "loading" instead of a
// blank stage or a premature empty state.

export function SkeletonHero() {
  return (
    <div className="relative h-[60vw] max-h-[85vh] min-h-[440px] w-full shimmer" aria-hidden>
      <div className="hero-fade-bottom absolute inset-0" />
    </div>
  );
}

// Tile shape/widths/gaps mirror the REAL views (2:3 posters + caption block —
// Card.tsx; gap-3 rail — Row.tsx; gap-3 grid — SearchView): any drift here
// (16:9 tiles, different gaps, missing caption height) shows up as a layout
// shift at every skeleton→content swap.
function SkeletonTile({ className = "" }: { className?: string }) {
  return (
    <div className={className}>
      <div className="aspect-[2/3] rounded-card shimmer" />
      {/* Matches the real card's caption block (title + meta line). */}
      <div className="mt-1.5 h-3.5 w-3/4 rounded-card shimmer" />
      <div className="mt-1 h-3 w-1/2 rounded-card shimmer" />
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="flex gap-3 overflow-hidden px-4 py-2 md:px-12" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        <SkeletonTile key={i} className="w-[30vw] shrink-0 sm:w-[20vw] md:w-[14vw] lg:w-[11vw]" />
      ))}
    </div>
  );
}

export function SkeletonGrid({ count = 14 }: { count?: number }) {
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonTile key={i} />
      ))}
    </div>
  );
}

export function SkeletonDetail() {
  return (
    <div className="space-y-4 p-6" aria-hidden>
      <div className="aspect-video w-full rounded-card shimmer" />
      <div className="h-6 w-1/2 rounded-card shimmer" />
      <div className="h-4 w-full rounded-card shimmer" />
      <div className="h-4 w-2/3 rounded-card shimmer" />
    </div>
  );
}
