import type { CanonicalEvent, CanonicalEventType, EventSource } from "../types/observability.js";
import type { RawCapsEvent } from "./parser.js";

/**
 * Map a raw CAPS event name to its canonical type. Unknown/unknown names
 * become null; the gateway records a parser warning rather than inventing
 * a meaning.
 */
const CAPS_EVENT_NAMES: Record<string, CanonicalEventType> = {
  COMMAND_RECEIVED: "command.received",
  PARSED: "command.parsed",
  COMMAND_PARSE_ERROR: "command.parse_error",
  REDIRECTION_OPENED: "redirection.opened",
  REDIRECTION_FAILED: "redirection.failed",
  PROCESS_STARTED: "process.started",
  PROCESS_EXITED: "process.exited",
  SIGNAL_RECEIVED: "signal.received",
  EXEC_ERROR: "process.exec_error",
  SESSION_SUMMARY: "session.summary",
};

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function rawPayload(raw: RawCapsEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (typeof raw.command === "string") payload.label = raw.command;
  if (typeof raw.pid === "number") payload.pid = raw.pid;
  if (typeof raw.exit_code === "number") payload.exitCode = raw.exit_code;
  if (typeof raw.duration_ms === "number") payload.durationMs = raw.duration_ms;
  if (typeof raw.signal === "number") payload.signal = raw.signal;
  if (typeof raw.commands === "number") payload.commands = raw.commands;
  if (typeof raw.succeeded === "number") payload.succeeded = raw.succeeded;
  if (typeof raw.failed === "number") payload.failed = raw.failed;
  if (typeof raw.signals === "number") payload.signals = raw.signals;
  if (typeof raw.timed === "number") payload.timed = raw.timed;
  if (typeof raw.average_duration_ms === "number") payload.averageDurationMs = raw.average_duration_ms;
  return payload;
}

/**
 * Normalize one valid raw CAPS monitor event into the canonical envelope.
 * The gateway adds the sequence number, session id, and its own monotonic
 * counter; CAPS-supplied values (pid, exit_code, duration_ms, signal,
 * command label) pass through untouched.
 */
export function normalizeCapsEvent(
  raw: RawCapsEvent,
  ctx: { sessionId: string; sequence: number; evId: (prefix: string) => string; rawTs: number },
): CanonicalEvent | null {
  const name = typeof raw.event === "string" ? raw.event : null;
  if (name === null) return null;
  const type = CAPS_EVENT_NAMES[name];
  if (type === undefined) return null;

  const isSummary = name === "SESSION_SUMMARY";
  return {
    id: ctx.evId("evt"),
    sessionId: ctx.sessionId,
    sequence: ctx.sequence,
    type,
    source: "caps",
    timestamp: new Date(ctx.rawTs).toISOString(),
    monotonicMs: num(raw.duration_ms),
    pid: num(raw.pid),
    payload: rawPayload(raw),
  };
}

export function gatewayEvent(
  ctx: { sessionId: string; sequence: number; evId: (prefix: string) => string },
  source: EventSource,
  type: CanonicalEventType,
  payload: Record<string, unknown>,
  extra?: { pid?: number | null; monotonicMs?: number | null; inMonotonicEpoch?: number },
): CanonicalEvent {
  const now = Date.now();
  return {
    id: ctx.evId("evt"),
    sessionId: ctx.sessionId,
    sequence: ctx.sequence,
    type,
    source,
    timestamp: new Date(now).toISOString(),
    monotonicMs: extra?.monotonicMs ?? null,
    pid: extra?.pid ?? null,
    payload,
  };
}