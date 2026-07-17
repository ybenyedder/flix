// Admin config for the opt-in *arr integration: the master toggle, the one-time
// banner dismissal, and per-service URL/API-key overrides. Secret-bearing, so it
// lives on its own gate (mirrors /api/admin/settings) instead of growing that
// route. API keys are write-only from the client's perspective — GET never
// echoes them back.

import {
  ARR_SERVICES,
  isArrEnabled,
  isArrDismissed,
  setArrEnabled,
  setArrDismissed,
  setServiceConfig,
  listServiceConfigs,
  type ArrService,
} from "@/server/arr/config";
import { requireAdmin, checkCsrf, readJsonBody, json, noStore } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function arrConfigPayload() {
  return {
    enabled: isArrEnabled(),
    dismissed: isArrDismissed(),
    services: listServiceConfigs(),
  };
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return noStore(json(arrConfigPayload()));
}

interface ArrConfigBody {
  enabled?: unknown;
  dismissed?: unknown;
  services?: Partial<Record<ArrService, { url?: unknown; apiKey?: unknown }>>;
}

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = requireAdmin(request);
  if (denied) return denied;

  const parsed = await readJsonBody<ArrConfigBody>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (body.services !== undefined) {
    if (typeof body.services !== "object" || body.services === null) return json({ error: "services invalide" }, { status: 400 });
    for (const service of ARR_SERVICES) {
      const entry = body.services[service];
      if (entry === undefined) continue;
      if (typeof entry !== "object" || entry === null) return json({ error: `${service} invalide` }, { status: 400 });
      const updates: { url?: string; apiKey?: string } = {};
      if (entry.url !== undefined) {
        if (typeof entry.url !== "string") return json({ error: `URL invalide pour ${service}` }, { status: 400 });
        updates.url = entry.url;
      }
      if (entry.apiKey !== undefined) {
        if (typeof entry.apiKey !== "string") return json({ error: `Clé API invalide pour ${service}` }, { status: 400 });
        updates.apiKey = entry.apiKey;
      }
      const result = setServiceConfig(service, updates);
      if (!result.ok) return json({ error: result.error }, { status: 400 });
    }
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return json({ error: "enabled invalide" }, { status: 400 });
    setArrEnabled(body.enabled);
  }
  if (body.dismissed !== undefined) {
    if (typeof body.dismissed !== "boolean") return json({ error: "dismissed invalide" }, { status: 400 });
    setArrDismissed(body.dismissed);
  }

  return noStore(json(arrConfigPayload()));
}
