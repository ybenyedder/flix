"use client";

// « Paramètres » — admin-only server settings: media folder (view/repoint +
// manual scan with live progress), the automatic-rescan toggle, a database
// backup download, and the effective server configuration (read-only, served
// by GET /api/admin/settings — the client never imports server config).

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Download, FolderOpen, ImageIcon, RefreshCw, Server } from "lucide-react";
import { api, ApiError } from "@/lib/flix/api";
import { useProfileStore } from "@/store/profile";
import { useLibraryStore } from "@/store/library";
import { useUiStore } from "@/store/ui";
import { Section } from "./settings/Section";
import { ScanProgressBar } from "./settings/ScanProgressBar";
import { ArrSettingsSection } from "./settings/ArrSettingsSection";
import { VpnSettingsSection } from "./settings/VpnSettingsSection";

interface AdminSettings {
  autoScan: boolean;
  watcherActive: boolean;
  onlineArtwork: boolean;
  tmdbKeySet: boolean;
  config: {
    mediaDir: string;
    mediaDirExists: boolean;
    dataDir: string;
    port: number;
    trickplay: boolean;
    ffmpegPath: string;
    maxTranscodeSessions: number;
    maxTranscodeHeight: number;
  };
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="truncate text-right text-white" title={value}>
        {value}
      </span>
    </div>
  );
}

