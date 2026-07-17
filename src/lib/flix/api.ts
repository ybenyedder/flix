"use client";

// Thin fetch client for the Flix server API. Every UI component goes through
// this so the token/redirect-on-401 logic lives in exactly one place. Same
// origin only (this is a single self-hosted server, not a multi-backend
// client like Auralis's Android app) — but the session token is still
// persisted to localStorage and sent as a bearer on every request, which is
// what will let a future Electron/WebView/Android client stay logged in
// across restarts even when the session cookie is dropped.
// Model: /home/pc/Documents/auralis_enterprise_grade/src/lib/auralis/api.ts

const TOKEN_KEY = "flix.token";

function readLocalStorage(key: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key)?.trim() ?? "";
  } catch {
    return "";
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export const api = {
  token(): string {
    return readLocalStorage(TOKEN_KEY);
  },
  setToken(value: string | null): void {
    if (typeof window === "undefined") return;
    try {
      if (value) window.localStorage.setItem(TOKEN_KEY, value.trim());
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable (private mode / quota) — token auth degrades to cookie-only */
    }
  },
  /** Registers the single callback fired when any request comes back 401 — the
   *  session expired or was revoked server-side. AuthGate uses this to drop
   *  back to the profile picker without a hard page reload. */
  onUnauthorized(handler: UnauthorizedHandler | null): void {
    unauthorizedHandler = handler;
  },
  headers(extra?: HeadersInit): HeadersInit {
    const token = this.token();
    return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
  },
  /** Resolve an /api/images/<hash> URL (optionally width-bucketed). Null input
   *  (no cover yet extracted) returns null so callers can render a fallback. */
  imageUrl(hash: string | null | undefined, width?: number): string | null {
    if (!hash) return null;
    return `/api/images/${hash}${width ? `?w=${width}` : ""}`;
  },
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(path, {
      ...init,
      headers: this.headers(init.headers),
      credentials: "include",
      cache: init.cache ?? "no-store",
    });
    if (res.status === 401) {
      this.setToken(null);
      unauthorizedHandler?.();
      throw new ApiError(401, "Session expirée");
    }
    if (!res.ok) {
      let message = `${init.method ?? "GET"} ${path} -> ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        /* non-JSON error body — keep the generic message */
      }
      throw new ApiError(res.status, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  },
  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  },
  /** Like get(), but lets the browser HTTP cache revalidate with
   *  If-None-Match and reuse the stored body on a 304 — used for
   *  /api/library, which emits a stable ETag keyed on the catalogue version. */
  getCached<T>(path: string): Promise<T> {
    return this.request<T>(path, { cache: "no-cache" });
  },
  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  },
  del<T = unknown>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  },
  /** Best-effort fire-and-forget POST for teardown moments (pause, tab close,
   *  player unmount) where a normal fetch could be cancelled mid-flight by
   *  the page unloading. Prefers `navigator.sendBeacon` (survives unload);
   *  falls back to a `keepalive` fetch when beacon is unavailable/rejects. */
  beacon(path: string, body: unknown): void {
    const payload = JSON.stringify(body);
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const blob = new Blob([payload], { type: "application/json" });
        if (navigator.sendBeacon(path, blob)) return;
      }
    } catch {
      /* fall through to fetch */
    }
    void fetch(path, { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: payload, credentials: "include", keepalive: true }).catch(() => {});
  },
};
