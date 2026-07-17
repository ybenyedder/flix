// POST { fileId, caps, audioIdx?, subtitleId? } -> the playback decision
// (direct/remux/transcode) for that file against the caller's declared
// capabilities. Read-only (no session, no ffmpeg) — the actual HLS session is
// only created by POST /api/play/session, which recomputes this same decision
// server-side rather than trusting whatever the client asked for.

import { getRequestUser } from "@/server/auth";
import { checkCsrf, readJsonBody, json } from "@/server/http";
import { isFileAllowedForUser } from "@/server/playback/access";
import { decide } from "@/server/playback/decision";
import { getPlaybackPrefs } from "@/server/state/settings";
import { parseClientCaps } from "@/lib/flix/caps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DecisionBody {
  fileId?: unknown;
  caps?: unknown;
  audioIdx?: unknown;
  subtitleId?: unknown;
}

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readJsonBody<DecisionBody>(request);
  if (!parsed.ok) return parsed.response;

  const fileId = Number(parsed.body.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) return json({ error: "fileId invalide" }, { status: 400 });

  // Kids gate — same 404 (never 403) as items/search, and byte-identical to
  // the "unknown fileId" response below, so an enumerable file id never
  // confirms an adult title exists.
  if (!isFileAllowedForUser(user, fileId)) return json({ error: "Fichier introuvable" }, { status: 404 });

  const caps = parseClientCaps(parsed.body.caps);
  if (!caps) return json({ error: "caps invalides" }, { status: 400 });

  const audioIdx = typeof parsed.body.audioIdx === "number" ? parsed.body.audioIdx : undefined;
  const subtitleId = typeof parsed.body.subtitleId === "number" ? parsed.body.subtitleId : undefined;

  // The profile's language preferences ride along so decide() can preselect
  // tracks — decide() only consults them for whichever explicit selection is
  // absent above, and never lets a preference degrade the playback mode.
  const decision = decide(fileId, caps, { audioIdx, subtitleId, prefs: getPlaybackPrefs(user.id) });
  if (!decision) return json({ error: "Fichier introuvable" }, { status: 404 });
  return json(decision);
}
