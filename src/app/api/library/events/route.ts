// Server-Sent Events stream of live scan progress, so clients render a
// progress bar without polling.

import { subscribeScan, getScanProgress } from "@/server/library/scanner";
import { getRequestUser } from "@/server/auth";
import { json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every open stream pins a subscriber + a ping timer for its whole lifetime,
// with nothing bounding how many one account may hold — cap it. 4 covers a
// household's realistic tab/device count for a single profile; anything past
// that is a leak or abuse. Decremented by the same cleanup that releases the
// subscriber, so the two counts can't drift apart.
const MAX_STREAMS_PER_USER = 4;
const activeStreams = new Map<number, number>();

export async function GET(request: Request) {
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const active = activeStreams.get(user.id) ?? 0;
  if (active >= MAX_STREAMS_PER_USER) {
    return json({ error: "Trop de connexions simultanées" }, { status: 429, headers: { "Retry-After": "5" } });
  }
  activeStreams.set(user.id, active + 1);
  const userId = user.id;

  const encoder = new TextEncoder();
  // Shared with cancel() below — a `closed` declared only inside start() would
  // be invisible to it, and the two cleanup paths couldn't guard each other.
  // `closed` means "enqueue is no longer possible"; `cleaned` means "teardown
  // already ran". They MUST be separate flags: a failed ping enqueue flips
  // closed=true on its own, so gating teardown on `closed` would skip
  // clearInterval(ping)/unsubscribe()/decrement and leak the timer + subscriber
  // + a MAX_STREAMS_PER_USER slot (a permanent 429 after 4 leaks). This mirrors
  // the `cleaned` fix already in /api/watch/room.
  let closed = false;
  let cleaned = false;
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
      const send = (data: unknown) => safeEnqueue(`data: ${JSON.stringify(data)}\n\n`);

      send(getScanProgress());
      const unsubscribe = subscribeScan(send);
      const ping = setInterval(() => safeEnqueue(": ping\n\n"), 25000);

      // Clean up OUR resources only. The runtime closes the controller itself
      // on disconnect; calling controller.close() here too lands as an
      // uncaught ERR_INVALID_STATE ("Controller is already closed") inside
      // Next's internals.
      cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        closed = true;
        clearInterval(ping);
        unsubscribe();
        const remaining = (activeStreams.get(userId) ?? 1) - 1;
        if (remaining <= 0) activeStreams.delete(userId);
        else activeStreams.set(userId, remaining);
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
      // Disable proxy buffering (nginx) so events flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
