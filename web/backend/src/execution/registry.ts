import type { ChildProcess } from "node:child_process";

import type { ProcessRecord, SessionStatus } from "../types/observability.js";
import type { ProcessIdentity } from "./terminator.js";
import { logger } from "../utils/logger.js";

/**
 * One in-flight execution: enough live facts to expose real process state,
 * enforce limits, and deliver termination.  Only PIDs produced by CAPS are
 * ever recorded here.
 *
 * The engine's own lifecycle verdict is tracked separately from "the monitor
 * printed a summary".  `engineOutcome` is the only field that may decide
 * whether an execution succeeded; `sawSummary` records that the stream closed
 * and must never be used as a success signal.
 */
export interface ActiveSession {
  sessionId: string;
  command: string;
  argv: string[];
  state: SessionStatus;
  process: ChildProcess | null;
  childPid: number | null;
  /**
   * Kernel identity (pid + start ticks) captured when the child was first
   * signalled.  Every delayed or escalating signal is checked against it, so a
   * recycled PID is never killed.
   */
  childIdentity: ProcessIdentity | null;
  processStartedAt: string | null;
  processReaped: boolean;
  startedAt: string;
  monotonicStartMs: number;
  exitCode: number | null;
  signal: number | null;
  timedOut: boolean;
  terminateRequested: boolean;
  timeoutMs: number;
  lastEventAt: number;
  stdoutBytes: number;
  stderrBytes: number;
  /** The monitor stream closed.  NOT a success signal. */
  sawSummary: boolean;
  sawExecError: boolean;
  sawWaitFailure: boolean;
  sawLaunchFailure: boolean;
  /** The engine's machine-readable verdict for the observed process. */
  engineOutcome: string | null;
  engineReason: string | null;
  killTimer: NodeJS.Timeout | null;
  /** Pending identity-verified escalation, if one is in flight. */
  escalation: Promise<{ sent: boolean; reason: string }> | null;
  /** line-assembly scratch for the stderr event stream */
  stderrLineBuffer: string;
  /** guards against double finalization on the exit path */
  finalized: boolean;
  /** authoritative per-session event sequence counter */
  nextSeq: number;
}

const TERMINAL: ReadonlySet<string> = new Set(["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"]);

export function isTerminalState(state: string): boolean {
  return TERMINAL.has(state);
}

export class ExecutionRegistry {
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(private readonly maxConcurrent: number) {}

  get size(): number {
    return this.sessions.size;
  }

  get runningCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (!isTerminalState(s.state)) n++;
    }
    return n;
  }

  hasCapacity(): boolean {
    return this.runningCount < this.maxConcurrent;
  }

  add(s: ActiveSession): void {
    this.sessions.set(s.sessionId, s);
  }

  get(sessionId: string): ActiveSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  delete(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s?.killTimer) clearTimeout(s.killTimer);
    this.sessions.delete(sessionId);
  }

  list(): ActiveSession[] {
    return [...this.sessions.values()];
  }

  markState(sessionId: string, state: SessionStatus): void {
    const s = this.sessions.get(sessionId);
    if (s) s.state = state;
  }

  touch(sessionId: string, now = Date.now()): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastEventAt = now;
  }

  listProcesses(): ProcessRecord[] {
    const out: ProcessRecord[] = [];
    for (const s of this.sessions.values()) {
      if (s.childPid === null || isTerminalState(s.state)) continue;
      out.push({
        sessionId: s.sessionId,
        pid: s.childPid,
        command: s.command,
        argv: s.argv,
        // A process's state comes from its own observed lifecycle, never from a
        // record-wide flag.  A session with a signal event is not a reason to
        // call every process in it signal-terminated.
        state: s.state === "RUNNING" ? "RUNNING" : s.state === "STARTING" ? "STARTING" : "WAITING",
        startedAt: s.startedAt,
        endedAt: null,
        durationMs: Date.now() - s.monotonicStartMs,
        exitCode: s.exitCode,
        signal: s.signal,
      });
    }
    return out;
  }

  /**
   * Sweep sessions whose process is gone but which were never finalized.
   *
   * This is defensive cleanup for a case that should not happen: a finalized
   * execution is always removed here.  A session that survives is logged with
   * its state so the condition is visible rather than silently tidied away.
   */
  sweep(now = Date.now(), staleMs = 120_000): string[] {
    const stale: string[] = [];
    for (const [id, s] of this.sessions) {
      const hasLiveProc = s.process !== null && s.process.exitCode === null && s.process.signalCode === null;
      if (!hasLiveProc && now - s.lastEventAt > staleMs) {
        logger.warn("EXECUTION", "sweep removing stale session", { sessionId: id, state: s.state, finalized: s.finalized });
        stale.push(id);
      }
    }
    for (const id of stale) this.sessions.delete(id);
    return stale;
  }
}
