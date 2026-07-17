import { type LucideIcon } from "lucide-react";

export function Section({ title, icon: Icon, children }: { title: string; icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <section className="mt-8 first:mt-0">
      <div className="mb-3 flex items-center gap-2.5">
        {Icon && (
          <span className="grid size-8 shrink-0 place-items-center rounded-field bg-white/5">
            <Icon className="size-4 text-muted" />
          </span>
        )}
        <h2 className="font-display text-base font-semibold text-white">{title}</h2>
      </div>
      <div className="card-surface p-5">{children}</div>
    </section>
  );
}
