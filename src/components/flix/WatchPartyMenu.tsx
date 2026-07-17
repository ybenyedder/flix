"use client";

// Header entry point for watch parties ("Séance"). Create a room or join one by
// code, see who's in, copy/share the code, and leave. Once a room exists the
// host just browses and hits "Lecture" as usual — PlayerView publishes what the
// host plays to the room (see its host-push effect); guests are pulled into the
// same title automatically. This menu is only the lobby/roster around that.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Popcorn, Copy, Check, DoorOpen, LogIn, Crown, X, Loader2 } from "lucide-react";
import { useWatchPartyStore } from "@/store/watchParty";
import { usePlayerStore } from "@/store/player";
import { useUiStore } from "@/store/ui";
import { normalizeRoomCode } from "@/lib/flix/party";
import { ProfileAvatar } from "./ProfileGate";

export function WatchPartyMenu() {
  const [open, setOpen] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const active = useWatchPartyStore((s) => s.active);
  const connecting = useWatchPartyStore((s) => s.connecting);
  const connected = useWatchPartyStore((s) => s.connected);
  const code = useWatchPartyStore((s) => s.code);
  const members = useWatchPartyStore((s) => s.members);
  const playback = useWatchPartyStore((s) => s.playback);
  const isHost = useWatchPartyStore((s) => s.isHost());
  const create = useWatchPartyStore((s) => s.create);
  const join = useWatchPartyStore((s) => s.join);
  const leave = useWatchPartyStore((s) => s.leave);
  const rejoinScreen = useWatchPartyStore((s) => s.rejoinScreen);
  const playerReq = usePlayerStore((s) => s.request);
  const notify = useUiStore((s) => s.notify);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && e.target instanceof Node && !menuRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const doCreate = async () => {
    setBusy(true);
    setError("");
    const res = await create();
    setBusy(false);
    if (!res.ok) setError(res.error ?? "Impossible de créer la séance");
  };

  const doJoin = async (e: FormEvent) => {
    e.preventDefault();
    const c = normalizeRoomCode(joinCode);
    if (!c) return;
    setBusy(true);
    setError("");
    const res = await join(c);
    setBusy(false);
    if (res.ok) setJoinCode("");
    else setError(res.error ?? "Impossible de rejoindre la séance");
  };

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      notify(`Code de la séance : ${code}`);
    }
  };

  // Guest who has the room's title available but isn't currently on it (closed
  // the player, or wandered off to another title).
  const canRejoinScreen = active && !isHost && !!playback.target && (!playerReq || !playerReq.fromParty);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Séance"
        title="Séance — regarder ensemble"
        aria-haspopup="menu"
        aria-expanded={open}
        className={"relative flex items-center gap-1.5 text-sm font-medium transition-colors hover:text-white " + (active ? "text-accent" : "text-muted")}
      >
        <Popcorn className="size-5" />
        <span className="hidden lg:inline">Séance</span>
        {active && <span className="absolute -right-1 -top-1 size-2 rounded-full bg-accent" />}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 glass rounded-panel p-3 shadow-pop animate-scale-in origin-top-right">
          {!active ? (
            <>
              <p className="mb-1 text-sm font-semibold text-white">Regarder ensemble</p>
              <p className="mb-3 text-xs text-muted">Créez une séance et partagez le code : lecture, pause et avance synchronisées pour tout le monde.</p>
              <button
                type="button"
                onClick={() => void doCreate()}
                disabled={busy}
                className="mb-3 flex w-full items-center justify-center gap-2 rounded-full bg-accent py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Popcorn className="size-4" />} Créer une séance
              </button>
              <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted">
                <span className="h-px flex-1 bg-white/10" /> ou <span className="h-px flex-1 bg-white/10" />
              </div>
              <form onSubmit={doJoin} className="space-y-2">
                <input
                  value={joinCode}
                  onChange={(e) => setJoinCode(normalizeRoomCode(e.target.value))}
                  placeholder="Code de séance"
                  maxLength={6}
                  className="w-full rounded-field bg-white/5 px-2 py-2 text-center text-lg font-bold tracking-[0.3em] text-white outline-none ring-1 ring-white/10 placeholder:text-sm placeholder:font-normal placeholder:tracking-normal placeholder:text-muted"
                />
                <button
                  type="submit"
                  disabled={busy || normalizeRoomCode(joinCode).length < 6}
                  className="flex w-full items-center justify-center gap-2 rounded-full bg-surface-hover py-2 text-sm font-semibold text-white hover:bg-white/15 disabled:opacity-50"
                >
                  <LogIn className="size-4" /> Rejoindre
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-white">{isHost ? "Votre séance" : "Séance"}</span>
                <span className={"flex items-center gap-1 text-[10px] " + (connected ? "text-green-400" : "text-muted")}>
                  <span className={"size-1.5 rounded-full " + (connected ? "bg-green-400" : connecting ? "bg-yellow-400" : "bg-muted")} />
                  {connected ? "connecté" : connecting ? "connexion…" : "hors ligne"}
                </span>
              </div>

              <button
                type="button"
                onClick={() => void copyCode()}
                className="mb-3 flex w-full items-center justify-between gap-2 rounded-field bg-white/5 px-3 py-2 text-left ring-1 ring-white/10 hover:bg-white/15"
                title="Copier le code"
              >
                <span className="text-2xl font-black tracking-[0.3em] text-white">{code}</span>
                {copied ? <Check className="size-4 text-green-400" /> : <Copy className="size-4 text-muted" />}
              </button>

              <p className="mb-2 text-xs text-muted">
                {isHost ? "Choisissez un titre et lancez la lecture : tout le monde suit." : playback.target ? "L'hôte a lancé un titre." : "En attente que l'hôte lance un titre…"}
              </p>

              <ul className="mb-3 max-h-40 space-y-1.5 overflow-y-auto">
                {members.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2 text-sm">
                    <div className={"relative shrink-0 " + (m.online ? "" : "opacity-40 grayscale")}>
                      <ProfileAvatar preset={m.avatar} name={m.username} size={26} />
                      {m.isHost && <Crown className="absolute -right-1 -top-1 size-3 fill-yellow-400 text-yellow-400" />}
                    </div>
                    <span className="truncate text-white">{m.username}</span>
                    {m.isHost && <span className="text-[10px] text-muted">hôte</span>}
                    {!m.online && <span className="ml-auto text-[10px] text-muted">hors ligne</span>}
                  </li>
                ))}
              </ul>

              {canRejoinScreen && (
                <button
                  type="button"
                  onClick={() => {
                    rejoinScreen();
                    setOpen(false);
                  }}
                  className="mb-2 flex w-full items-center justify-center gap-2 rounded-full bg-accent py-2 text-sm font-semibold text-white hover:bg-accent-hover"
                >
                  <Popcorn className="size-4" /> Rejoindre l&apos;écran
                </button>
              )}

              <button
                type="button"
                onClick={() => void leave()}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-surface-hover py-2 text-sm font-semibold text-white hover:bg-white/15"
              >
                <DoorOpen className="size-4" /> Quitter la séance
              </button>
            </>
          )}

          {error && <p className="mt-2 flex items-center gap-1 text-xs text-accent"><X className="size-3" /> {error}</p>}
        </div>
      )}
    </div>
  );
}
