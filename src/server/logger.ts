// Minimal structured logger — JSON in production, human-readable in dev.
// No external logging dependency; everything stays local.
/* eslint-disable no-console */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVELS[(process.env.FLIX_LOG_LEVEL as Level) ?? (process.env.NODE_ENV === "production" ? "info" : "debug")] ?? 20;
// FLIX_LOG_FORMAT=pretty keeps human-readable lines even in production — for
// consoles that are read by eye (Pterodactyl panel, docker logs) rather than
// shipped to a log collector.
const asJson = process.env.FLIX_LOG_FORMAT === "json" || (process.env.NODE_ENV === "production" && process.env.FLIX_LOG_FORMAT !== "pretty");

function emit(level: Level, scope: string, message: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  if (asJson) {
    const line = JSON.stringify({ time, level, scope, message, ...fields });
    (level === "error" || level === "warn" ? console.error : console.log)(line);
    return;
  }
  const tag = `[${time}] ${level.toUpperCase().padEnd(5)} ${scope}`;
  const extra = fields && Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
  (level === "error" || level === "warn" ? console.error : console.log)(`${tag} — ${message}${extra}`);
}

export interface Logger {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit("debug", scope, m, f),
    info: (m, f) => emit("info", scope, m, f),
    warn: (m, f) => emit("warn", scope, m, f),
    error: (m, f) => emit("error", scope, m, f),
  };
}
