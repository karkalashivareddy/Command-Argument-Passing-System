import type { CanonicalEvent, TelemetryProvenance } from "../types/observability";
import { buildEvidenceIndex, eventCursorMs, type EvidenceIndex } from "./evidenceCorrelation";
import { exitStatusLabel, fmtClock, fmtDuration } from "./format";

/**
 * THE EXECUTION EVIDENCE CHAIN
 * ============================
 * Ten stages, in the order the kernel performs them, each carrying the record's
 * own verdict about itself:
 *
 *   REQUEST   the gateway accepted a structured command + argv
 *   ARGV      the accepted vector, as the engine tokenised it
 *   SESSION   the persisted session record and the execution envelope
 *   FORK      fork() returned a child PID
 *   EXEC      execvp() was ATTEMPTED and did not fail          <- see below
 *   PROCESS   the child as an identified process (PID + start time)
 *   PROCFS    procfs snapshots the collector actually read
 *   EXIT      how the process ended
 *   WAIT      the waitpid() status the parent reaped
 *   SUMMARY   the gateway's own final word on the execution
 *
 * WHY THIS IS NOT `LIFECYCLE_STAGES`
 * ----------------------------------
 * The canonical vocabulary in `stages.ts` and `LIFECYCLE_STAGES` is the eight
 * stages of a pipeline diagram: it answers "what shape was the run". This chain
 * answers a different question — "for each step, what does the record actually
 * contain, and where did it come from" — and so it splits stages that the
 * pipeline diagram merges: FORK/PROCESS/PROCFS are three different observations
 * (a PID from the engine, an identity with a kernel start time, and procfs files
 * the collector read), and EXIT/WAIT/SUMMARY are three different reporters (the
 * engine, the parent's waitpid, and the gateway). Collapsing them would repeat
 * one event under three labels, which is the failure mode this whole file exists
 * to prevent. Where a stage means the same thing in both vocabularies, its
 * definition below REUSES the canonical label and detail from `LIFECYCLE_STAGES`
 * so the two surfaces cannot drift apart in their wording.
 *
 * THE EXEC STAGE, AND WHY IT IS `DERIVED` AND NOT `OBSERVED`
 * ----------------------------------------------------------
 * CAPS HAS NO "EXEC SUCCEEDED" EVENT. README states it outright: exec success is
 * `DERIVED` "from the engine's own `outcome` on the exit event; there is no
 * separate 'exec ok' event", and a `session.summary` is explicitly NOT success
 * because a failed execvp() emits one too.
 *
 * So the only defensible EXEC verdict is what this module produces: exec was
 * ATTEMPTED (a child exists) and no failure was recorded against it. That is an
 * inference from two facts, it is labelled `DERIVED`, and it is never promoted
 * to "exec succeeded". Where the record cannot support even that — the child was
 * killed by a signal, so it may have died before execvp() completed — the stage
 * reads UNAVAILABLE with the reason, rather than guessing.
 *
 * Nothing here is invented. A stage with no evidence reads UNAVAILABLE and says
 * which event it was waiting for.
 */

export type ChainState = "observed" | "derived" | "failed" | "unavailable";

export interface ChainStage {
  id: string;
  label: string;
  /** What the kernel actually did here. Reused from the canonical vocabulary. */
  detail: string;
  state: ChainState;
  /** Feeds ProvenanceBadge directly, so a stage cannot be drawn without its class. */
  provenance: TelemetryProvenance;
  /** The record that carried this stage's evidence. */
  source: string;
  /** One real fact, with no placeholder. Absent evidence is described in `reason`. */
  value: string;
  /** Required whenever provenance is UNAVAILABLE: why the record cannot say. */
  reason?: string;
  /** The first event that satisfies this stage, for cursor moves. Null when unmet. */
  sequence: number | null;
  atMs: number | null;
  timestamp: string | null;
}

export interface EvidenceChain {
  stages: ChainStage[];
  index: EvidenceIndex;
  /** How many stages the record supports, out of the total. */
  supported: number;
  total: number;
}

/** Reused detail text, so the chain and the lifecycle rail describe a stage identically. */
const LIFECYCLE_DETAIL: Record<string, string> = {
  input: "A request arrives at the gateway carrying a command name and an argument vector.",
  argv: "The engine's own lexer builds the vector the program will receive. There is no shell.",
  fork: "fork() returns a child PID. The kernel allocates the PID here, before exec.",
  exec: "execvp() replaces the child's image. A failure here is an exec error, not an exit.",
  wait: "waitpid() reaps the child and yields an exit code or a terminating signal.",
  result: "The gateway finalises the session and records its own outcome.",
};

function stage(
  id: string,
  label: string,
  detail: string,
  parts: Omit<ChainStage, "id" | "label" | "detail">,
): ChainStage {
  return { id, label, detail, ...parts };
}

