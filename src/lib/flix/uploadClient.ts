"use client";

// Chunked upload engine. Movie files run to several GB but the production
// instance sits behind a Cloudflare tunnel that caps a single request body at
// ~100 MB, so a file is sent as a sequence of fixed-size chunks (default
// 64 MiB) via raw octet-stream PUTs. Each chunk carries its byte offset; the
// server is the authority on how much it has (`received`), so a desynced
// offset (409) re-syncs from the server rather than failing. Raw bodies bypass
// api.request() (which JSON-encodes), but reuse api.headers() for auth.

import { api } from "@/lib/flix/api";
import type { UploadDestination } from "@/lib/flix/naming";

export interface UploadCapability {
  writable: boolean;
  freeBytes: number | null;
  chunkSize: number;
  sessions: ResumableSession[];
}

export interface ResumableSession {
  uploadId: string;
  filename: string;
  targetRel: string;
  size: number;
  received: number;
  updatedAt: string;
}

export interface InitInput {
  filename: string;
  size: number;
  destination: UploadDestination;
  // Must mirror the server's InitOptions (src/server/upload/manager.ts) — any
  // other value is coerced to undefined by the route and behaves like "reject".
  conflict?: "reject" | "rename";
}

export interface InitResponse {
  uploadId: string;
  chunkSize: number;
  received: number;
  targetRel: string;
}

export interface UploadProgress {
  received: number;
  total: number;
  /** Smoothed throughput in bytes/s, or null before the first sample. */
  bytesPerSec: number | null;
}

const RETRY_BACKOFF_MS = [1000, 4000, 15000];
const MAX_RESYNCS = 5;

export class UploadHttpError extends Error {
  status: number;
  received?: number;
  constructor(status: number, message: string, received?: number) {
    super(message);
    this.name = "UploadHttpError";
    this.status = status;
    this.received = received;
  }
}

export async function fetchCapability(): Promise<UploadCapability> {
  return api.get<UploadCapability>("/api/admin/upload");
}

export async function initUpload(input: InitInput): Promise<InitResponse> {
  return api.post<InitResponse>("/api/admin/upload", input);
}

export async function fetchResume(uploadId: string): Promise<{ uploadId: string; received: number; size: number; targetRel: string }> {
  return api.get(`/api/admin/upload/${uploadId}`);
}

export async function finalizeUpload(uploadId: string): Promise<{ rel: string; scan: string }> {
  return api.post(`/api/admin/upload/${uploadId}/finalize`);
}

export async function abortUpload(uploadId: string): Promise<void> {
  try {
    await api.del(`/api/admin/upload/${uploadId}`);
  } catch {
    /* best-effort — the server reaps stale sessions on its own after 24h */
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/** PUT one chunk at `offset`, returning the server's new `received`. Throws
 *  UploadHttpError (with `received` on a 409 offset mismatch) or an AbortError. */
async function putChunk(uploadId: string, offset: number, blob: Blob, signal: AbortSignal): Promise<number> {
  const res = await fetch(`/api/admin/upload/${uploadId}?offset=${offset}`, {
    method: "PUT",
    headers: api.headers({ "Content-Type": "application/octet-stream" }),
    body: blob,
    credentials: "include",
    cache: "no-store",
    signal,
  });
  if (res.ok) {
    const body = (await res.json()) as { received: number };
    return body.received;
  }
  let message = `chunk PUT -> ${res.status}`;
  let received: number | undefined;
  try {
    const body = (await res.json()) as { error?: string; received?: number };
    if (body.error) message = body.error;
    if (typeof body.received === "number") received = body.received;
  } catch {
    /* non-JSON body */
  }
  throw new UploadHttpError(res.status, message, received);
}

export interface SendOptions {
  uploadId: string;
  file: File;
  chunkSize: number;
  startOffset: number;
  signal: AbortSignal;
  onProgress: (progress: UploadProgress) => void;
}

/**
 * Drive one file to completion (all chunks accepted). Resolves when the whole
 * file is on the server; the caller then finalizes. Rejects with an AbortError
 * on pause/cancel, or an UploadHttpError on a non-retryable failure (e.g. 507
 * disk full, 401 session expired) after exhausting retries.
 */
export async function sendChunks(opts: SendOptions): Promise<void> {
  const { uploadId, file, chunkSize, signal, onProgress } = opts;
  let offset = opts.startOffset;
  let resyncs = 0;
  let ewma: number | null = null;

  while (offset < file.size) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const end = Math.min(offset + chunkSize, file.size);
    const blob = file.slice(offset, end);
    const chunkBytes = end - offset;

    let attempt = 0;
    for (;;) {
      const startedAt = performance.now();
      try {
        const received = await putChunk(uploadId, offset, blob, signal);
        const elapsed = (performance.now() - startedAt) / 1000;
        if (elapsed > 0) {
          const instant = chunkBytes / elapsed;
          ewma = ewma === null ? instant : ewma * 0.7 + instant * 0.3;
        }
        offset = received;
        onProgress({ received: offset, total: file.size, bytesPerSec: ewma });
        break;
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          throw err;
        }
        if (err instanceof UploadHttpError) {
          // Offset desync: trust the server's count and re-slice from there.
          if (err.status === 409 && typeof err.received === "number") {
            if (++resyncs > MAX_RESYNCS) throw err;
            offset = err.received;
            onProgress({ received: offset, total: file.size, bytesPerSec: ewma });
            break;
          }
          // 401 (session expired) and 5xx-with-a-clear-message are terminal for this file.
          if (err.status === 401 || err.status === 507 || err.status === 404) throw err;
        }
        if (attempt >= RETRY_BACKOFF_MS.length) throw err;
        await sleep(RETRY_BACKOFF_MS[attempt], signal);
        attempt += 1;
      }
    }
  }
}
