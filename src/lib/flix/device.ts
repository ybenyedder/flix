// Stable per-browser device id, persisted in localStorage. Playback sessions
// are capped at one live session per (userId, deviceId) — see
// src/server/playback/sessions.ts — so a reload or a track change on the same
// tab must keep reporting the same id (otherwise every reload would look like
// a brand new concurrent device and needlessly eat into the session cap).

const DEVICE_KEY = "flix.deviceId";

export function getDeviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const generated = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, generated);
    return generated;
  } catch {
    return "anonymous";
  }
}
