// Watch-party ("Séance") endpoint. One route, two verbs:
//   GET  ?code=…&conn=…  → Server-Sent Events stream for a member (snapshots +
//                          transport + reactions/chat), same plumbing as
//                          /api/library/events (per-connection ping, abort
//                          cleanup).
//   POST { action, … }   → every mutation, discriminated by `action` the same
//                          way /api/state discriminates by `kind`.
//
// The room state machine itself lives in src/server/watch/party.ts; this file is
// only auth + CSRF + validation + the SSE transport. All state is in-memory, no
// outbound calls — consistent with the project's zero-network mandate.

import type { UserRow } from "@/server/auth";
import { getRequestUser } from "@/server/auth";
import { checkCsrf, readJsonBody, json } from "@/server/http";
import { clientKey, rateLimitWindow } from "@/server/rateLimit";
import {
  createRoom,
  joinRoom,
  leaveRoom,
  subscribe,
  control,
  setTarget,
  react,
  chat,
  normalizeCode,
} from "@/server/watch/party";
import type { PartyControlAction, PartyIdentity, PartyServerEvent, PartyTarget } from "@/lib/flix/party";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

function identity(user: UserRow): PartyIdentity {
  return { userId: user.id, username: user.username, avatar: user.avatar };
}

// --- SSE subscribe ---------------------------------------------------------

export async function GET(request: Request) {
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const code = normalizeCode(url.searchParams.get("code") ?? "");
  const rawConnId = (url.searchParams.get("conn") ?? "").slice(0, 64);
  if (!code || !rawConnId) return json({ error: "code/conn manquants" }, { status: 400 });
  // The conn id is client-chosen and keys the room-wide connection map — prefix
  // it with the authenticated user so one member can never overwrite (and later
  // tear down) another member's connection slot by echoing their id.
  const connId = `${user.id}:${rawConnId}`;

  const encoder = new TextEncoder();
  let closed = false;
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: PartyServerEvent) => safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);

      const sub = subscribe(code, user.id, connId, send);
      if (!sub.ok) {
        // Surface the reason to the client as one event, then end the stream —
        // an EventSource can't read a non-200 body, so a 403/404 would just look
        // like a generic connection error otherwise.
        send({ t: "closed", reason: sub.error });
        safeEnqueue("");
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }

      send(sub.value.initial);
      const ping = setInterval(() => safeEnqueue(": ping\n\n"), 25000);

      // Resource teardown must be idempotent AND independent of `closed`: a
      // failed enqueue flips closed=true first, so gating teardown on `closed`
      // would make the later abort/cancel return BEFORE clearing the ping
      // interval and unsubscribing → a leaked timer and a never-freed connection
      // slot. `closed` keeps gating enqueues; a separate `cleaned` flag gates the
      // one-time teardown so abort and cancel() both reliably reclaim it even
      // once the stream has errored.
      let cleaned = false;
      cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        closed = true;
        clearInterval(ping);
        sub.value.unsubscribe();
      };
      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// --- POST mutations --------------------------------------------------------

interface RoomBody {
  action?: unknown;
  code?: unknown;
  target?: unknown;
  position?: unknown;
  startAt?: unknown;
  autoplay?: unknown;
  controlAction?: unknown;
  emoji?: unknown;
  text?: unknown;
}

const CONTROL_ACTIONS = new Set<PartyControlAction>(["play", "pause", "seek"]);

function parseTarget(raw: unknown): PartyTarget | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (t.kind !== "movie" && t.kind !== "episode") return null;
  const id = Number(t.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const target: PartyTarget = { kind: t.kind, id };
  if (Number.isInteger(Number(t.topId)) && Number(t.topId) > 0) target.topId = Number(t.topId);
  if (Number.isInteger(Number(t.mediaFileId)) && Number(t.mediaFileId) > 0) target.mediaFileId = Number(t.mediaFileId);
  if (typeof t.title === "string") target.title = t.title.slice(0, 300);
  if (typeof t.subtitle === "string") target.subtitle = t.subtitle.slice(0, 300);
  return target;
}

