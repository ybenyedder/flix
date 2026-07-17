// POST { fileId, caps, audioIdx?, subtitleId?, deviceId? } -> creates (or
// replaces this device's existing) playback session. Re-runs decide() itself
// server-side — a request can never force remux/transcode when direct play
// would do, since the mode is never taken from the client, only fileId/caps.

import { getRequestUser } from "@/server/auth";
import { checkCsrf, readJsonBody, json } from "@/server/http";
import { isFileAllowedForUser } from "@/server/playback/access";
import { createSession } from "@/server/playback/sessions";
import { parseClientCaps } from "@/lib/flix/caps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SessionBody {
  fileId?: unknown;
  caps?: unknown;
  audioIdx?: unknown;
  subtitleId?: unknown;
  deviceId?: unknown;
}

const MAX_DEVICE_ID_LEN = 128;

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readJsonBody<SessionBody>(request);
  if (!parsed.ok) return parsed.response;

  const fileId = Number(parsed.body.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) return json({ error: "fileId invalide" }, { status: 400 });

  // Kids gate — same 404 (never 403) as items/search, so an enumerable file
  // id never confirms an adult title exists.
  if (!isFileAllowedForUser(user, fileId)) return json({ error: "Fichier introuvable" }, { status: 404 });

  const caps = parseClientCaps(parsed.body.caps);
  if (!caps) return json({ error: "caps invalides" }, { status: 400 });

  const audioIdx = typeof parsed.body.audioIdx === "number" ? parsed.body.audioIdx : undefined;
  const subtitleId = typeof parsed.body.subtitleId === "number" ? parsed.body.subtitleId : undefined;
  const deviceId = typeof parsed.body.deviceId === "string" && parsed.body.deviceId.trim() ? parsed.body.deviceId.trim().slice(0, MAX_DEVICE_ID_LEN) : "default";

  const result = await createSession({ fileId, userId: user.id, deviceId, caps, audioIdx, subtitleId });
  if (!result.ok) return json({ error: result.error }, { status: result.status });
  if (result.mode === "direct") return json({ mode: "direct", url: result.url });
  return json({ mode: result.mode, sessionId: result.id, playlistUrl: result.playlistUrl });
}