/**
 * A stage the record says nothing about, which is a statement, not an omission.
 *
 * The id is derived from the label so a stage cannot be constructed with one id
 * and rendered under another label — the two would drift apart silently.
 */
function unavailable(label: string, detail: string, reason: string, source: string): ChainStage {
  return stage(label.toLowerCase(), label, detail, {
    state: "unavailable",
    provenance: "UNAVAILABLE",
    source,
    value: "UNAVAILABLE",
    reason,
    sequence: null,
    atMs: null,
    timestamp: null,
  });
}

/** The earliest event of any of these types, or null. */
function firstOf(events: CanonicalEvent[], types: readonly CanonicalEvent["type"][]): CanonicalEvent | null {
  return events.find((e) => types.includes(e.type)) ?? null;
}

function describe(ev: CanonicalEvent | null, index: EvidenceIndex): { sequence: number | null; atMs: number | null; timestamp: string | null } {
  if (ev === null) return { sequence: null, atMs: null, timestamp: null };
  return { sequence: ev.sequence, atMs: eventCursorMs(ev, index), timestamp: ev.timestamp };
}

/**
 * Build the chain from the record.
 *
 * `events` is the record as displayed — in replay that is the visible prefix, so
 * a reader who has scrubbed to the fork sees FORK satisfied and everything after
 * it honestly unavailable. That is the point: the chain describes what has been
 * shown so far, not a summary of the whole session pasted next to it.
 */
