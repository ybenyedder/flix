"use client";

// App shell: gates on auth, then switches between views by store state, with
// a `?view=` deep link resolved once on mount. The video player (Phase 6) and
// this modal are the natural ssr:false split points — DetailModal fetches
// client-side data and manipulates document.body via a portal, so it has no
// useful server-rendered form anyway.
// Model: /home/pc/Documents/auralis_enterprise_grade/src/app/page.tsx

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { AuthGate } from "@/components/flix/AuthGate";
import { Header } from "@/components/flix/Header";
import { MobileNav } from "@/components/flix/MobileNav";
import { HistoryManager } from "@/components/flix/HistoryManager";
import { HomeView } from "@/components/flix/HomeView";
import { BrowseView } from "@/components/flix/BrowseView";
import { MyListView } from "@/components/flix/MyListView";
import { SearchView } from "@/components/flix/SearchView";
import { StatsView } from "@/components/flix/StatsView";
import { SettingsView } from "@/components/flix/SettingsView";
import { RequestsView } from "@/components/flix/RequestsView";
import { UploadManager } from "@/components/flix/upload/UploadManager";
import { useUiStore, type ViewId } from "@/store/ui";
import { useLibraryStore } from "@/store/library";
import { useStateStore } from "@/store/state";
import { useRecoStore } from "@/store/reco";
import { usePlayerStore } from "@/store/player";
import { useWatchPartyStore } from "@/store/watchParty";
import { useArrStore } from "@/store/arr";

const DetailModal = dynamic(() => import("@/components/flix/DetailModal").then((m) => m.DetailModal), { ssr: false });
const PlayerView = dynamic(() => import("@/components/flix/PlayerView").then((m) => m.PlayerView), { ssr: false });

const VALID_VIEWS: ViewId[] = ["home", "movies", "shows", "mylist", "search", "stats", "settings", "requests"];

// Announced to screen readers on each view switch — an SPA change is otherwise
// silent (no page reload), so a keyboard/SR user can't tell the content changed.
const VIEW_LABELS: Record<ViewId, string> = {
  home: "Accueil",
  movies: "Films",
  shows: "Séries",
  mylist: "Ma liste",
  search: "Recherche",
  stats: "Mon activité",
  settings: "Paramètres",
  requests: "Demandes",
};

function FlixShell() {
  const view = useUiStore((s) => s.view);
  const navigate = useUiStore((s) => s.navigate);
  const toast = useUiStore((s) => s.toast);
  const loadLibrary = useLibraryStore((s) => s.load);
  const loadState = useStateStore((s) => s.load);
  const loadReco = useRecoStore((s) => s.load);
  const loadArr = useArrStore((s) => s.load);
  const playbackRequest = usePlayerStore((s) => s.request);
  const restoreParty = useWatchPartyStore((s) => s.restore);

  useEffect(() => {
    void loadLibrary();
    void loadState();
    void loadReco();
    // Feature-gate probe for the opt-in *arr integration (drives the Header entry,
    // discover section and Home banner) — resolves to disabled by default.
    void loadArr();
    // Reconnect to an in-progress séance after a reload (membership survives a
    // brief drop server-side) — a no-op when there's no stored room code.
    restoreParty();
  }, [loadLibrary, loadState, loadReco, loadArr, restoreParty]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const requested = new URLSearchParams(window.location.search).get("view");
    if (requested && (VALID_VIEWS as string[]).includes(requested)) navigate(requested as ViewId);
    // Deep-link is resolved once on mount only; subsequent navigation flows
    // through the store, which keeps the URL in sync itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-shell min-h-screen">
      {/* Bypass-blocks (WCAG 2.4.1): a keyboard user can jump past the fixed
       * header's ~8 controls straight to the view. Hidden until focused. */}
      <a
        href="#main-content"
        className="sr-only rounded-full focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-black"
      >
        Passer au contenu
      </a>
      {/* Politely announces the current view on navigation (SPA route changes
       * are otherwise inaudible to screen readers). */}
      <div aria-live="polite" className="sr-only">
        {VIEW_LABELS[view]}
      </div>
      <HistoryManager />
      <Header />
      <MobileNav />
      <main id="main-content" tabIndex={-1} className="outline-none">
        {view === "home" && <HomeView />}
        {view === "movies" && <BrowseView kind="movie" />}
        {view === "shows" && <BrowseView kind="show" />}
        {view === "mylist" && <MyListView />}
        {view === "search" && <SearchView />}
        {view === "stats" && <StatsView />}
        {view === "settings" && <SettingsView />}
        {view === "requests" && <RequestsView />}
      </main>
      <DetailModal />
      {playbackRequest && <PlayerView />}
      <UploadManager />
      {toast && (
        // bottom-20 on mobile: clears the MobileNav tab bar.
        <div role="status" aria-live="polite" className="glass fade-up fixed bottom-20 left-1/2 z-[70] -translate-x-1/2 rounded-full px-5 py-2.5 text-sm font-medium text-white shadow-pop md:bottom-6">
          {toast}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  return (
    <AuthGate>
      <FlixShell />
    </AuthGate>
  );
}
