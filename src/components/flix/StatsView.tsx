"use client";

// « Mon activité » — per-profile viewing statistics (GET /api/stats): key
// figures, top genres as plain CSS bars (no chart library), recent history.
// Available to every profile; the server scopes everything to the session user.

import { Fragment, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/flix/api";
import { formatDuration } from "@/lib/flix/format";

interface GenreStat {
  genre: string;
  seconds: number;
}

interface HistoryEntry {
  itemType: "movie" | "episode";
  topType: "movie" | "show";
  topId: number;
  title: string;
  subtitle: string | null;
  kind: "complete" | "abandon";
  seconds: number;
  createdAt: number;
}

interface UserStats {
  seconds7d: number;
  seconds30d: number;
  secondsTotal: number;
  completedTitles: number;
  topGenres: GenreStat[];
  history: HistoryEntry[];
}

function formatWatchTime(seconds: number): string {
  if (seconds <= 0) return "0 min";
  return formatDuration(seconds);
}

function formatEventDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card-surface p-5">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-display text-3xl font-semibold tabular-nums text-white">{value}</p>
    </div>
  );
}

export function StatsView() {
  const [stats, setStats] = useState<UserStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get<UserStats>("/api/stats")
      .then(setStats)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Statistiques indisponibles"));
  }, []);

  const maxGenreSeconds = stats?.topGenres[0]?.seconds ?? 0;

  return (
    <div className="min-h-screen px-4 pb-20 pt-24 md:px-12">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-6 font-display text-2xl font-semibold text-white">Mon activité</h1>

        {error && <p className="text-sm text-accent">{error}</p>}
        {!stats && !error && <p className="text-sm text-muted">Chargement…</p>}

        {stats && (
          <>
            <div className="stagger-children grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="7 derniers jours" value={formatWatchTime(stats.seconds7d)} />
              <StatCard label="30 derniers jours" value={formatWatchTime(stats.seconds30d)} />
              <StatCard label="Temps total" value={formatWatchTime(stats.secondsTotal)} />
              <StatCard label="Titres terminés" value={String(stats.completedTitles)} />
            </div>

            <section className="mt-10">
              <h2 className="mb-3 font-display text-base font-semibold text-white">Genres les plus regardés</h2>
              {stats.topGenres.length === 0 ? (
                <p className="text-sm text-muted">Pas encore assez de visionnages pour dégager des genres.</p>
              ) : (
                <ul className="space-y-2">
                  {stats.topGenres.map((g) => (
                    <li key={g.genre}>
                      <div className="mb-1 flex items-baseline justify-between text-sm">
                        <span className="text-white">{g.genre}</span>
                        <span className="text-xs text-muted">{formatWatchTime(g.seconds)}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-white/5">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-accent to-accent-hover"
                          style={{ width: `${maxGenreSeconds > 0 ? Math.max(2, Math.round((g.seconds / maxGenreSeconds) * 100)) : 0}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mt-10">
              <h2 className="mb-3 font-display text-base font-semibold text-white">Historique récent</h2>
              {stats.history.length === 0 ? (
                <p className="text-sm text-muted">Aucun visionnage enregistré pour l&apos;instant.</p>
              ) : (
                <ul>
                  {stats.history.map((entry, index) => (
                    <Fragment key={`${entry.createdAt}-${index}`}>
                      {index > 0 && <li aria-hidden className="divider-fade my-1" />}
                    <li className="flex items-center justify-between gap-4 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-white">
                          {entry.title}
                          {entry.subtitle && <span className="text-muted"> · {entry.subtitle}</span>}
                        </p>
                        <p className="text-xs text-muted">{formatEventDate(entry.createdAt)}</p>
                      </div>
                      <span className={"shrink-0 text-xs " + (entry.kind === "complete" ? "text-white" : "text-muted")}>
                        {entry.kind === "complete" ? "Terminé" : "Abandonné"}
                      </span>
                    </li>
                    </Fragment>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
