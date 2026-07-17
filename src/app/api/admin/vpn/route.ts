// Admin VPN (Mullvad) config: enter an account number and Flix generates the
// WireGuard key, registers it, picks the nearest relay, and writes the gluetun
// config. Secret-bearing → admin-gated + CSRF-guarded, its own route.

import { getVpnSettings, getVpnStatus, configureVpn, changeVpnCountry, disableVpn, listVpnCountries } from "@/server/vpn/config";
import { requireAdmin, checkCsrf, readJsonBody, json, noStore } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  // Lazy: the country list needs an outbound Mullvad call, so only fetch it when
  // the UI explicitly asks (opening the country picker), not on every settings load.
  if (new URL(request.url).searchParams.get("countries") === "1") {
    return noStore(json({ countries: await listVpnCountries() }));
  }
  const [settings, status] = [getVpnSettings(), await getVpnStatus()];
  return noStore(json({ settings, status }));
}

interface VpnBody {
  account?: unknown;
  action?: unknown;
  country?: unknown;
}

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = requireAdmin(request);
  if (denied) return denied;

  const parsed = await readJsonBody<VpnBody>(request);
  if (!parsed.ok) return parsed.response;
  const { account, action, country } = parsed.body;

  if (action === "disable") {
    return noStore(json({ settings: disableVpn(), status: await getVpnStatus() }));
  }

  // Change only the exit country (no account needed — reuses the stored key).
  if (action === "setCountry") {
    if (country !== null && country !== undefined && typeof country !== "string") {
      return json({ error: "Pays invalide" }, { status: 400 });
    }
    const result = await changeVpnCountry(typeof country === "string" ? country : null);
    if (!result.ok) return json({ error: result.error }, { status: result.status ?? 400 });
    return noStore(json({ settings: result.settings, status: await getVpnStatus(), warning: result.warning }));
  }

  if (typeof account !== "string" || account.trim() === "") {
    return json({ error: "Numéro de compte requis" }, { status: 400 });
  }
  if (country !== undefined && country !== null && typeof country !== "string") {
    return json({ error: "Pays invalide" }, { status: 400 });
  }

  const result = await configureVpn(account, typeof country === "string" ? country : undefined);
  if (!result.ok) return json({ error: result.error }, { status: result.status ?? 400 });
  return noStore(json({ settings: result.settings, status: await getVpnStatus(), warning: result.warning }));
}