export function buildEvidenceChain(events: CanonicalEvent[]): EvidenceChain {
  const index = buildEvidenceIndex(events);
  const stages: ChainStage[] = [];

  // ---- REQUEST -------------------------------------------------------------
  const received = firstOf(events, ["command.received", "execution.created"]);
  if (received === null) {
    stages.push(unavailable("REQUEST", LIFECYCLE_DETAIL.input!, "No command.received event in this record", "gateway request intake"));
  } else {
    const argv = Array.isArray(received.payload.argv) ? (received.payload.argv as unknown[]) : null;
    stages.push(
      stage("request", "REQUEST", LIFECYCLE_DETAIL.input!, {
        state: "observed",
        provenance: "OBSERVED",
        source: "gateway event stream",
        value: argv === null ? `received · ${fmtClock(received.timestamp)}` : `received · argv[${argv.length}] · ${fmtClock(received.timestamp)}`,
        ...describe(received, index),
      }),
    );
  }

  // ---- ARGV ----------------------------------------------------------------
  const parsed = firstOf(events, ["command.parsed"]);
  if (parsed === null) {
    stages.push(
      unavailable("ARGV", LIFECYCLE_DETAIL.argv!, "No command.parsed event in this record", "engine lexer"),
    );
  } else {
    const argv = Array.isArray(parsed.payload.argv) ? (parsed.payload.argv as unknown[]).map(String) : null;
    stages.push(
      stage("argv", "ARGV", LIFECYCLE_DETAIL.argv!, {
        state: "observed",
        provenance: "OBSERVED",
        source: "engine lexer",
        value: argv === null ? "parsed · no argv array in payload" : `${argv.length} element${argv.length === 1 ? "" : "s"}: ${argv.join(" ")}`,
        ...describe(parsed, index),
      }),
    );
  }

  // ---- SESSION -------------------------------------------------------------
  const sessionEvent = firstOf(events, ["execution.started", "execution.created"]);
  if (sessionEvent === null) {
    stages.push(
      unavailable("SESSION", "The gateway persisted a session row and opened the execution envelope.", "No execution.started event in this record", "gateway session store"),
    );
  } else {
    stages.push(
      stage("session", "SESSION", "The gateway persisted a session row and opened the execution envelope.", {
        state: "observed",
        provenance: "OBSERVED",
        source: "gateway session store",
        value: `${sessionEvent.sessionId} · opened ${fmtClock(sessionEvent.timestamp)}`,
        ...describe(sessionEvent, index),
      }),
    );
  }

  // ---- FORK ----------------------------------------------------------------
  const started = firstOf(events, ["process.started"]);
  if (started === null) {
    stages.push(
      unavailable("FORK", LIFECYCLE_DETAIL.fork!, "No process.started event: no child PID was ever reported", "CAPS monitor"),
    );
  } else {
    stages.push(
      stage("fork", "FORK", LIFECYCLE_DETAIL.fork!, {
        state: "observed",
        provenance: "OBSERVED",
        source: "CAPS monitor PROCESS_STARTED",
        value: started.pid === null ? "fork reported, PID UNAVAILABLE in envelope" : `child PID ${started.pid} · ${fmtClock(started.timestamp)}`,
        ...describe(started, index),
      }),
    );
  }

  // ---- EXEC ----------------------------------------------------------------
  stages.push(buildExecStage(events, index));

  // ---- PROCESS -------------------------------------------------------------
  const child = index.processes.find((p) => p.identity.role === "child") ?? null;
  if (child === null) {
    stages.push(
      unavailable("PROCESS", "The child as an identified process: session + PID + kernel-derived start time.", "No process identity was established in this record", "evidence correlation index"),
    );
  } else {
    stages.push(
      stage("process", "PROCESS", "The child as an identified process: session + PID + kernel-derived start time.", {
        state: child.identity.processStartTime === null ? "derived" : "observed",
        provenance: child.identity.processStartTime === null ? "DERIVED" : "OBSERVED",
        source: "evidence correlation index",
        value:
          child.identity.processStartTime === null
            ? `PID ${child.identity.pid} · start time UNAVAILABLE, so identity rests on session + PID alone`
            : `PID ${child.identity.pid} · start ${child.identity.processStartTime}`,
        ...describe(index.bySequence.get(child.firstSequence) ?? null, index),
      }),
    );
  }

  // ---- PROCFS --------------------------------------------------------------
  const samples = events.filter((e) => e.type === "process.snapshot");
  if (samples.length === 0) {
    stages.push(
      unavailable("PROCFS", "procfs snapshots the collector actually read from /proc for this child.", "No process.snapshot events: the process was gone before a sample could be read", "procfs collector"),
    );
  } else {
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    stages.push(
      stage("procfs", "PROCFS", "procfs snapshots the collector actually read from /proc for this child.", {
        state: "observed",
        provenance: "OBSERVED",
        source: "/proc/<pid>/stat, status, io",
        value: `${samples.length} sample${samples.length === 1 ? "" : "s"} · ${fmtClock(first.timestamp)} → ${fmtClock(last.timestamp)}`,
        ...describe(first, index),
      }),
    );
  }

  // ---- EXIT ----------------------------------------------------------------
  const execError = firstOf(events, ["process.exec_error"]);
  const waitFailed = firstOf(events, ["process.wait_failed"]);
  const exited = firstOf(events, ["process.exited"]);
  if (execError !== null || waitFailed !== null) {
    const ev = execError ?? waitFailed!;
    const reason = typeof ev.payload.reason === "string" ? ev.payload.reason : "the engine recorded a failure and gave no reason";
    stages.push(
      stage("exit", "EXIT", "How the process ended, as the engine reported it.", {
        state: "failed",
        provenance: "OBSERVED",
        source: `CAPS monitor ${ev.type}`,
        value: ev.type === "process.exec_error" ? "execvp() FAILED — no program ran" : "waitpid() FAILED — the process outcome is unknown",
        reason,
        ...describe(ev, index),
      }),
    );
  } else if (exited === null) {
    stages.push(
      unavailable("EXIT", "How the process ended, as the engine reported it.", "No process.exited event: the child has not been reaped in this record", "CAPS monitor PROCESS_EXITED"),
    );
  } else {
    const code = typeof exited.payload.exitCode === "number" ? exited.payload.exitCode : null;
    const signal = typeof exited.payload.signal === "number" ? exited.payload.signal : null;
    stages.push(
      stage("exit", "EXIT", "How the process ended, as the engine reported it.", {
        state: "observed",
        provenance: "OBSERVED",
        source: "CAPS monitor PROCESS_EXITED",
        value: exitStatusLabel(code, signal),
        ...describe(exited, index),
      }),
    );
  }

  // ---- WAIT ----------------------------------------------------------------
  const signalEvent = firstOf(events, ["signal.received"]);
  if (waitFailed !== null) {
    stages.push(
      stage("wait", "WAIT", LIFECYCLE_DETAIL.wait!, {
        state: "failed",
        provenance: "OBSERVED",
        source: "CAPS monitor PROCESS_WAIT_FAILED",
        value: "waitpid() did not return a status for this child",
        reason: typeof waitFailed.payload.reason === "string" ? waitFailed.payload.reason : "the engine recorded the failure and gave no reason",
        ...describe(waitFailed, index),
      }),
    );
  } else if (exited === null) {
    stages.push(
      unavailable("WAIT", LIFECYCLE_DETAIL.wait!, "The parent has not reaped a child in this record", "CAPS monitor waitpid"),
    );
  } else {
    const code = typeof exited.payload.exitCode === "number" ? exited.payload.exitCode : null;
    const sig = typeof exited.payload.signal === "number" ? exited.payload.signal : signalEvent !== null && typeof signalEvent.payload.signal === "number" ? signalEvent.payload.signal : null;
    const duration = typeof exited.payload.durationMs === "number" ? exited.payload.durationMs : null;
    stages.push(
      stage("wait", "WAIT", LIFECYCLE_DETAIL.wait!, {
        state: "observed",
        provenance: "OBSERVED",
        source: "CAPS monitor waitpid status",
        value:
          duration === null
            ? exitStatusLabel(code, sig)
            : `${exitStatusLabel(code, sig)} · reaped after ${fmtDuration(duration)} (CAPS CLOCK_MONOTONIC)`,
        ...describe(exited, index),
      }),
    );
  }

  // ---- SUMMARY -------------------------------------------------------------
  const summaryEvent = firstOf(events, ["session.summary"]);
  const terminal = firstOf(events, ["execution.completed", "execution.failed", "execution.timeout", "execution.cancelled"]);
  if (terminal === null) {
    stages.push(
      unavailable("SUMMARY", "The gateway's own final word: the session was finalised and its outcome recorded.", "No terminal execution.* event: the gateway has not finalised this session", "gateway session store"),
    );
  } else {
    stages.push(
      stage("summary", "SUMMARY", "The gateway's own final word: the session was finalised and its outcome recorded.", {
        state: terminal.type === "execution.completed" ? "observed" : terminal.type === "execution.failed" ? "failed" : "observed",
        provenance: "OBSERVED",
        source: "gateway session store",
        value: `${terminal.type}${summaryEvent === null ? "" : " · session.summary also recorded (the monitor closing, which is NOT a success signal)"}`,
        ...describe(terminal, index),
      }),
    );
  }

  return {
    stages,
    index,
    supported: stages.filter((s) => s.state !== "unavailable").length,
    total: stages.length,
  };
}

