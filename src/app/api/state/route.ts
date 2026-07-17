// Per-profile state: my list / ratings / watch progress / watch events. GET
// returns the current user's snapshot; POST applies one mutation,
// discriminated by `kind`. Same CSRF/auth guards as every other mutating
// route in the project.
//
// `watchEvent` was added in Phase 6 (Phase 5 only wired up myList/rating/
// progress): the watch_events table has existed since the Phase 1 schema
// specifically for this, and a single extra discriminated `kind` here is a
// much smaller surface than a whole new route for one INSERT. `setWatched`
// (marquer vu / non vu, incl. a whole show) and `dismissProgress` (retirer de
// « Continuer à regarder ») follow the same one-kind-per-mutation pattern.

import { getRequestUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { checkCsrf, readJsonBody, json } from "@/server/http";
import {
  getUserState,
  toggleMyList,
  setRating,
  setProgress,
  recordWatchEvent,
  setWatched,
  dismissProgress,
  type ListItemType,
  type ProgressItemType,
  type WatchedItemType,
  type WatchEventKind,
} from "@/server/state/userState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One mutation = a kind discriminator plus a few numbers — a few KiB is ample.
const MAX_STATE_BODY_BYTES = 4 * 1024;

const STATE_KINDS = new Set(["myList", "rating", "progress", "watchEvent", "setWatched", "dismissProgress"]);

export async function GET(request: Request) {
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  // Pass the kids flag so a profile flipped from adult can't see its old adult
  // progress rows in "Continuer à regarder" (filtered in getProgressSummaries).
  return json(getUserState(user.id, user.is_kids === 1));
}

interface StateBody {
  kind?: unknown;
  itemType?: unknown;
  itemId?: unknown;
  add?: unknown;
  value?: unknown;
  position?: unknown;
  duration?: unknown;
  mediaFileId?: unknown;
  eventKind?: unknown;
  ratio?: unknown;
  seconds?: unknown;
  watched?: unknown;
}

function isListItemType(v: unknown): v is ListItemType {
  return v === "movie" || v === "show";
}
function isProgressItemType(v: unknown): v is ProgressItemType {
  return v === "movie" || v === "episode";
}
function isWatchedItemType(v: unknown): v is WatchedItemType {
  return v === "movie" || v === "episode" || v === "show";
}
function isWatchEventKind(v: unknown): v is WatchEventKind {
  return v === "complete" || v === "abandon";
}

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readJsonBody<StateBody>(request, MAX_STATE_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  // Validate the discriminator FIRST: an unknown kind should say so, not hide
  // behind an incidental "itemId invalide" from a body shaped for nothing.
  if (typeof body.kind !== "string" || !STATE_KINDS.has(body.kind)) return json({ error: "kind invalide" }, { status: 400 });

  const itemId = Number(body.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) return json({ error: "itemId invalide" }, { status: 400 });

  if (body.kind === "myList") {
    if (!isListItemType(body.itemType)) return json({ error: "itemType invalide" }, { status: 400 });
    const result = toggleMyList(user.id, body.itemType, itemId, body.add === true);
    if (!result.ok) return json({ error: result.error }, { status: 404 });
    return json({ ok: true });
  }

  if (body.kind === "rating") {
    if (!isListItemType(body.itemType)) return json({ error: "itemType invalide" }, { status: 400 });
    const value = Number(body.value);
    if (!Number.isInteger(value)) return json({ error: "value invalide" }, { status: 400 });
    const result = setRating(user.id, body.itemType, itemId, value);
    if (!result.ok) return json({ error: result.error }, { status: result.error === "Valeur invalide" ? 400 : 404 });
    return json({ ok: true });
  }

  if (body.kind === "progress") {
    if (!isProgressItemType(body.itemType)) return json({ error: "itemType invalide" }, { status: 400 });
    const position = Number(body.position);
    const duration = Number(body.duration);
    if (!Number.isFinite(position) || !Number.isFinite(duration) || position < 0 || duration < 0) {
      return json({ error: "position/duration invalides" }, { status: 400 });
    }
    // A position past the end is a client bug (seek math, stale duration) —
    // clamp rather than reject so the write still lands, but never persist
    // position > duration (it would render as a >100% progress bar).
    const clampedPosition = duration > 0 ? Math.min(position, duration) : position;
    let mediaFileId = typeof body.mediaFileId === "number" && Number.isInteger(body.mediaFileId) ? body.mediaFileId : null;
    if (mediaFileId !== null) {
      // Only persist a media_file_id that actually belongs to this item —
      // otherwise a client could pin its progress row to an arbitrary file.
      // Ignored (not a 400) so a client holding a stale id after a rescan
      // still gets its position saved.
      const ownerColumn = body.itemType === "movie" ? "movie_id" : "episode_id";
      const owned = getDb().prepare(`SELECT 1 FROM media_files WHERE id = ? AND ${ownerColumn} = ?`).get(mediaFileId, itemId);
      if (!owned) mediaFileId = null;
    }
    const result = setProgress(user.id, body.itemType, itemId, clampedPosition, duration, mediaFileId);
    if (!result.ok) return json({ error: result.error }, { status: 404 });
    return json({ ok: true });
  }

  if (body.kind === "setWatched") {
    if (!isWatchedItemType(body.itemType)) return json({ error: "itemType invalide" }, { status: 400 });
    if (typeof body.watched !== "boolean") return json({ error: "watched invalide" }, { status: 400 });
    const result = setWatched(user.id, body.itemType, itemId, body.watched);
    if (!result.ok) return json({ error: result.error }, { status: 404 });
    return json({ ok: true });
  }

  if (body.kind === "dismissProgress") {
    if (!isProgressItemType(body.itemType)) return json({ error: "itemType invalide" }, { status: 400 });
    const result = dismissProgress(user.id, body.itemType, itemId);
    if (!result.ok) return json({ error: result.error }, { status: 404 });
    return json({ ok: true });
  }

  if (body.kind === "watchEvent") {
    if (!isProgressItemType(body.itemType)) return json({ error: "itemType invalide" }, { status: 400 });
    if (!isWatchEventKind(body.eventKind)) return json({ error: "eventKind invalide" }, { status: 400 });
    const ratio = Number(body.ratio);
    const seconds = Number(body.seconds);
    if (!Number.isFinite(ratio) || !Number.isFinite(seconds) || seconds < 0) {
      return json({ error: "ratio/seconds invalides" }, { status: 400 });
    }
    const result = recordWatchEvent(user.id, body.itemType, itemId, body.eventKind, ratio, seconds);
    if (!result.ok) return json({ error: result.error }, { status: 404 });
    return json({ ok: true });
  }

  return json({ error: "kind invalide" }, { status: 400 });
}
