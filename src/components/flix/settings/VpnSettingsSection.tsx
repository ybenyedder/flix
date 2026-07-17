"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ShieldCheck, ShieldOff, Loader2, Globe } from "lucide-react";
import { api, ApiError } from "@/lib/flix/api";
import { Section } from "./Section";

interface VpnServerView {
  hostname: string;
  city: string;
  country: string;
}
interface VpnSettingsDto {
  enabled: boolean;
  accountMask: string | null;
  server: VpnServerView | null;
  country: string | null;
  configuredAt: number | null;
  lanSubnet: string;
}
interface VpnStatusDto {
  connected: boolean;
  publicIp: string | null;
  country: string | null;
  error: string | null;
}
interface VpnCountry {
  code: string;
  name: string;
}
interface VpnResponse {
  settings: VpnSettingsDto;
  status: VpnStatusDto;
  warning?: string;
}

// « VPN (Mullvad) » — enter an account number and Flix generates the WireGuard
// key, registers it with Mullvad, picks the nearest relay, and writes the gluetun
// config (kill-switch included). Only qBittorrent's traffic is tunneled.
export function VpnSettingsSection() {
  const [data, setData] = useState<VpnResponse | null>(null);
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [accountFieldOpen, setAccountFieldOpen] = useState(false);
  const [countryOpen, setCountryOpen] = useState(false);
  const [countries, setCountries] = useState<VpnCountry[]>([]);
  const [loadingCountries, setLoadingCountries] = useState(false);
  const [selCountry, setSelCountry] = useState("");

  const load = useCallback(() => {
    api
      .get<VpnResponse>("/api/admin/vpn")
      .then(setData)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : "Configuration VPN indisponible"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCountryPicker = async () => {
    setCountryOpen((v) => !v);
    setSelCountry(data?.settings.country ?? "");
    if (!countryOpen && countries.length === 0) {
      setLoadingCountries(true);
      try {
        const res = await api.get<{ countries: VpnCountry[] }>("/api/admin/vpn?countries=1");
        setCountries(res.countries ?? []);
      } catch {
        /* leave empty — the input still accepts a free-form country */
      } finally {
        setLoadingCountries(false);
      }
    }
  };

  const applyCountry = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const res = await api.post<VpnResponse>("/api/admin/vpn", { action: "setCountry", country: selCountry || null });
      setData(res);
      // gluetun only reads its WireGuard endpoint at container start → remind to restart it.
      const restart = "Redémarrez gluetun pour appliquer : docker compose -f docker-compose.yml -f docker-compose.arr.yml -f docker-compose.vpn.yml up -d gluetun";
      setNote([res.warning, restart].filter(Boolean).join(" · "));
      setCountryOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Échec du changement de pays");
    } finally {
      setBusy(false);
    }
  };

  const configure = async () => {
    if (busy || account.trim() === "") return;
    setBusy(true);
    setError("");
    try {
      setData(await api.post<VpnResponse>("/api/admin/vpn", { account: account.trim() }));
      setAccount("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Échec de la configuration");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setData(await api.post<VpnResponse>("/api/admin/vpn", { action: "disable" }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Échec de la désactivation");
    } finally {
      setBusy(false);
    }
  };

  const settings = data?.settings;
  const status = data?.status;
  const server = settings?.server ?? null;
  const configured = !!(settings?.enabled && server);

  return (
    <Section title="VPN (Mullvad)" icon={ShieldCheck}>
      <p className="text-sm text-muted">
        Fait passer <span className="text-white">uniquement le trafic de qBittorrent</span> par Mullvad, avec kill-switch (si le VPN tombe, les
        téléchargements s&apos;arrêtent — aucune fuite de votre IP). Collez votre numéro de compte Mullvad : Flix génère la clé WireGuard, choisit le
        serveur le plus proche et configure tout.
      </p>

      {!configured ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            inputMode="numeric"
            placeholder="Numéro de compte Mullvad (16 chiffres)"
            className="min-w-0 flex-1 rounded-field bg-white/5 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-muted focus:ring-accent/60"
          />
          <button
            type="button"
            disabled={busy || account.trim() === ""}
            onClick={() => void configure()}
            className="flex shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            {busy ? "Configuration…" : "Activer le VPN"}
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-panel bg-black/25 p-3 ring-1 ring-white/5">
            <div className="flex items-center gap-2">
              {status?.connected ? <ShieldCheck className="size-5 text-emerald-400" /> : <AlertTriangle className="size-5 text-amber-400" />}
              <div>
                <p className="text-sm font-medium text-white">
                  {status?.connected ? "VPN actif" : "VPN configuré — en attente d'application"}
                </p>
                <p className="text-xs text-muted">
                  Serveur : {server?.city}, {server?.country} ({server?.hostname})
                  {status?.connected && status.publicIp ? ` · IP de sortie ${status.publicIp}` : ""}
                </p>
              </div>
            </div>
          </div>

          {status?.error && (
            <p className="rounded-panel bg-black/25 p-3 ring-1 ring-white/5 text-xs text-amber-400">
              {status.error} — appliquez avec :{" "}
              <code className="rounded-field bg-background px-1 py-0.5 text-muted">
                docker compose -f docker-compose.yml -f docker-compose.arr.yml -f docker-compose.vpn.yml up -d
              </code>
            </p>
          )}

          <p className="text-xs text-muted">
            Compte : {settings?.accountMask}
            {settings?.country ? ` · Pays choisi : ${settings.country}` : " · Pays : le plus proche"}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void openCountryPicker()}
              className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/15 disabled:opacity-40"
            >
              <Globe className="size-3.5" /> Changer de pays
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setAccountFieldOpen((v) => !v)}
              className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/15 disabled:opacity-40"
            >
              Changer de compte / serveur
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void disable()}
              className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-muted ring-1 ring-white/10 hover:text-accent hover:ring-accent/40 disabled:opacity-40"
            >
              <ShieldOff className="size-3.5" /> Désactiver
            </button>
          </div>

          {countryOpen && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                value={selCountry}
                onChange={(e) => setSelCountry(e.target.value)}
                disabled={busy || loadingCountries}
                className="min-w-0 flex-1 rounded-field bg-white/5 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-accent/60 disabled:opacity-40"
              >
                <option value="">{loadingCountries ? "Chargement des pays…" : "Le plus proche (auto)"}</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy}
                onClick={() => void applyCountry()}
                className="shrink-0 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
              >
                {busy ? "…" : "Appliquer le pays"}
              </button>
            </div>
          )}

          {accountFieldOpen && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                inputMode="numeric"
                placeholder="Nouveau numéro de compte (ou le même pour re-choisir le serveur)"
                className="min-w-0 flex-1 rounded-field bg-white/5 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/10 placeholder:text-muted focus:ring-accent/60"
              />
              <button
                type="button"
                disabled={busy || account.trim() === ""}
                onClick={() => void configure()}
                className="shrink-0 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
              >
                {busy ? "…" : "Reconfigurer"}
              </button>
            </div>
          )}
        </div>
      )}

      {note && <p className="mt-3 rounded-panel bg-black/25 p-3 ring-1 ring-white/5 text-xs text-amber-400">{note}</p>}
      {error && <p className="mt-3 text-sm text-accent">{error}</p>}
    </Section>
  );
}