/**
 * The EXEC stage, stated as precisely as the event contract allows.
 *
 * CAPS emits `process.exec_error` when execvp() FAILS and has no event for
 * success, so the strongest true statement is "exec was attempted and no
 * failure was recorded". That is `DERIVED`. Three branches, and each one states
 * its own limit rather than rounding up to "succeeded":
 *
 *   failure recorded        FAILED  — the record says so outright
 *   child exists, no error  DERIVED — attempted and did not fail
 *   child exists, signalled UNAVAILABLE — it may have died before execvp()
 *                                completed, so the record cannot say
 *   no child at all         UNAVAILABLE — nothing to attribute an exec to
 */
function buildExecStage(events: CanonicalEvent[], index: EvidenceIndex): ChainStage {
  const detail = LIFECYCLE_DETAIL.exec!;
  const evidenceNote = "CAPS has no exec-success event: this is exec attempted and not recorded as failed, not a confirmation that it worked.";

  const execError = firstOf(events, ["process.exec_error", "process.launch_failed"]);
  const started = firstOf(events, ["process.started"]);

  if (execError !== null) {
    return stage("exec", "EXEC", detail, {
      state: "failed",
      provenance: "OBSERVED",
      source: `CAPS monitor ${execError.type}`,
      value: "execvp() FAILED — the image was never replaced",
      reason:
        typeof execError.payload.reason === "string"
          ? execError.payload.reason
          : "the engine recorded the exec failure and gave no reason",
      ...describe(execError, index),
    });
  }

  if (started === null) {
    return unavailable("EXEC", detail, "No child was created, so there is nothing to attribute an execvp() to", "CAPS monitor");
  }

  const signalled = firstOf(events, ["signal.received"]);
  const exited = firstOf(events, ["process.exited"]);
  const imageSeen = events.find((e) => e.type === "process.snapshot" && typeof e.payload.command === "object" && e.payload.command !== null);

  if (signalled !== null && exited === null) {
    const sig = typeof signalled.payload.signal === "number" ? signalled.payload.signal : null;
    return stage("exec", "EXEC", detail, {
      state: "unavailable",
      provenance: "UNAVAILABLE",
      source: "CAPS monitor",
      value: "UNAVAILABLE",
      reason: `The child was terminated by signal${sig === null ? "" : ` ${sig}`} and never exited normally, so the record cannot say whether execvp() completed first. ${evidenceNote}`,
      ...describe(started, index),
    });
  }

  return stage("exec", "EXEC", detail, {
    state: "derived",
    provenance: "DERIVED",
    source: imageSeen === undefined ? "absence of process.exec_error, after process.started" : `absence of process.exec_error; program image observed in ${imageSeen.type} #${imageSeen.sequence}`,
    value: exited === null
      ? "execvp() attempted, no failure recorded — the child has not exited yet"
      : `execvp() attempted, no failure recorded; the child then exited normally${imageSeen === undefined ? "" : ` and procfs observed the image "${String((imageSeen.payload.command as { value?: unknown }).value ?? "")}"`}`,
    reason: evidenceNote,
    ...describe(started, index),
  });
}
