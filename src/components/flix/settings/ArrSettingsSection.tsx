"use client";

import { useCallback, useEffect, useState } from "react";
import { DownloadCloud, Check, AlertTriangle } from "lucide-react";
import { api, ApiError } from "@/lib/flix/api";
import { Section } from "./Section";
import { IndexerPacks } from "./IndexerPacks";

type ArrServiceId = "sonarr" | "radarr" | "prowlarr" | "bazarr";

interface ArrServiceView {
  service: ArrServiceId;
  configured: boolean;
  source: "manual" | "auto" | null;
  url: string | null;
}
interface ArrConfig {
  enabled: boolean;
  dismissed: boolean;
  services: ArrServiceView[];
}
interface TestState {
  status: "ok" | "error";
  message: string;
}

const ARR_SERVICE_LABELS: Record<ArrServiceId, string> = {
  radarr: "Radarr — films",
  sonarr: "Sonarr — séries",
  prowlarr: "Prowlarr — indexeurs",
  bazarr: "Bazarr — sous-titres",
};

// « Téléchargements automatiques » — the opt-in *arr integration. Off by default;
// enabling it is a deliberate departure from Flix's zero-outbound-network posture
// (calls go only to the operator's own local Sonarr/Radarr/Prowlarr/Bazarr).
export function ArrSettingsSection() {
  const [config, setConfig] = useState<ArrConfig | null>(null);
  const [error, setError] = useState("");
  const [busyToggle, setBusyToggle] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, { url: string; apiKey: string }>>({});
  const [savingService, setSavingService] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const applyConfig = useCallback((data: ArrConfig) => {
    setConfig(data);
    setDrafts((prev) => {
      const next = { ...prev };
      for (const s of data.services) {
        if (next[s.service] === undefined) next[s.service] = { url: s.url ?? "", apiKey: "" };
      }
      return next;
    });
  }, []);

  const load = useCallback(() => {
    api
      .get<ArrConfig>("/api/admin/arr")
      .then(applyConfig)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : "Configuration indisponible"));
  }, [applyConfig]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async () => {
    if (!config || busyToggle) return;
    setBusyToggle(true);
    setError("");
    try {
      applyConfig(await api.post<ArrConfig>("/api/admin/arr", { enabled: !config.enabled }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Échec de la modification");
    } finally {
      setBusyToggle(false);
    }
  };

  const saveService = async (service: ArrServiceId) => {
    const draft = drafts[service];
    if (!draft || savingService) return;
    setSavingService(service);
    setError("");
    // Only send the API key when the admin actually typed one, so editing the URL
    // alone never wipes a stored (never-echoed) key.
    const payload: { url?: string; apiKey?: string } = { url: draft.url };
    if (draft.apiKey.trim() !== "") payload.apiKey = draft.apiKey;
    try {
      const next = await api.post<ArrConfig>("/api/admin/arr", { services: { [service]: payload } });
      applyConfig(next);
      setDrafts((prev) => ({ ...prev, [service]: { url: next.services.find((s) => s.service === service)?.url ?? draft.url, apiKey: "" } }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Échec de l'enregistrement");
    } finally {
      setSavingService(null);
    }
  };

  const runTest = async (service: ArrServiceId) => {
    if (testing) return;
    setTesting(service);
    setTests((prev) => {
      const n = { ...prev };
      delete n[service];
      return n;
    });
    try {
      const res = await api.post<{ ok: boolean; version?: string; indexerCount?: number | null; error?: string }>("/api/admin/arr/test", { service });
      if (res.ok) {
        const noIndexers = service === "prowlarr" && (res.indexerCount ?? 0) === 0;
        let message = `Connecté (v${res.version})`;
        if (service === "prowlarr" && res.indexerCount != null) {
          message = noIndexers ? `Connecté (v${res.version}) — aucun indexeur : ajoutez-en dans Prowlarr` : `Connecté (v${res.version}) — ${res.indexerCount} indexeur(s)`;
        }
        setTests((prev) => ({ ...prev, [service]: { status: noIndexers ? "error" : "ok", message } }));
      } else {
        setTests((prev) => ({ ...prev, [service]: { status: "error", message: res.error ?? "Échec" } }));
      }
    } catch (e) {
      setTests((prev) => ({ ...prev, [service]: { status: "error", message: e instanceof ApiError ? e.message : "Échec" } }));
    } finally {
      setTesting(null);
    }
  };

  const enabled = config?.enabled ?? false;

  return (
    <Section title="Téléchargements automatiques" icon={DownloadCloud}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-white">Demander films et séries depuis Flix</p>
          <p className="mt-0.5 text-xs text-muted">
            Connecte Flix à vos services Sonarr, Radarr, Prowlarr et Bazarr pour rechercher, télécharger et sous-titrer un titre absent de la
            bibliothèque, puis l&apos;ajouter automatiquement. Désactivé par défaut : c&apos;est la seule fonction de Flix qui contacte le réseau
            (uniquement vos propres services locaux).
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={!config || busyToggle}
          onClick={() => void toggle()}
          className={"relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 " + (enabled ? "bg-accent" : "bg-white/10")}
        >
          <span className={"absolute top-0.5 size-5 rounded-full bg-white shadow-card transition-transform duration-200 ease-out-quart " + (enabled ? "translate-x-[22px]" : "translate-x-0.5")} />
        </button>
      </div>

      {enabled && config && (
        <div className="mt-4 space-y-4">
          <div aria-hidden className="divider-fade" />
          {config.services.map((svc) => {
            const draft = drafts[svc.service] ?? { url: "", apiKey: "" };
            const test = tests[svc.service];
            return (
              <div key={svc.service} className="rounded-panel bg-black/25 p-3 ring-1 ring-white/5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-white">{ARR_SERVICE_LABELS[svc.service]}</span>
                  {svc.source === "auto" && <span className="rounded-full bg-surface-hover px-1.5 py-0.5 text-[11px] text-muted">auto-détecté</span>}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    value={draft.url}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [svc.service]: { ...draft, url: e.target.value } }))}
                    placeholder="http://hôte:port"
                    className="min-w-0 flex-1 rounded-field bg-white/5 px-3 py-1.5 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-muted focus:ring-accent/60"
                  />
                  <input
                    value={draft.apiKey}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [svc.service]: { ...draft, apiKey: e.target.value } }))}
                    type="password"
                    placeholder={svc.configured ? "Clé API (inchangée)" : "Clé API"}
                    className="min-w-0 flex-1 rounded-field bg-white/5 px-3 py-1.5 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-muted focus:ring-accent/60"
                  />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={savingService === svc.service}
                    onClick={() => void saveService(svc.service)}
                    className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
                  >
                    {savingService === svc.service ? "Enregistrement…" : "Enregistrer"}
                  </button>
                  <button
                    type="button"
                    disabled={!svc.configured || testing === svc.service}
                    onClick={() => void runTest(svc.service)}
                    className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/15 disabled:opacity-40"
                  >
                    {testing === svc.service ? "Test…" : "Tester"}
                  </button>
                  {test && (
                    <span className={"flex items-center gap-1 text-xs " + (test.status === "ok" ? "text-emerald-400" : "text-accent")}>
                      {test.status === "ok" ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
                      {test.message}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          <IndexerPacks />
          <p className="text-xs text-muted">
            Astuce : la pile complète (Sonarr, Radarr, Prowlarr, Bazarr, qBittorrent) peut être déployée avec Flix via{" "}
            <code className="rounded-field bg-background px-1 py-0.5">docker compose -f docker-compose.yml -f docker-compose.arr.yml up -d</code>. Voir{" "}
            <code className="rounded-field bg-background px-1 py-0.5">docs/downloads-arr.md</code>. Pensez à ajouter au moins un indexeur dans Prowlarr.
          </p>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-accent">{error}</p>}
    </Section>
  );
}
