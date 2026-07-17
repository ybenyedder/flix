// Admin "Tester la connexion" for one *arr service: a live probe of its
// system/status endpoint. Prowlarr additionally reports its indexer count so
// the UI can warn when zero indexers are configured (the one manual setup step).

import { ARR_SERVICES, type ArrService } from "@/server/arr/config";
import { testService, prowlarrIndexerCount, ArrError } from "@/server/arr/client";
import { requireAdmin, checkCsrf, readJsonBody, json, noStore } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = requireAdmin(request);
  if (denied) return denied;

  const parsed = await readJsonBody<{ service?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const service = parsed.body.service;
  if (typeof service !== "string" || !ARR_SERVICES.includes(service as ArrService)) {
    return json({ error: "Service inconnu" }, { status: 400 });
  }

  try {
    const { version } = await testService(service as ArrService);
    if (service === "prowlarr") {
      let indexerCount: number | null = null;
      try {
        indexerCount = await prowlarrIndexerCount();
      } catch {
        /* status ok but indexer list failed — report version anyway */
      }
      return noStore(json({ ok: true, version, indexerCount }));
    }
    return noStore(json({ ok: true, version }));
  } catch (error) {
    const message = error instanceof ArrError ? error.message : "Connexion impossible";
    return noStore(json({ ok: false, error: message }));
  }
}
