"use client";

// Shared empty/error placeholder: a centered card-surface panel with an icon in
// a soft circle, a title, a line of direction, and an optional call to action.
// An empty screen is an invitation to act — every use gives the reader a next
// step, never just a dead end. Reused by Home (empty library, load error),
// Ma liste, and any future empty view so they all read as one system.

import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  className = "",
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}) {
  return (
    <div className={"card-surface animate-fade-up mx-auto flex max-w-md flex-col items-center gap-4 rounded-dialog p-10 text-center " + className}>
      <span className="grid size-14 shrink-0 place-items-center rounded-full bg-white/[0.07] text-white/75">{icon}</span>
      <div className="space-y-1.5">
        <p className="text-lg font-semibold text-white">{title}</p>
        <p className="text-sm text-muted">{description}</p>
      </div>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-1 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition duration-200 ease-out-quart hover:bg-accent-hover active:scale-[0.97]"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
