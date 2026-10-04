import {
  isTerminalEventType,
  type CanonicalEvent,
  type CanonicalEventType,
  type SessionStatus,
} from "../types/observability.js";

/**
 * Canonical event-stream invariants.
 *
 * The event store is the history of record.  If it can contain a stream that
 * a reader cannot interpret -- a gap in the sequence, two terminal events, a
 * snapshot after the end -- then every consumer (SSE, replay, export, report,
 * analytics) inherits the ambiguity.  This module states the rules once and
 * returns *structured* diagnostics, so a failure names the offending event
 * instead of collapsing to a boolean that a caller is free to ignore.
 *
 * Rules checked:
 *
 *  I1  one session per stream
 *  I2  sequences are unique
 *  I3  sequences are strictly increasing in stream order
 *  I4  sequences are contiguous from 0 (no gaps, therefore no loss)
 *  I5  at most one terminal event
 *  I6  the terminal event, if present, is last
 *  I7  no process.snapshot after the terminal event
 *  I8  event ids are unique (no duplicate delivery)
 *  I9  the first event is execution.created (the stream has an origin)
 *  I10 a stream that ended has a terminal event (no unfinished histories)
 *  I11 every process.exited / process.exec_error / process.wait_failed has a
 *      preceding process.started for the same pid (no orphan lifecycle)
 *  I12 an execution reported as successful has a positive process.exited
 *      (the "summary is not proof of success" rule, checked structurally)
 *  I13 no event carries a corrupt payload that is being read as valid
 *  I14 a pipeline that reported completion accounted for every stage it declared,
 *      and no event claims a stage index outside the pipeline it belongs to
 */

export type InvariantId =
  | "I1-single-session"
  | "I2-unique-sequence"
  | "I3-increasing-sequence"
  | "I4-contiguous-sequence"
  | "I5-single-terminal"
  | "I6-terminal-is-last"
  | "I7-no-snapshot-after-terminal"
  | "I8-unique-event-id"
  | "I9-origin-event"
  | "I10-terminal-present-when-finalized"
  | "I11-no-orphan-process-lifecycle"
  | "I12-success-has-process-exit"
  | "I13-payload-not-corrupt"
  | "I14-pipeline-stages-accounted";

export type Severity = "error" | "warning";

export interface InvariantViolation {
  invariant: InvariantId;
  severity: Severity;
  message: string;
  /** Sequences involved, when the violation is about specific events. */
  sequences: number[];
  eventIds: string[];
}

export interface ValidationResult {
  valid: boolean;
  /** 0 error-severity violations. */
  errorCount: number;
  warningCount: number;
  violations: InvariantViolation[];
  /** Observed facts, so a caller can report what was actually checked. */
  summary: {
    sessionId: string | null;
    eventCount: number;
    firstSequence: number | null;
    lastSequence: number | null;
    terminalType: CanonicalEventType | null;
    terminalSequence: number | null;
  };
}

const LIFECYCLE_TYPES: readonly CanonicalEventType[] = [
  "process.exited",
  "process.exec_error",
  "process.wait_failed",
];

function violation(
  invariant: InvariantId,
  message: string,
  events: CanonicalEvent[] = [],
  severity: Severity = "error",
): InvariantViolation {
  return {
    invariant,
    severity,
    message,
    sequences: events.map((e) => e.sequence),
    eventIds: events.map((e) => e.id),
  };
}

export interface ValidateOptions {
  /**
   * The status the session row claims.  When supplied, I10 checks that a
   * finalized row and a finished stream agree, which is the specific
   * disagreement that boot recovery used to create.
   */
  sessionStatus?: SessionStatus | null;
}

/**
 * Validate one session's event stream.
 *
 * `events` must be the stream in delivery order (ascending sequence).  It is
 * sorted defensively first, so a caller that passed an unsorted list still
 * gets an answer about the *stream* rather than about its argument.
 */