function result(r: { ok: true } | { ok: false; error: string; status: number }) {
  return r.ok ? json({ ok: true }) : json({ error: r.error }, { status: r.status });
}

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readJsonBody<RoomBody>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (typeof body.action !== "string") return json({ error: "action invalide" }, { status: 400 });

  if (body.action === "create") {
    // Same discipline as join: authenticated, but still bounded — party.ts also
    // caps concurrent rooms per host.
    if (rateLimitWindow(`user:${user.id}:party-create`, 10, 60_000)) {
      return json({ error: "Trop de tentatives, réessayez dans un instant" }, { status: 429, headers: { "Retry-After": "10" } });
    }
    const res = createRoom(identity(user));
    if (!res.ok) return json({ error: res.error }, { status: res.status });
    return json({ ok: true, code: res.value.code, youId: user.id, snapshot: res.value.snapshot });
  }

  // Every other action targets an existing room by code.
  const code = normalizeCode(typeof body.code === "string" ? body.code : "");
  if (!code) return json({ error: "code manquant" }, { status: 400 });

  if (body.action === "join") {
    // Codes are unguessable, but throttle blind guessing anyway (per IP).
    if (rateLimitWindow(clientKey(request, "party-join"), 30, 60_000)) {
      return json({ error: "Trop de tentatives, réessayez dans un instant" }, { status: 429, headers: { "Retry-After": "10" } });
    }
    const res = joinRoom(code, identity(user));
    if (!res.ok) return json({ error: res.error }, { status: res.status });
    return json({ ok: true, code, youId: user.id, snapshot: res.value.snapshot });
  }

  if (body.action === "leave") {
    leaveRoom(code, user.id);
    return json({ ok: true });
  }

  if (body.action === "control") {
    const controlAction = body.controlAction;
    if (typeof controlAction !== "string" || !CONTROL_ACTIONS.has(controlAction as PartyControlAction)) {
      return json({ error: "controlAction invalide" }, { status: 400 });
    }
    // Generous (a scrub burst is legitimate) but bounded: every control fans
    // out to every connection in the room.
    if (rateLimitWindow(`user:${user.id}:party-control`, 60, 10_000)) {
      return json({ error: "Trop de commandes, réessayez dans un instant" }, { status: 429, headers: { "Retry-After": "3" } });
    }
    const position = Number(body.position);
    return result(control(code, user.id, controlAction as PartyControlAction, position));
  }

  if (body.action === "target") {
    // Host-only, but still bounded like control/reaction/chat: every target
    // change fans a full snapshot out to every connection in the room.
    if (rateLimitWindow(`user:${user.id}:party-target`, 30, 10_000)) {
      return json({ error: "Trop de changements, réessayez dans un instant" }, { status: 429, headers: { "Retry-After": "3" } });
    }
    const target = parseTarget(body.target);
    const startAt = Number(body.startAt);
    const autoplay = body.autoplay !== false;
    return result(setTarget(code, user.id, target, Number.isFinite(startAt) ? startAt : 0, autoplay));
  }

  if (body.action === "reaction") {
    if (typeof body.emoji !== "string") return json({ error: "emoji invalide" }, { status: 400 });
    if (rateLimitWindow(`user:${user.id}:party-msg`, 20, 10_000)) {
      return json({ error: "Doucement sur les réactions !" }, { status: 429, headers: { "Retry-After": "5" } });
    }
    return result(react(code, user.id, body.emoji));
  }

  if (body.action === "chat") {
    if (typeof body.text !== "string") return json({ error: "text invalide" }, { status: 400 });
    // Shares the reaction window: both fan a broadcast out to the whole room.
    if (rateLimitWindow(`user:${user.id}:party-msg`, 20, 10_000)) {
      return json({ error: "Doucement sur le chat !" }, { status: 429, headers: { "Retry-After": "5" } });
    }
    return result(chat(code, user.id, body.text));
  }

  return json({ error: "action invalide" }, { status: 400 });
}
