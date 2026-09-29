type Scope = "SERVER" | "EXECUTION" | "SSE" | "STORAGE" | "SECURITY" | "TELEMETRY" | "CONFIG";

const ORDER = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof ORDER)[number];

/**
 * Structured, bounded logging.
 *
 * The level comes from validated configuration, not from a second raw read of
 * the environment.  The previous module read `process.env.CAPS_LOG_LEVEL` at
 * import time, which meant an invalid value silently became "info" and a test
 * or an embedder could not control it.
 *
 * Two rules the callers rely on:
 *   - secrets are never logged.  `redact` exists so a config object can be
 *     logged whole without leaking a token.
 *   - long values are truncated, so a large stdout tail cannot flood the log.
 */
const MAX_VALUE_LENGTH = 512;

let level: LogLevel = "info";

export function configureLogger(next: LogLevel): void {
  level = next;
}

export function currentLogLevel(): LogLevel {
  return level;
}

function shouldLog(candidate: LogLevel): boolean {
  return ORDER.indexOf(candidate) >= ORDER.indexOf(level);
}

function safeValue(v: unknown): string {
  if (typeof v === "string") {
    return v.length > MAX_VALUE_LENGTH ? `${v.slice(0, MAX_VALUE_LENGTH)}…[truncated ${v.length} chars]` : v;
  }
  if (v instanceof Error) return v.message;
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > MAX_VALUE_LENGTH ? `${s.slice(0, MAX_VALUE_LENGTH)}…[truncated]` : s;
  } catch {
    return "[unserialisable]";
  }
}

/** Build a copy of an object with sensitive keys replaced. */
export function redact<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = keys.some((s) => k.toLowerCase().includes(s.toLowerCase())) ? "[redacted]" : v;
  }
  return out;
}

function emit(candidate: LogLevel, scope: Scope, msg: string, fields?: Record<string, unknown>): void {
  if (!shouldLog(candidate)) return;
  const tail =
    fields && Object.keys(fields).length > 0
      ? " " + Object.entries(fields).map(([k, v]) => `${k}=${safeValue(v)}`).join(" ")
      : "";
  const line = `[${new Date().toISOString()}] ${candidate.toUpperCase().padEnd(5)} ${scope.padEnd(10)} ${msg}${tail}`;
  if (candidate === "error") console.error(line);
  else if (candidate === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (scope: Scope, msg: string, fields?: Record<string, unknown>) => emit("debug", scope, msg, fields),
  info: (scope: Scope, msg: string, fields?: Record<string, unknown>) => emit("info", scope, msg, fields),
  warn: (scope: Scope, msg: string, fields?: Record<string, unknown>) => emit("warn", scope, msg, fields),
  error: (scope: Scope, msg: string, fields?: Record<string, unknown>) => emit("error", scope, msg, fields),
};
