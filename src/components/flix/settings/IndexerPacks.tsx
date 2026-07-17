"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Layers, Plus, Globe, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/flix/api";

// « Sources de téléchargement » — add whole packs of curated PUBLIC indexers to
// Prowlarr straight from Flix, so a search actually finds something. Mirrors the
// deploy-time FLIX_ARR_INDEXERS env var. Only rendered once the feature is on.
interface IndexerPresetView {
  key: string;
  label: string;
  description: string;
  count: number;
}
interface IndexerState {
  enabled: boolean;
  presets?: IndexerPresetView[];
  configured?: { count: number; names: string[] } | null;
}
interface AddIndexersResult {
  added: { name: string; viaFlare: boolean }[];
  skipped: string[];
  failed: { name: string; reason: string }[];
  remaining: number;
  total: number;
  configured?: { count: number; names: string[] } | null;
}

const normIdx = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Merge one wave's result into the running aggregate: added accumulates,
 *  skipped/failed dedupe (an indexer added in wave 1 comes back "skipped" in
 *  wave 2 — that's plumbing, not information, so it's dropped). */
function mergeAddResults(prev: AddIndexersResult, next: AddIndexersResult): AddIndexersResult {
  const added = [...prev.added, ...next.added];
  const addedKeys = new Set(added.map((a) => normIdx(a.name)));
  const skipped: string[] = [];
  const seenSkip = new Set<string>();
  for (const s of [...prev.skipped, ...next.skipped]) {
    const k = normIdx(s);
    if (addedKeys.has(k) || seenSkip.has(k)) continue;
    seenSkip.add(k);
    skipped.push(s);
  }
  const failed: { name: string; reason: string }[] = [];
  const seenFail = new Set<string>();
  for (const f of [...prev.failed, ...next.failed]) {
    const k = normIdx(f.name);
    if (seenFail.has(k)) continue;
    seenFail.add(k);
    failed.push(f);
  }
  return { added, skipped, failed, remaining: next.remaining, total: next.total, configured: next.configured };
}

export function IndexerPacks() {
  const [state, setState] = useState<IndexerState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<AddIndexersResult | null>(null);

  const load = useCallback(() => {
    api
      .get<IndexerState>("/api/admin/arr/indexers")
      .then(setState)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : "Indexeurs indisponibles"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addPack = async (selection: string) => {
    if (busy) return;
    setBusy(selection);
    setError("");
    setResult(null);
    try {
      // The server processes adds in bounded waves (Prowlarr tests each one
      // synchronously) and reports `remaining`; loop until drained, passing the
      // names that already failed so every wave attempts only new sources.
      // 60 waves × 20 attempts bounds it well above the full public catalogue.
      let merged: AddIndexersResult | null = null;
      for (let wave = 0; wave < 60; wave++) {
        const res = await api.post<AddIndexersResult>("/api/admin/arr/indexers", {
          selection,
          exclude: merged ? merged.failed.map((f) => f.name) : [],
        });
        const current: AddIndexersResult = merged ? mergeAddResults(merged, res) : res;
        merged = current;
        setResult(current);
        // Reflect the new count without a full reload round-trip.
        if (current.configured) setState((prev) => (prev ? { ...prev, configured: current.configured } : prev));
        if (!current.remaining) break;
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Échec de l'ajout");
    } finally {
      setBusy(null);
    }
  };

  const presets = (state?.presets ?? []).filter((p) => p.key !== "everything");
  const everything = state?.presets?.find((p) => p.key === "everything");
  const configured = state?.configured;

  return (
    <div className="rounded-panel bg-black/25 p-3 ring-1 ring-white/5">
      <div className="mb-1 flex items-center gap-2">
        <Layers className="size-4 text-muted" />
        <span className="text-sm font-medium text-white">Sources de téléchargement</span>
        {configured != null && (
          <span className="rounded-full bg-surface-hover px-1.5 py-0.5 text-[11px] text-muted">{configured.count} actif(s)</span>
        )}
      </div>
      <p className="mb-3 text-xs text-muted">
        Ajoutez des paquets d&apos;indexeurs <span className="text-white">publics</span> (sans compte) à Prowlarr en un clic — ils sont
        synchronisés vers Sonarr/Radarr automatiquement. Les sources protégées par Cloudflare passent par FlareSolverr.
      </p>

      {configured === null && (
        <p className="mb-3 text-xs text-accent">Prowlarr injoignable — vérifiez sa configuration ci-dessus avant d&apos;ajouter des sources.</p>
      )}

      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p.key}
            type="button"
            title={p.description}
            disabled={busy !== null || configured === null}
            onClick={() => void addPack(p.key)}
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/15 disabled:opacity-40"
          >
            {busy === p.key ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            {p.label}
            <span className="text-muted">· {p.count}</span>
          </button>
        ))}
        {presets.length > 0 && (
          <button
            type="button"
            title="Ajouter tous les paquets d'indexeurs publics"
            disabled={busy !== null || configured === null}
            onClick={() => void addPack("all")}
            className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {busy === "all" ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            Tout ajouter
          </button>
        )}
        {everything && (
          <button
            type="button"
            title={everything.description}
            disabled={busy !== null || configured === null}
            onClick={() => void addPack(everything.key)}
            className="flex items-center gap-1.5 rounded-full border border-accent bg-transparent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent/20 disabled:opacity-40"
          >
            {busy === everything.key ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />}
            {everything.label}
            <span className="text-muted">· {everything.count}</span>
          </button>
        )}
      </div>

      {result && (
        <div className="mt-3 space-y-1 text-xs">
          <p className="flex items-center gap-1 text-emerald-400">
            <Check className="size-3.5" />
            {result.added.length} ajouté(s)
            {result.skipped.length > 0 && <span className="text-muted"> · {result.skipped.length} déjà présent(s)</span>}
            {result.failed.length > 0 && <span className="text-accent"> · {result.failed.length} échec(s)</span>}
            {busy !== null && result.remaining > 0 && <span className="text-muted"> · vague suivante… {result.remaining} restant(s)</span>}
          </p>
          {result.failed.length > 0 && (
            <ul className="space-y-0.5 text-muted">
              {result.failed.map((f) => (
                <li key={f.name}>
                  <span className="text-white/80">{f.name}</span> — {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-accent">{error}</p>}
    </div>
  );
}
