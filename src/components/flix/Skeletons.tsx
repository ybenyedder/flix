// Loading placeholders reusing the global `.shimmer` sweep (globals.css), so
// a cold Home/Browse/Search/Detail load reads as "loading" instead of a
// blank stage or a premature empty state.

export function SkeletonHero() {
  return (
    <div className="relative h-[56vw] max-h-[80vh] min-h-[420px] w-full shimmer" aria-hidden>
      <div className="hero-fade-bottom absolute inset-0" />
    </div>
  );
}

// Tile shape/widths mirror the REAL views (2:3 posters — Card.tsx, Row.tsx
// itemClassName, BrowseView grid): a skeleton in yesterday's 16:9 layout
// would swap to portrait jackets on load, a big layout shift on every
// Browse/Search navigation.
export function SkeletonRow() {
  return (
    <div className="flex gap-2 overflow-hidden px-4 py-2 md:px-12" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="aspect-[2/3] w-[30vw] shrink-0 rounded-card shimmer sm:w-[20vw] md:w-[14vw] lg:w-[11vw]" />
      ))}
    </div>
  );
}

export function SkeletonGrid({ count = 14 }: { count?: number }) {
  return (
    <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="aspect-[2/3] rounded-card shimmer" />
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
