// GET/POST /api/settings — per-profile playback preferences (langue audio et
// sous-titres préférés). GET returns the current profile's prefs; POST updates
// whichever of the two keys the body carries (null clears one, an absent key
// is left untouched) and echoes the updated snapshot. Same auth + CSRF guards
// as every other mutating route; responses are `private, no-cache` — per-user
// data must never land in a shared cache, though the browser may revalidate.

import { getRequestUser } from "@/server/auth";
import { checkCsrf, readJsonBody, json } from "@/server/http";
import { getPlaybackPrefs, setPlaybackPrefs } from "@/server/state/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Two tiny string fields — 4 KiB is already generous.
const MAX_SETTINGS_BODY_BYTES = 4 * 1024;

function prefsResponse(userId: number) {
  const res = json(getPlaybackPrefs(userId));
  res.headers.set("Cache-Control", "private, no-cache");
  return res;
}

export async function GET(request: Request) {
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  return prefsResponse(user.id);
}

interface SettingsBody {
  audioLang?: unknown;
  subtitleLang?: unknown;
}

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readJsonBody<SettingsBody>(request, MAX_SETTINGS_BODY_BYTES);
  if (!parsed.ok) return parsed.response;

  const result = setPlaybackPrefs(user.id, parsed.body);
  if (!result.ok) return json({ error: result.error }, { status: 400 });
  return prefsResponse(user.id);
}
