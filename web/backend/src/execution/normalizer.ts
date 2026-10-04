import type { CanonicalEvent, CanonicalEventType, EventSource, EngineOutcome } from "../types/observability.js";
import type { RawCapsEvent } from "./parser.js";

/**
 * Map a raw CAPS event name to its canonical type. Unknown names become null;
 * the gateway records a parser warning rather than inventing a meaning.
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
  WAIT_FAILED: "process.wait_failed",
  PIPELINE_PARSED: "pipeline.parsed",
  PIPELINE_STARTED: "pipeline.started",
  PIPELINE_COMPLETED: "pipeline.completed",
  EXECUTION_FAILED: "process.launch_failed",
  SESSION_SUMMARY: "session.summary",
};

/**
 * Engine events that are about one specific stage of the execution.
 *
 * Everything else is session-scoped and deliberately carries no `stage`.
 */
const STAGE_SCOPED: ReadonlySet<string> = new Set([
  "PROCESS_STARTED",
  "PROCESS_EXITED",
  "SIGNAL_RECEIVED",
  "EXEC_ERROR",
  "WAIT_FAILED",
  "PIPELINE_PARSED",
  "PIPELINE_STARTED",
  "PIPELINE_COMPLETED",
]);

/** Outcomes the engine is allowed to report; anything else is treated as unknown. */
const OUTCOMES: readonly EngineOutcome[] = [
  "COMPLETED",
  "EXITED",
  "SIGNALED",
  "EXEC_FAILED",
  "LAUNCH_FAILED",
  "WAIT_FAILED",
];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function outcomeOf(raw: RawCapsEvent): EngineOutcome | null {
  const o = str(raw.outcome);
  return o !== null && (OUTCOMES as readonly string[]).includes(o) ? (o as EngineOutcome) : null;
}

/**
 * Build the payload.
 *
 * The failure fields (`exit_code`, `errno`, `errno_name`, `reason`, `outcome`)
 * are carried verbatim.  They used to be dropped at this boundary, which meant
 * the 126-vs-127 distinction and the kernel errno never survived the trip from
 * the C engine, and a consumer could only read a human-readable diagnostic.
 */
function rawPayload(raw: RawCapsEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (str(raw.command) !== null) payload.label = raw.command;
  if (num(raw.pid) !== null) payload.pid = raw.pid;

  /*
   * Pipeline position, carried only on stage-scoped events.
   *
   * A session-level event -- `command.received`, `command.parsed`, the
   * summary -- describes the whole execution and genuinely belongs to no
   * stage.  It therefore carries NO `stage` field at all, rather than a
   * sentinel: "this event is not about one stage" is real information, and the
   * event type already says so.  The alternative, a sentinel, forced every
   * reader to special-case a magic number and made a malformed event
   * indistinguishable from a legitimately stage-less one.
   *
   * So the fallbacks below apply only where a stage is required, and there the
   * engine has already emitted one.  If a fallback ever fires there, the record
   * is malformed, and I13/I14 are what report it.
   */
  if (STAGE_SCOPED.has(str(raw.event) ?? "")) {
    payload.stage = num(raw.stage) ?? -1;
    payload.stages = num(raw.stages) ?? 0;
  }
  const pgid = num(raw.pgid);
  if (pgid !== null) payload.pgid = pgid;
  if (num(raw.exit_code) !== null) payload.exitCode = raw.exit_code;
  if (num(raw.duration_ms) !== null) payload.durationMs = raw.duration_ms;
  if (num(raw.signal) !== null) payload.signal = raw.signal;

  // Failure information. `exitCode` is explicitly allowed to be null for a
  // launch/wait failure, which is different from "exit code 0".
  payload.exitCode = num(raw.exit_code);
  payload.errno = num(raw.errno) ?? 0;
  payload.errnoName = str(raw.errno_name) ?? "";
  payload.reason = str(raw.reason) ?? "";
  const outcome = outcomeOf(raw);
  if (outcome !== null) payload.outcome = outcome;

  if (num(raw.commands) !== null) payload.commands = raw.commands;
  if (num(raw.succeeded) !== null) payload.succeeded = raw.succeeded;
  if (num(raw.failed) !== null) payload.failed = raw.failed;
  if (num(raw.signals) !== null) payload.signals = raw.signals;
  if (num(raw.timed) !== null) payload.timed = raw.timed;
  if (num(raw.exec_errors) !== null) payload.exec_errors = raw.exec_errors;
  if (num(raw.launch_errors) !== null) payload.launch_errors = raw.launch_errors;
  if (typeof raw.observed_cleanly === "boolean") payload.observed_cleanly = raw.observed_cleanly;
  if (num(raw.average_duration_ms) !== null) payload.averageDurationMs = raw.average_duration_ms;

  /*
   * The argv the engine actually handed to execve, per stage.
   *
   * This used to be dropped here, which quietly removed the only authoritative
   * record of what each stage ran. Everything downstream then had to reconstruct
   * it: the pipeline evidence surface read `argv` from `process.started`, found
   * nothing, and rendered "not recorded: the stage produced no start event" for
   * stages that had demonstrably started -- on a screenshot whose whole purpose
   * was to show the argv.
   *
   * The gateway does NOT rebuild it. The joined `label` is already lossy (an
   * element containing a space and two elements without both render the same), so
   * re-splitting the label here would be a second lexer, and two lexers
   * eventually disagree about one quoting case.
   *
   * `argv_truncated` travels with it. A shortened argv is not a short one: the
   * elements after the cut are unknown, not absent, and a reader has to be able
   * to tell those apart.
   */
  if (Array.isArray(raw.argv)) payload.argv = raw.argv.map((a) => String(a));
  if (raw.argv_truncated === true) payload.argv_truncated = true;
  if (num(raw.argv_elements_dropped) !== null) payload.argv_elements_dropped = raw.argv_elements_dropped;
  if (num(raw.argv_elements_total) !== null) payload.argv_elements_total = raw.argv_elements_total;

  /*
   * Where each stage's stdin and stdout go, as the engine labelled them.
   *
   * These are the engine's own strings ("pipe", "terminal", a filename) taken from
   * the parse result, so the record can say "this stage's output is a pipe" instead
   * of the reader inferring it from a neighbouring field.
   */
  if (str(raw.stdin_source) !== null) payload.stdinSource = raw.stdin_source;
  if (str(raw.stdout_dest) !== null) payload.stdoutDest = raw.stdout_dest;

  return payload;
}

/**
 * Normalize one valid raw CAPS monitor event into the canonical envelope.
 *
 * The gateway adds the sequence number, session id, and its own timestamp;
 * engine-supplied values (pid, exit_code, duration_ms, signal, errno, reason,
 * outcome, command label) pass through untouched.
 */
export function normalizeCapsEvent(
  raw: RawCapsEvent,
  ctx: { sessionId: string; sequence: number; evId: (prefix: string) => string; rawTs: number },
): CanonicalEvent | null {
  const name = str(raw.event);
  if (name === null) return null;
  const type = CAPS_EVENT_NAMES[name];
  if (type === undefined) return null;

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
  extra?: { pid?: number | null; monotonicMs?: number | null; timestamp?: string },
): CanonicalEvent {
  const now = Date.now();
  return {
    id: ctx.evId("evt"),
    sessionId: ctx.sessionId,
    sequence: ctx.sequence,
    type,
    source,
    timestamp: extra?.timestamp ?? new Date(now).toISOString(),
    monotonicMs: extra?.monotonicMs ?? null,
    pid: extra?.pid ?? null,
    payload,
  };
}
