// Feature-status probe for the client. Every authenticated profile learns
// whether the integration is enabled (so the Header entry / discover section can
// show or hide themselves); admins additionally get the banner-dismissal flag
// and the per-service config summary used to drive the one-time Home nudge.

import { isArrEnabled, isArrDismissed, listServiceConfigs } from "@/server/arr/config";
import { checkAuth, json, noStore } from "@/server/http";
import { getRequestUser } from "@/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = checkAuth(request);
  if (denied) return denied;

  const enabled = isArrEnabled();
  const user = getRequestUser(request);
  if (user?.is_admin === 1) {
    return noStore(json({ enabled, dismissed: isArrDismissed(), services: listServiceConfigs() }));
  }
  return noStore(json({ enabled }));
}
