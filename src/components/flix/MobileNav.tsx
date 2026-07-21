"use client";

// Netflix-app-style bottom tab bar, mobile only (hidden ≥ md where the
// header's pill nav takes over). Before this, small screens had NO visible
// navigation besides the avatar menu — the four main views were unreachable
// in one tap. Sits under the player/modals (z-40 vs their z-50) and pads for
// the home-indicator safe area on notched phones.

import { Bookmark, Film, Home, Tv } from "lucide-react";
import { useUiStore, type ViewId } from "@/store/ui";

const TABS: { id: ViewId; label: string; icon: typeof Home }[] = [
  { id: "home", label: "Accueil", icon: Home },
  { id: "shows", label: "Séries", icon: Tv },
  { id: "movies", label: "Films", icon: Film },
  { id: "mylist", label: "Ma liste", icon: Bookmark },
];

export function MobileNav() {
  const view = useUiStore((s) => s.view);
  const navigate = useUiStore((s) => s.navigate);

  return (
    <nav
      aria-label="Navigation principale"
      className="glass fixed inset-x-0 bottom-0 z-40 flex border-t border-white/5 pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {TABS.map((tab) => {
        const active = view === tab.id;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => navigate(tab.id)}
            aria-current={active ? "page" : undefined}
            className={"flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors " + (active ? "text-white" : "text-muted")}
          >
            <Icon className={"size-5 " + (active ? "" : "opacity-80")} />
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
