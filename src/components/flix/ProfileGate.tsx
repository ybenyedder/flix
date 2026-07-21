"use client";

// The "Qui regarde ?" screen shown by AuthGate whenever no session is active:
// a grid of profiles (from /api/auth/accounts) to pick, then a password
// prompt for the chosen one. Avatars are plain CSS gradients + initial — no
// image assets needed, matches the plan's "no external art" requirement.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useProfileStore } from "@/store/profile";
import { avatarGradient } from "@/lib/flix/avatar";

export function ProfileAvatar({ preset, name, size, interactive = false }: { preset: string; name: string; size?: number; interactive?: boolean }) {
  const [c0, c1] = avatarGradient(preset);
  const initial = (name || "?").charAt(0).toUpperCase();
  return (
    <span
      className={
        "grid shrink-0 place-items-center overflow-hidden rounded-2xl font-black text-white " +
        (interactive ? "size-28 shadow-card ring-2 ring-transparent transition duration-200 ease-spring group-hover:scale-105 group-hover:shadow-lift group-hover:ring-white/80 lg:size-36" : "")
      }
      style={{ background: `linear-gradient(150deg, ${c0}, ${c1})`, width: size, height: size, fontSize: size ? size * 0.4 : undefined }}
    >
      {initial}
    </span>
  );
}

function ProfileTile({ profile, onClick }: { profile: { username: string; avatar: string; isKids: boolean }; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group flex flex-col items-center gap-3">
      <ProfileAvatar preset={profile.avatar} name={profile.username} interactive />
      <span className="text-sm font-medium text-muted transition-colors group-hover:text-white lg:text-base">{profile.username}</span>
      {profile.isKids && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Enfants</span>}
    </button>
  );
}

export function ProfileGate() {
  const profiles = useProfileStore((s) => s.profiles);
  const profilesLoaded = useProfileStore((s) => s.profilesLoaded);
  const loadProfiles = useProfileStore((s) => s.loadProfiles);
  const login = useProfileStore((s) => s.login);

  const [selected, setSelected] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    if (selected) pwRef.current?.focus();
  }, [selected]);

  const pick = (username: string) => {
    setSelected(username);
    setPassword("");
    setError("");
  };
  const back = () => {
    setSelected(null);
    setPassword("");
    setError("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    const res = await login(selected, password);
    if (!res.ok) {
      setError(res.error ?? "Mot de passe incorrect");
      setBusy(false);
      pwRef.current?.focus();
    }
  };

  const selectedProfile = profiles.find((p) => p.username === selected);

  return (
    <div className="relative flex h-screen w-screen flex-col items-center justify-center overflow-hidden bg-background px-6">
      {/* Faint ambient light so the gate reads as a lit stage rather than a
       * void: one warm brand-red wash top-left, one cold blue answer bottom-
       * right — same cinema vocabulary as the Home billboard's glow. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(55% 45% at 18% 8%, rgb(229 9 20 / 0.13), transparent 70%), radial-gradient(50% 42% at 85% 88%, rgb(76 66 255 / 0.09), transparent 70%)",
        }}
      />
      <div className="absolute left-6 top-6 lg:left-10 lg:top-8">
        <span className="font-display text-2xl font-black tracking-tighter text-brand-gradient">FLIX</span>
      </div>

      {!selected ? (
        <div className="flex w-full max-w-4xl flex-col items-center">
          <h1 className="mb-10 text-center font-display text-4xl font-medium text-white lg:text-6xl">Qui regarde ?</h1>
          <div className="stagger-children flex flex-wrap items-start justify-center gap-6 lg:gap-10">
            {!profilesLoaded ? (
              Array.from({ length: 3 }).map((_, i) => <div key={i} className="size-28 animate-pulse rounded-2xl bg-surface lg:size-36" />)
            ) : profiles.length === 0 ? (
              <p className="text-muted">Aucun profil disponible.</p>
            ) : (
              profiles.map((p) => <ProfileTile key={p.username} profile={p} onClick={() => pick(p.username)} />)
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="card-surface animate-scale-in flex w-full max-w-sm flex-col items-center rounded-dialog p-8">
          <ProfileAvatar preset={selectedProfile?.avatar ?? "red"} name={selected} size={96} />
          <p className="mt-4 text-xl font-bold text-white">{selected}</p>
          <p className="mb-6 mt-1 text-sm text-muted">Entrez le mot de passe</p>
          <input
            ref={pwRef}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mot de passe"
            className="w-full rounded-field bg-white/5 px-4 py-3 text-center text-white outline-none ring-1 ring-white/10 transition focus:ring-accent/60"
          />
          <div role="alert" className="min-h-5 py-2 text-center text-sm text-accent">
            {error}
          </div>
          <button
            type="submit"
            disabled={busy || !password}
            className="w-full rounded-full bg-accent py-3 font-bold text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            {busy ? "Connexion…" : "Se connecter"}
          </button>
          <button type="button" onClick={back} className="mt-5 text-sm font-semibold uppercase tracking-wide text-muted transition-colors hover:text-white">
            ← Changer de profil
          </button>
        </form>
      )}
    </div>
  );
}
