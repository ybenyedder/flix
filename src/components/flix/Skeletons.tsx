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

export function SkeletonRow() {
  return (
    <div className="flex gap-2 overflow-hidden px-4 py-2 md:px-12" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="aspect-video w-[45vw] shrink-0 rounded-card shimmer sm:w-[30vw] md:w-[19vw] lg:w-[15vw]" />
      ))}
    </div>
  );
}

export function SkeletonGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="aspect-video rounded-card shimmer" />
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