export function validateEventStream(events: CanonicalEvent[], options: ValidateOptions = {}): ValidationResult {
  const violations: InvariantViolation[] = [];
  const stream = [...events].sort((a, b) => a.sequence - b.sequence);

  // ---- I1 one session per stream -----------------------------------------
  const sessionIds = new Set(stream.map((e) => e.sessionId));
  if (sessionIds.size > 1) {
    violations.push(
      violation(
        "I1-single-session",
        `stream mixes ${sessionIds.size} sessions: ${[...sessionIds].join(", ")}`,
        stream,
      ),
    );
  }

  // ---- I2 / I8 uniqueness ------------------------------------------------
  const seenSequences = new Set<number>();
  const seenIds = new Set<string>();
  for (const e of stream) {
    if (seenSequences.has(e.sequence)) {
      violations.push(violation("I2-unique-sequence", `sequence ${e.sequence} appears more than once`, [e]));
    }
    seenSequences.add(e.sequence);

    if (seenIds.has(e.id)) {
      violations.push(violation("I8-unique-event-id", `event id ${e.id} was delivered more than once`, [e]));
    }
    seenIds.add(e.id);
  }

  // ---- I3 strictly increasing --------------------------------------------
  for (let i = 1; i < stream.length; i++) {
    if (stream[i]!.sequence <= stream[i - 1]!.sequence) {
      violations.push(
        violation("I3-increasing-sequence", `sequence did not increase: ${stream[i - 1]!.sequence} then ${stream[i]!.sequence}`, [
          stream[i - 1]!,
          stream[i]!,
        ]),
      );
    }
  }

  // ---- I4 contiguous from zero -------------------------------------------
  if (stream.length > 0) {
    for (let i = 0; i < stream.length; i++) {
      if (stream[i]!.sequence !== i) {
        violations.push(
          violation(
            "I4-contiguous-sequence",
            `expected sequence ${i} but found ${stream[i]!.sequence}; the stream has a gap or an unexpected start`,
            [stream[i]!],
          ),
        );
        break; // one report is enough; the rest would be the same defect
      }
    }
  }

  // ---- I5 / I6 / I7 terminal handling -------------------------------------
  const terminals = stream.filter((e) => isTerminalEventType(e.type));
  if (terminals.length > 1) {
    violations.push(
      violation("I5-single-terminal", `stream has ${terminals.length} terminal events`, terminals),
    );
  }
  const terminal = terminals[0] ?? null;
  if (terminal !== null && stream[stream.length - 1] !== terminal) {
    violations.push(
      violation("I6-terminal-is-last", `terminal event ${terminal.type} at sequence ${terminal.sequence} is not the last event (${stream[stream.length - 1]!.type} at ${stream[stream.length - 1]!.sequence} is)`, [
        terminal,
        stream[stream.length - 1]!,
      ]),
    );
  }
  if (terminal !== null) {
    const after = stream.filter((e) => e.sequence > terminal.sequence);
    const lateSnapshots = after.filter((e) => e.type === "process.snapshot");
    if (lateSnapshots.length > 0) {
      violations.push(
        violation("I7-no-snapshot-after-terminal", `${lateSnapshots.length} telemetry sample(s) were recorded after the terminal event`, lateSnapshots),
      );
    }
  }

  // ---- I9 origin ----------------------------------------------------------
  if (stream.length > 0 && stream[0]!.type !== "execution.created") {
    violations.push(
      violation("I9-origin-event", `stream begins with ${stream[0]!.type}, not execution.created`, [stream[0]!]),
    );
  }

  // ---- I10 database / event agreement -------------------------------------
  const status = options.sessionStatus ?? null;
  if (status !== null) {
    const finalized = ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(status);
    if (finalized && terminal === null) {
      violations.push(
        violation(
          "I10-terminal-present-when-finalized",
          `session row says ${status} but the event stream has no terminal event; replay would show an unfinished execution`,
        ),
      );
    }
    if (!finalized && terminal !== null) {
      violations.push(
        violation(
          "I10-terminal-present-when-finalized",
          `event stream is terminal (${terminal.type}) but the session row still says ${status}`,
          [terminal],
        ),
      );
    }
  }

  // ---- I11 orphan process lifecycle ---------------------------------------
  /*
   * Keyed on (pid, stage), not pid alone.
   *
   * A PID uniquely identifies a process at any instant, but a pipeline has
   * several processes and the reader's question is "which one is this event
   * about?". Keying on the pair means an event that claims stage 2 for a pid
   * whose only `process.started` was stage 1 is reported as an orphan, which is
   * the corruption it actually is. For a single command the stage is -1 on
   * every event, so the pair degenerates to the pid and behaves exactly as
   * before.
   */
  const startedProcesses = new Set<string>();
  for (const e of stream) {
    const stage = typeof e.payload["stage"] === "number" ? e.payload["stage"] : -1;
    const key = typeof e.pid === "number" ? `${e.pid}@${stage}` : null;
    if (e.type === "process.started" && key !== null) startedProcesses.add(key);
    if (LIFECYCLE_TYPES.includes(e.type) && key !== null && !startedProcesses.has(key)) {
      violations.push(
        violation(
          "I11-no-orphan-process-lifecycle",
          `${e.type} for pid ${e.pid} stage ${stage} has no preceding process.started for the same pid and stage`,
          [e],
        ),
      );
    }
  }

  // ---- I14 pipeline envelope ------------------------------------------------
  /*
   * If the stream says a pipeline completed, every stage it declared must have
   * a terminal event of its own.
   *
   * Without this, a truncated stream could report `pipeline.completed` with
   * two of three stages' exits missing, and every consumer that trusts the
   * envelope would conclude the third process finished cleanly. This is the
   * invariant that makes the envelope evidence rather than decoration.
   */
  const pipelineCompleted = stream.find((e) => e.type === "pipeline.completed");
  if (pipelineCompleted !== undefined) {
    const declared =
      typeof pipelineCompleted.payload["stages"] === "number" ? (pipelineCompleted.payload["stages"] as number) : 0;
    if (declared > 0) {
      const terminated = new Set<number>();
      for (const e of stream) {
        if (typeof e.payload["stage"] === "number" && LIFECYCLE_TYPES.includes(e.type)) {
          terminated.add(e.payload["stage"] as number);
        }
      }
      for (let stage = 0; stage < declared; stage += 1) {
        if (!terminated.has(stage)) {
          violations.push(
            violation(
              "I14-pipeline-stages-accounted",
              `pipeline.completed declares ${declared} stage(s) but stage ${stage} has no ${LIFECYCLE_TYPES.join("/")} event`,
              [pipelineCompleted],
            ),
          );
        }
      }
    }
  }

  /*
   * The stages a stream declares must agree with itself. A process.started
   * claiming stage 5 of a 2-stage pipeline is a malformed record, and
   * accepting it would put a node in the 3D view that no pipeline could have
   * produced.
   */
  const declaredStages = stream.reduce<number | null>((acc, e) => {
    const n = e.payload["stages"];
    if (typeof n !== "number") return acc;
    return acc === null ? n : Math.max(acc, n);
  }, null);
  if (declaredStages !== null && declaredStages > 0) {
    for (const e of stream) {
      const stage = e.payload["stage"];
      if (typeof stage !== "number") continue;
      if (stage < -1 || stage >= declaredStages) {
        violations.push(
          violation(
            "I14-pipeline-stages-accounted",
            `${e.type} claims stage ${stage} in a pipeline declaring ${declaredStages} stage(s)`,
            [e],
          ),
        );
      }
    }
  }

  // ---- I12 success implies a real process exit ---------------------------
  if (terminal?.type === "execution.completed") {
    const exits = stream.filter((e) => e.type === "process.exited" && e.payload.exitCode === 0);
    if (exits.length === 0) {
      violations.push(
        violation(
          "I12-success-has-process-exit",
          "execution.completed with no process.exited carrying exitCode 0; a session summary is not proof of success",
          [terminal],
        ),
      );
    }
  }

  // ---- I13 payload integrity ----------------------------------------------
  for (const e of stream) {
    if (e.payload.payloadCorrupt === true) {
      violations.push(
        violation(
          "I13-payload-not-corrupt",
          `event ${e.id} has an unreadable stored payload: ${String(e.payload.payloadError ?? "unknown")}`,
          [e],
          "warning",
        ),
      );
    }
  }

  const errorCount = violations.filter((v) => v.severity === "error").length;
  return {
    valid: errorCount === 0,
    errorCount,
    warningCount: violations.length - errorCount,
    violations,
    summary: {
      sessionId: sessionIds.size === 1 ? [...sessionIds][0]! : null,
      eventCount: stream.length,
      firstSequence: stream[0]?.sequence ?? null,
      lastSequence: stream[stream.length - 1]?.sequence ?? null,
      terminalType: terminal?.type ?? null,
      terminalSequence: terminal?.sequence ?? null,
    },
  };
}

/** One-line human summary, for logs and the report endpoint. */
export function describeValidation(result: ValidationResult): string {
  if (result.valid && result.warningCount === 0) return "event stream is valid";
  const parts = result.violations.map((v) => `${v.invariant}: ${v.message}`);
  return `${result.valid ? "valid with warnings" : "INVALID"} - ${parts.join(" | ")}`;
}