export function SettingsView() {
  const isAdmin = useProfileStore((s) => s.isAdmin);
  const notify = useUiStore((s) => s.notify);
  const scan = useLibraryStore((s) => s.scan);
  const rescan = useLibraryStore((s) => s.rescan);
  const scanning = scan?.status === "scanning" || scan?.imaging;

  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [error, setError] = useState("");
  const [dirInput, setDirInput] = useState("");
  const [busyDir, setBusyDir] = useState(false);
  const [busyToggle, setBusyToggle] = useState(false);
  const [busyBackup, setBusyBackup] = useState(false);

  const loadSettings = useCallback(
    () =>
      api
        .get<AdminSettings>("/api/admin/settings")
        .then((data) => {
          setSettings(data);
          setError("");
        })
        .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Paramètres indisponibles")),
    [],
  );

  useEffect(() => {
    if (isAdmin) void loadSettings();
  }, [isAdmin, loadSettings]);

  const changeDir = async (e: FormEvent) => {
    e.preventDefault();
    const dir = dirInput.trim();
    if (!dir || busyDir) return;
    setBusyDir(true);
    setError("");
    // POST /api/library/source only answers once its scan finished; surface
    // the live progress through the existing SSE channel in the meantime.
    const timer = window.setTimeout(() => useLibraryStore.getState().watchScan(), 800);
    try {
      await api.post("/api/library/source", { dir });
      setDirInput("");
      notify("Dossier de la bibliothèque mis à jour");
      await Promise.all([loadSettings(), useLibraryStore.getState().load()]);
    } catch (err) {
      window.clearTimeout(timer);
      setError(err instanceof ApiError ? err.message : "Échec du changement de dossier");
    } finally {
      setBusyDir(false);
    }
  };

  const toggleAutoScan = async () => {
    if (!settings || busyToggle) return;
    setBusyToggle(true);
    setError("");
    try {
      setSettings(await api.post<AdminSettings>("/api/admin/settings", { autoScan: !settings.autoScan }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Échec de la modification");
    } finally {
      setBusyToggle(false);
    }
  };

  // Online artwork: toggle + write-only TMDB key (mirrors the arr section's
  // secret handling — the server only ever reports the key's presence).
  const [busyArtwork, setBusyArtwork] = useState(false);
  const [tmdbKeyInput, setTmdbKeyInput] = useState("");

  const toggleOnlineArtwork = async () => {
    if (!settings || busyArtwork) return;
    setBusyArtwork(true);
    setError("");
    try {
      setSettings(await api.post<AdminSettings>("/api/admin/settings", { onlineArtwork: !settings.onlineArtwork }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Échec de la modification");
    } finally {
      setBusyArtwork(false);
    }
  };

  const saveTmdbKey = async (e: FormEvent) => {
    e.preventDefault();
    if (busyArtwork) return;
    setBusyArtwork(true);
    setError("");
    try {
      setSettings(await api.post<AdminSettings>("/api/admin/settings", { tmdbKey: tmdbKeyInput.trim() }));
      setTmdbKeyInput("");
      notify(tmdbKeyInput.trim() ? "Clé TMDB enregistrée — récupération des illustrations lancée" : "Clé TMDB effacée");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Échec de l'enregistrement");
    } finally {
      setBusyArtwork(false);
    }
  };

  // Download the DB backup with the bearer sent as a header, never as ?token= in
  // the URL: a 30-day admin token in a URL leaks into browser history and the
  // reverse-proxy's access logs. We fetch it into a Blob and save it through a
  // transient object URL so the token never touches any URL.
  const downloadBackup = async () => {
    if (busyBackup) return;
    setBusyBackup(true);
    setError("");
    try {
      const res = await fetch("/api/admin/backup", { headers: api.headers(), credentials: "include", cache: "no-store" });
      if (!res.ok) throw new ApiError(res.status, res.status === 401 ? "Session expirée" : "Échec de la sauvegarde");
      const blob = await res.blob();
      // Honour the server's Content-Disposition filename; fall back to a dated
      // name (same shape the route emits) if the header is stripped en route.
      const disposition = res.headers.get("content-disposition") ?? "";
      const filename = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? `flix-backup-${new Date().toISOString().slice(0, 10)}.db`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer the revoke: some browsers cancel an in-flight download if the
      // object URL is revoked in the same tick as the click.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Échec du téléchargement de la sauvegarde");
    } finally {
      setBusyBackup(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen px-4 pb-20 pt-24 md:px-12">
        <div className="mx-auto max-w-3xl">
          <h1 className="mb-6 font-display text-3xl font-bold tracking-tight text-white">Paramètres</h1>
          <p className="text-sm text-muted">Cette page est réservée à l&apos;administrateur.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 pb-20 pt-24 md:px-12">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-6 text-xl font-semibold text-white">Paramètres</h1>
        {error && <p className="mb-4 text-sm text-accent">{error}</p>}

        <Section title="Bibliothèque" icon={FolderOpen}>
          <p className="text-sm text-muted">Dossier actuel</p>
          <p className="mt-0.5 break-all text-sm text-white">
            {settings?.config.mediaDir ?? "…"}
            {settings && !settings.config.mediaDirExists && <span className="ml-2 text-accent">(introuvable)</span>}
          </p>

          <form onSubmit={(e) => void changeDir(e)} className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              value={dirInput}
              onChange={(e) => setDirInput(e.target.value)}
              placeholder="/chemin/vers/le/dossier/vidéos"
              className="min-w-0 flex-1 rounded-field bg-white/5 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-muted focus:ring-accent/60"
            />
            <button
              type="submit"
              disabled={busyDir || !dirInput.trim()}
              className="flex shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
            >
              <FolderOpen className="size-4" />
              {busyDir ? "Changement…" : "Changer et analyser"}
            </button>
          </form>

          <div className="mt-4">
            <div aria-hidden className="divider-fade mb-4" />
            <button
              type="button"
              disabled={scanning || busyDir}
              onClick={() => void rescan()}
              className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15 disabled:opacity-40"
            >
              <RefreshCw className={"size-4" + (scanning ? " animate-spin" : "")} />
              {scanning ? "Analyse en cours…" : "Analyser la bibliothèque"}
            </button>
            <ScanProgressBar />
          </div>
        </Section>

        <Section title="Analyse automatique" icon={RefreshCw}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-white">Surveiller le dossier de la bibliothèque</p>
              <p className="mt-0.5 text-xs text-muted">
                Relance automatiquement une analyse environ 30 secondes après le dernier changement détecté dans le dossier.
                {settings && settings.autoScan && !settings.watcherActive && (
                  <span className="text-accent"> Surveillance indisponible sur ce dossier.</span>
                )}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings?.autoScan ?? false}
              disabled={!settings || busyToggle}
              onClick={() => void toggleAutoScan()}
              className={
                "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 " +
                (settings?.autoScan ? "bg-accent" : "bg-white/10")
              }
            >
              <span
                className={
                  "absolute top-0.5 size-5 rounded-full bg-white shadow-card transition-transform duration-200 ease-out-quart " +
                  (settings?.autoScan ? "translate-x-[22px]" : "translate-x-0.5")
                }
              />
            </button>
          </div>
        </Section>

        <Section title="Illustrations" icon={ImageIcon}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-white">Télécharger automatiquement les affiches manquantes</p>
              <p className="mt-0.5 text-xs text-muted">
                Quand un titre n&apos;a ni jaquette ni fond fournis, Flix récupère les vrais visuels en ligne (TVmaze pour les séries,
                Wikipédia pour les films) à la fin de chaque analyse. Désactivez pour un serveur strictement hors-ligne — la lecture et
                l&apos;historique restent locaux dans tous les cas.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings?.onlineArtwork ?? false}
              disabled={!settings || busyArtwork}
              onClick={() => void toggleOnlineArtwork()}
              className={
                "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 " +
                (settings?.onlineArtwork ? "bg-accent" : "bg-white/10")
              }
            >
              <span
                className={
                  "absolute top-0.5 size-5 rounded-full bg-white shadow-card transition-transform duration-200 ease-out-quart " +
                  (settings?.onlineArtwork ? "translate-x-[22px]" : "translate-x-0.5")
                }
              />
            </button>
          </div>
          <form onSubmit={saveTmdbKey} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={tmdbKeyInput}
              onChange={(e) => setTmdbKeyInput(e.target.value)}
              type="password"
              autoComplete="off"
              placeholder={settings?.tmdbKeySet ? "Clé TMDB enregistrée — coller une nouvelle clé pour la remplacer" : "Clé API TMDB (optionnelle)"}
              className="min-w-0 flex-1 rounded-field bg-white/5 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-accent/60"
            />
            <button
              type="submit"
              disabled={busyArtwork || (!tmdbKeyInput.trim() && !settings?.tmdbKeySet)}
              className="shrink-0 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15 disabled:opacity-40"
            >
              Enregistrer
            </button>
          </form>
          <p className="mt-2 text-xs text-muted">
            Avec une clé TMDB (gratuite), la couverture devient totale : affiches en français, fonds ET logos de titres — le rendu Netflix
            complet. Sans clé, seules les affiches sont récupérées.
          </p>
        </Section>

        <ArrSettingsSection />

        <VpnSettingsSection />

        <Section title="Sauvegarde" icon={Download}>
          <p className="text-sm text-muted">
            Télécharge une copie cohérente de la base de données (profils, historique, réglages, index de la bibliothèque).
          </p>
          <button
            type="button"
            disabled={busyBackup}
            onClick={() => void downloadBackup()}
            className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15 disabled:opacity-40"
          >
            <Download className="size-4" /> {busyBackup ? "Préparation…" : "Télécharger une sauvegarde"}
          </button>
        </Section>

        <Section title="Configuration du serveur" icon={Server}>
          {!settings ? (
            <p className="text-sm text-muted">Chargement…</p>
          ) : (
            <div>
              <ConfigRow label="Port" value={String(settings.config.port)} />
              <div aria-hidden className="divider-fade" />
              <ConfigRow label="Dossier de données" value={settings.config.dataDir} />
              <div aria-hidden className="divider-fade" />
              <ConfigRow label="Aperçus de navigation (trickplay)" value={settings.config.trickplay ? "Activés" : "Désactivés"} />
              <div aria-hidden className="divider-fade" />
              <ConfigRow label="Transcodages simultanés max" value={String(settings.config.maxTranscodeSessions)} />
              <div aria-hidden className="divider-fade" />
              <ConfigRow label="Résolution de transcodage max" value={`${settings.config.maxTranscodeHeight}p`} />
              <div aria-hidden className="divider-fade" />
              <ConfigRow label="Binaire ffmpeg" value={settings.config.ffmpegPath} />
            </div>
          )}
          <p className="mt-3 text-xs text-muted">
            Ces valeurs proviennent de l&apos;environnement du serveur et ne sont pas modifiables depuis l&apos;interface.
          </p>
        </Section>
      </div>
    </div>
  );
}
