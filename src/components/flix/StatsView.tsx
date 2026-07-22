"use client";

// « Mon activité » — per-profile viewing statistics (GET /api/stats): key
// figures, top genres as plain CSS bars (no chart library), recent history.
// Available to every profile; the server scopes everything to the session user.

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { CalendarDays, CalendarRange, Clock, CircleCheck, Check } from "lucide-react";
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

function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="card-surface p-5">
      <div className="flex items-center gap-1.5 text-muted">
        <span className="text-white/45">{icon}</span>
        <p className="text-xs">{label}</p>
      </div>
      <p className="mt-1.5 font-display text-3xl font-semibold tabular-nums text-white">{value}</p>
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
        <h1 className="mb-6 font-display text-3xl font-bold tracking-tight text-white">Mon activité</h1>

        {error && <p className="text-sm text-accent">{error}</p>}
        {!stats && !error && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card-surface p-5">
                <div className="h-3 w-2/3 rounded-card shimmer" />
                <div className="mt-2.5 h-7 w-1/2 rounded-card shimmer" />
              </div>
            ))}
          </div>
        )}

        {stats && (
          <>
            <div className="stagger-children grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard icon={<CalendarDays className="size-3.5" />} label="7 derniers jours" value={formatWatchTime(stats.seconds7d)} />
              <StatCard icon={<CalendarRange className="size-3.5" />} label="30 derniers jours" value={formatWatchTime(stats.seconds30d)} />
              <StatCard icon={<Clock className="size-3.5" />} label="Temps total" value={formatWatchTime(stats.secondsTotal)} />
              <StatCard icon={<CircleCheck className="size-3.5" />} label="Titres terminés" value={String(stats.completedTitles)} />
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
                      <span className={"flex shrink-0 items-center gap-1.5 text-xs " + (entry.kind === "complete" ? "text-white" : "text-muted")}>
                        {entry.kind === "complete" && <Check className="size-3.5 text-match" />}
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
