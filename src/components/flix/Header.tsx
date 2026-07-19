"use client";

// Fixed top nav: logo, section links, expanding search, avatar menu. Fades
// from transparent to the solid background colour after 40px of scroll (or
// immediately on any non-Home view, since those don't have a hero to sit on).

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Search, X, ChevronDown, Shield, LogOut, RefreshCw, Shuffle, BarChart3, Settings, Download } from "lucide-react";
import { useUiStore, type ViewId } from "@/store/ui";
import { useProfileStore } from "@/store/profile";
import { useArrStore } from "@/store/arr";
import { useStateStore } from "@/store/state";
import { useLibraryStore } from "@/store/library";
import { useRecoStore } from "@/store/reco";
import { usePlayerStore } from "@/store/player";
import { resetProfileScopedStores } from "@/store/resetProfileScoped";
import { ProfileAvatar } from "./ProfileGate";
import { WatchPartyMenu } from "./WatchPartyMenu";
import { api, ApiError } from "@/lib/flix/api";
import { AVATAR_PRESETS } from "@/lib/flix/avatar";
import { filterForProfile } from "@/lib/flix/kids";
import { buildSeenKeys, pickSurprise } from "@/lib/flix/rows";

const NAV: { id: ViewId; label: string }[] = [
  { id: "home", label: "Accueil" },
  { id: "shows", label: "Séries" },
  { id: "movies", label: "Films" },
  { id: "mylist", label: "Ma liste" },
];

interface AdminUser {
  id: number;
  username: string;
  isAdmin: boolean;
  isKids: boolean;
  avatar: string;
}

