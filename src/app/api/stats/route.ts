// « Mon activité » — per-profile viewing statistics. Any authenticated
// profile may read ITS OWN stats (the user is resolved from the session, never
// from a parameter), so this needs plain auth, not requireAdmin.

import { getRequestUser } from "@/server/auth";
import { getUserStats } from "@/server/state/stats";
import { json } from "@/server/http";
import { createLogger } from "@/server/logger";

const log = createLogger("api:stats");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  try {
    const res = json(getUserStats(user.id));
    // Personal data: never cache across profiles/proxies, but let the browser
    // revalidate — same policy as /api/library.
    res.headers.set("Cache-Control", "private, no-cache");
    return res;
  } catch (error) {
    log.error("stats read failed", { error: error instanceof Error ? error.message : String(error) });
    return json({ error: "Statistiques indisponibles" }, { status: 500 });
  }
}
