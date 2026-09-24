import type { ChildProcess } from "node:child_process";

import type { ProcessRecord, SessionStatus } from "../types/observability.js";
import { logger } from "../utils/logger.js";

/**
 * One in-flight execution: enough live facts to expose real process state,
 * enforce limits, and deliver termination. Only PIDs produced by CAPS are
 * ever recorded here.
 */
export interface ActiveSession {
  sessionId: string;
  command: string;
  argv: string[];
  state: Exclude<SessionStatus, "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED"> | "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
  process: ChildProcess | null;
  childPid: number | null;
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
  sawSummary: boolean;
  killTimer: NodeJS.Timeout | null;
  /** line-assembly scratch for the stderr event stream */
  stderrEventBuffer: string;
  /** guards against double finalization on the exit path */
  finalized: boolean;
  /** authoritative per-session event sequence counter (threaded through caps/gateway paths) */
  nextSeq: number;
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
      if (s.state === "RUNNING" || s.state === "STARTING" || s.state === "CREATED") n++;
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

  markState(sessionId: string, state: ActiveSession["state"]): void {
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
      if (s.childPid === null || s.state === "COMPLETED" || s.state === "TIMED_OUT" || s.state === "CANCELLED" || s.state === "FAILED") continue;
      out.push({
        sessionId: s.sessionId,
        pid: s.childPid,
        command: s.command,
        argv: s.argv,
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

  /** Sweep sessions that stalled without a live process (defensive cleanup). */
  sweep(now = Date.now(), staleMs = 120_000): string[] {
    const stale: string[] = [];
    for (const [id, s] of this.sessions) {
      const hasLiveProc = s.process !== null && s.process.exitCode === null && s.process.signalCode === null;
      if (!hasLiveProc && now - s.lastEventAt > staleMs) {
        logger.warn("EXECUTION", "sweep removing stale session", { sessionId: id });
        stale.push(id);
      }
    }
    for (const id of stale) this.sessions.delete(id);
    return stale;
  }
}