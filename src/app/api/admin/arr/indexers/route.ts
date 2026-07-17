// Admin management of Prowlarr's search sources for the opt-in *arr integration.
//
//   GET  → the packs Flix can add + a live snapshot of what's already in Prowlarr
//   POST → add a pack/selection of public indexers to Prowlarr (best-effort)
//
// Both are admin-gated; POST is CSRF-checked. Everything is a no-op unless the
// "Téléchargements automatiques" feature is enabled and Prowlarr is configured.

import { isArrEnabled } from "@/server/arr/config";
import { addIndexers, listIndexerState } from "@/server/arr/indexers";
import { ArrError } from "@/server/arr/client";
import { requireAdmin, checkCsrf, readJsonBody, json, noStore } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (!isArrEnabled()) return noStore(json({ enabled: false }));
  const state = await listIndexerState();
  return noStore(json({ enabled: true, ...state }));
}

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (!isArrEnabled()) return json({ error: "Téléchargements automatiques désactivés" }, { status: 400 });

  const parsed = await readJsonBody<{ selection?: unknown; exclude?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const selection = parsed.body.selection;
  if (typeof selection !== "string" || selection.trim() === "") {
    return json({ error: "Sélection d'indexeurs manquante" }, { status: 400 });
  }
  // Bound the selection so a huge literal list can't fan out into hundreds of
  // outbound POSTs to Prowlarr. ("everything" is a single token: the fan-out is
  // batch-capped inside addIndexers, which reports `remaining` instead.)
  if (selection.split(",").length > 100) {
    return json({ error: "Sélection trop volumineuse" }, { status: 400 });
  }
  // Names that already failed this session — the chunked "everything" loop
  // passes them back so each POST attempts only new definitions.
  const exclude = Array.isArray(parsed.body.exclude)
    ? parsed.body.exclude.filter((x): x is string => typeof x === "string").slice(0, 2000)
    : [];

  try {
    const result = await addIndexers(selection, { exclude });
    const state = await listIndexerState();
    return noStore(json({ ...result, configured: state.configured }));
  } catch (error) {
    // addIndexers only throws if Prowlarr itself is unreachable/unconfigured.
    const message = error instanceof ArrError ? error.message : "Prowlarr injoignable";
    return noStore(json({ error: message }, { status: 502 }));
  }
}