function ManageProfiles() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: "", password: "", avatar: "blue", isKids: false });

  const load = () => {
    api
      .get<{ users: AdminUser[] }>("/api/auth/users")
      .then((d) => setUsers(d.users))
      .catch(() => setUsers([]))
      .finally(() => setLoaded(true));
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/api/auth/users", form);
      setForm({ username: "", password: "", avatar: "blue", isKids: false });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Échec de la création");
    } finally {
      setBusy(false);
    }
  };

  // Deleting a profile is destructive: the first click arms the button
  // ("Confirmer ?"), only a second click actually deletes.
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  const remove = async (id: number) => {
    if (confirmingId !== id) {
      setConfirmingId(id);
      return;
    }
    setConfirmingId(null);
    setError("");
    try {
      await api.del(`/api/auth/users?id=${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Échec de la suppression");
    }
  };

  return (
    <div className="mb-1 rounded-field bg-surface-hover p-2">
      {!loaded ? (
        <p className="px-1 py-1 text-xs text-muted">Chargement…</p>
      ) : (
        <ul className="mb-2 space-y-1">
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 text-xs text-white">
              <span className="truncate">
                {u.username}
                {u.isAdmin ? " (admin)" : ""}
              </span>
              <button
                type="button"
                onClick={() => void remove(u.id)}
                className={"shrink-0 " + (confirmingId === u.id ? "font-semibold text-accent" : "text-muted hover:text-accent")}
              >
                {confirmingId === u.id ? "Confirmer ?" : "Supprimer"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create} className="space-y-1.5">
        <input
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          placeholder="Identifiant"
          className="w-full rounded-field bg-white/5 px-2 py-1 text-xs text-white outline-none ring-1 ring-white/10 focus:ring-white/30"
        />
        <input
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          type="password"
          placeholder="Mot de passe"
          className="w-full rounded-field bg-white/5 px-2 py-1 text-xs text-white outline-none ring-1 ring-white/10 focus:ring-white/30"
        />
        <div className="flex items-center gap-2">
          <select
            value={form.avatar}
            onChange={(e) => setForm({ ...form, avatar: e.target.value })}
            className="rounded-field bg-white/5 px-1 py-1 text-xs text-white outline-none ring-1 ring-white/10 focus:ring-white/30"
          >
            {AVATAR_PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-muted">
            <input type="checkbox" checked={form.isKids} onChange={(e) => setForm({ ...form, isKids: e.target.checked })} /> Enfant
          </label>
        </div>
        {error && <p className="text-xs text-accent">{error}</p>}
        <button type="submit" disabled={busy || !form.username || !form.password} className="w-full rounded-full bg-accent py-1 text-xs font-semibold text-white disabled:opacity-40">
          {busy ? "…" : "Ajouter un profil"}
        </button>
      </form>
    </div>
  );
}

export function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // View to return to when the search closes — captured when search opens so
  // closing it from, say, "Séries" doesn't always dump the user on Home.
  const searchReturnView = useRef<ViewId>("home");

  const view = useUiStore((s) => s.view);
  const navigate = useUiStore((s) => s.navigate);
  const searchQuery = useUiStore((s) => s.searchQuery);
  const setSearchQuery = useUiStore((s) => s.setSearchQuery);
  const notify = useUiStore((s) => s.notify);

  const username = useProfileStore((s) => s.username);
  const avatar = useProfileStore((s) => s.avatar);
  const isAdmin = useProfileStore((s) => s.isAdmin);
  const isKids = useProfileStore((s) => s.isKids);
  const arrEnabled = useArrStore((s) => s.enabled);
  const logout = useProfileStore((s) => s.logout);
  const scan = useLibraryStore((s) => s.scan);
  const rescan = useLibraryStore((s) => s.rescan);
  const scanning = scan?.status === "scanning" || scan?.imaging;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The avatar menu closes on any pointerdown outside its container and on
  // Escape (also folding the "Gérer les profils" panel back up).
  useEffect(() => {
    if (!menuOpen) return;
    const closeMenu = () => {
      setMenuOpen(false);
      setManaging(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && e.target instanceof Node && !menuRef.current.contains(e.target)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const doLogout = async () => {
    setMenuOpen(false);
    // Reset every per-profile store, not just the personal state — otherwise
    // the next profile inherits the previous one's open player (and writes
    // ITS progress), detail modal, search, reco rows and live séance SSE.
    // Shared with the 401 path (AuthGate) via resetProfileScopedStores.
    await resetProfileScopedStores();
    await logout();
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    if (view === "search") navigate(searchReturnView.current);
  };
  const openSearch = () => {
    if (view !== "search") searchReturnView.current = view;
    setSearchOpen(true);
    navigate("search");
  };

  // "Surprends-moi": weighted random draw over the reco rows (top ranks weigh
  // more), skipping already-watched titles, falling back to any unseen
  // catalogue title (logic in rows.ts, tested). Movies start playing directly;
  // for a show, PlayerView resolves kind:"show" to its next-up episode itself,
  // so a plain open() is enough in both cases.
  const surpriseMe = () => {
    // Catalogue read via getState() (house convention for callbacks): a
    // useCatalog() subscription here re-rendered the entire Header on every
    // silent catalogue refresh — frequent during an imaging pass — for data
    // only this click handler consumes.
    const { movies, shows } = useLibraryStore.getState();
    const kidsFiltered = [...filterForProfile(movies, isKids), ...filterForProfile(shows, isKids)];
    const pick = pickSurprise(useRecoStore.getState().rows, kidsFiltered, buildSeenKeys(useStateStore.getState().progress));
    if (!pick) {
      notify("Aucun titre à proposer");
      return;
    }
    usePlayerStore.getState().open({ kind: pick.type, id: pick.id, title: pick.title });
  };

  return (
    <header
      className={
        "fixed inset-x-0 top-0 z-40 flex items-center gap-4 px-4 py-3 transition-colors duration-300 md:px-12 " +
        (scrolled || view !== "home" ? "glass border-b border-white/5" : "bg-gradient-to-b from-black/80 to-transparent")
      }
    >
      <button type="button" onClick={() => navigate("home")} className="shrink-0 text-2xl font-display font-black tracking-tighter text-accent">
        FLIX
      </button>

      <nav className="hidden gap-5 text-sm font-medium text-muted md:flex">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => navigate(item.id)}
            className={"transition-colors hover:text-white " + (view === item.id ? "text-white" : "")}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-4">
        <button
          type="button"
          onClick={surpriseMe}
          aria-label="Surprends-moi"
          title="Surprends-moi"
          className="flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-white"
        >
          <Shuffle className="size-5" />
          <span className="hidden lg:inline">Surprends-moi</span>
        </button>
        <WatchPartyMenu />
        <div className="flex items-center">
          {searchOpen && (
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (view !== "search") {
                  searchReturnView.current = view;
                  navigate("search");
                }
              }}
              placeholder="Titres, genres…"
              className="mr-1 w-40 rounded-full glass px-4 py-1.5 text-sm text-white outline-none sm:w-64"
            />
          )}
          <button
            type="button"
            aria-label={searchOpen ? "Fermer la recherche" : "Rechercher"}
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
            className="text-white"
          >
            {searchOpen ? <X className="size-5" /> : <Search className="size-5" />}
          </button>
        </div>

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-1"
            aria-label="Menu du profil"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <ProfileAvatar preset={avatar ?? "red"} name={username ?? "?"} size={32} />
            <ChevronDown className={"size-4 text-white transition-transform " + (menuOpen ? "rotate-180" : "")} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-2 w-64 glass rounded-panel p-2 shadow-pop animate-scale-in origin-top-right">
              <p className="truncate px-2 py-1.5 text-sm font-semibold text-white">{username}</p>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setManaging(false);
                  navigate("stats");
                }}
                className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-sm text-muted hover:bg-white/10 hover:text-white"
              >
                <BarChart3 className="size-4" /> Mon activité
              </button>
              {arrEnabled && !isKids && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setManaging(false);
                    navigate("requests");
                  }}
                  className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-sm text-muted hover:bg-white/10 hover:text-white"
                >
                  <Download className="size-4" /> Demandes
                </button>
              )}
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setManaging(false);
                    navigate("settings");
                  }}
                  className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-sm text-muted hover:bg-white/10 hover:text-white"
                >
                  <Settings className="size-4" /> Paramètres
                </button>
              )}
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setManaging((v) => !v)}
                  className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-sm text-muted hover:bg-white/10 hover:text-white"
                >
                  <Shield className="size-4" /> Gérer les profils
                </button>
              )}
              {managing && <ManageProfiles />}
              {isAdmin && (
                <button
                  type="button"
                  disabled={scanning}
                  onClick={() => void rescan()}
                  className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-sm text-muted hover:bg-white/10 hover:text-white disabled:opacity-40"
                >
                  <RefreshCw className={"size-4" + (scanning ? " animate-spin" : "")} />
                  {scanning ? "Analyse en cours…" : "Analyser la bibliothèque"}
                </button>
              )}
              <div className="my-1 divider-fade" />
              <button
                type="button"
                onClick={() => void doLogout()}
                className="flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-sm text-muted hover:bg-white/10 hover:text-white"
              >
                <LogOut className="size-4" /> Se déconnecter
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
