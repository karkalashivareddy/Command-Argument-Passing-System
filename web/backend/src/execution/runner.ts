import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

import type { CapsConfig } from "../config/env.js";
import type { EventRepository } from "../db/repositories/events.js";
import type { SessionRepository } from "../db/repositories/sessions.js";
import type { EventBus } from "../events/bus.js";
import type { CanonicalEvent, RedirectionSpec } from "../types/observability.js";
import { logger } from "../utils/logger.js";
import { newId } from "../utils/ids.js";
import { parseCapsLine, repairLineChunks } from "./parser.js";
import { gatewayEvent, normalizeCapsEvent } from "./normalizer.js";
import { ExecutionRegistry, type ActiveSession } from "./registry.js";
import { signalChild } from "./terminator.js";
import { readProcessSnapshot, type Metric, type ProcessSnapshot } from "./procfs.js";

const REDIR_FLAGS: Record<keyof RedirectionSpec, string> = {
  in: "O_RDONLY",
  out: "O_WRONLY | O_CREAT | O_TRUNC",
  append: "O_WRONLY | O_CREAT | O_APPEND",
};

/** Keep the tail of a bounded text buffer (prevents unbounded growth). */
function keepTail(buf: string, chunk: string, limit: number): string {
  const combined = buf + chunk;
  return combined.length <= limit ? combined : combined.slice(-limit);
}

export interface StartExecutionInput {
  command: string;
  executable: string;
  args: string[];
  redirections: RedirectionSpec;
  timeoutMs: number;
}

export type StartResult = { sessionId: string } | { error: { code: string; message: string } };

/** Minimal env for child processes: no secrets, PATH/LANG/TERM only. */
function sanitizedEnv(executable: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "HOME", "TERM"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.LANG ??= "C.UTF-8";
  env.TERM ??= "dumb";
  // The command allowlist resolves repository helpers to an absolute path.
  // Add only that trusted directory so execvp() can keep the requested argv[0]
  // (for example, "status_probe") while still locating the approved binary.
  if (isAbsolute(executable)) {
    const helperDir = dirname(executable);
    const pathEntries = (env.PATH ?? "").split(":").filter(Boolean);
    if (!pathEntries.includes(helperDir)) env.PATH = [helperDir, ...pathEntries].join(":");
  }
  return env;
}

export class ExecutionRunner {
  /** "stdout:<id>" and "stderr:<id>" bounded text channels. */
  private readonly buffers = new Map<string, string>();
  private readonly lastSnapshots = new Map<string, ProcessSnapshot>();
  private readonly processIdentity = new Map<string, number | null>();
  private readonly lastSampleMonotonic = new Map<string, number>();
  private readonly sampler: NodeJS.Timeout;

  constructor(
    private readonly config: CapsConfig,
    private readonly sessions: SessionRepository,
    private readonly events: EventRepository,
    private readonly bus: EventBus,
    private readonly registry: ExecutionRegistry,
  ) {
    mkdirSync(config.workspace, { recursive: true });
    this.sampler = setInterval(() => this.sampleTrackedProcesses(), 500);
    this.sampler.unref();
  }

  close(): void {
    clearInterval(this.sampler);
    this.lastSnapshots.clear();
    this.processIdentity.clear();
    this.lastSampleMonotonic.clear();
  }

  start(input: StartExecutionInput): StartResult {
    if (!this.registry.hasCapacity()) {
      return {
        error: {
          code: "CONCURRENCY_LIMIT_REACHED",
          message: `Maximum concurrent executions reached (${this.config.maxConcurrent}).`,
        },
      };
    }

    const sessionId = newId("exec");
    const startedAt = new Date().toISOString();
    this.sessions.create({
      id: sessionId,
      command: input.command,
      args: input.args,
      redirections: input.redirections,
      timeoutMs: input.timeoutMs,
      startedAt,
    });
    recordRedirections(this.sessions, sessionId, input.redirections);

    // Every event on this session gets a monotonically-increasing sequence.
    // Start strictly after anything already persisted (defensive: this is a
    // brand new session, so the initial value is -1 + 1 = 0).
    let seq = this.events.maxSequence(sessionId) + 1;
    this.events.insert(gatewayEvent({ sessionId, sequence: seq, evId: newId }, "gateway", "execution.created", {}));
    seq += 1;

    // CAPS argv: monitor + optional redirection descriptors + command args verbatim.
    const capsArgv: string[] = [this.config.capsExecutable, "--monitor", "--json"];
    if (input.redirections.in) capsArgv.push("--redir-in", input.redirections.in);
    if (input.redirections.out) capsArgv.push("--redir-out", input.redirections.out);
    if (input.redirections.append) capsArgv.push("--redir-append", input.redirections.append);
    capsArgv.push(input.command, ...input.args);

    logger.info("EXECUTION", "spawning caps", {
      sessionId,
      command: input.command,
      argumentCount: input.args.length,
      argvBytes: Buffer.byteLength(input.command) + input.args.reduce((total, arg) => total + Buffer.byteLength(arg), 0),
      cwd: this.config.workspace,
    });

    let child: ChildProcess;
    try {
      child = spawn(capsArgv[0]!, capsArgv.slice(1), {
        cwd: this.config.workspace,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedEnv(input.executable),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sessions.finalize(sessionId, {
        status: "FAILED", exitCode: null, signal: null, isSuccess: false,
        durationMs: null, pid: null, error: message,
      });
      this.events.insert(gatewayEvent({ sessionId, sequence: seq++, evId: newId }, "gateway", "execution.failed", { reason: message }));
      return { error: { code: "SPAWN_FAILED", message } };
    }

    this.buffers.set(key("stdout", sessionId), "");
    this.buffers.set(key("stderr", sessionId), "");

    const active: ActiveSession = {
      sessionId,
      command: input.command,
      argv: [input.command, ...input.args],
      state: "STARTING",
      process: child,
      childPid: null,
      processStartedAt: null,
      processReaped: false,
      startedAt,
      monotonicStartMs: Date.now(),
      exitCode: null,
      signal: null,
      timedOut: false,
      terminateRequested: false,
      timeoutMs: input.timeoutMs,
      lastEventAt: Date.now(),
      stdoutBytes: 0,
      stderrBytes: 0,
      sawSummary: false,
      killTimer: null,
      stderrEventBuffer: "",
      finalized: false,
      nextSeq: seq,
    };
    this.registry.add(active);

    this.emit(gatewayEvent({ sessionId, sequence: active.nextSeq, evId: newId }, "gateway", "execution.started", { argv: capsArgv.slice(1) }));
    active.state = "RUNNING";

    // stderr walker: JSON monitor events interleaved with caps diagnostics.
    const onStderr = (chunk: Buffer | string): void => {
      active.stderrBytes += chunk.length;
      active.lastEventAt = Date.now();
      const text = chunk.toString();
      this.append("stderr", sessionId, text);
      const result = repairLineChunks(active.stderrEventBuffer + text);
      active.stderrEventBuffer = result.rest;
      for (const line of result.lines) {
        const parsed = parseCapsLine(line);
        if (parsed.kind === "event" && parsed.event) {
          const normalized = normalizeCapsEvent(parsed.event, {
            sessionId, sequence: active.nextSeq, evId: newId, rawTs: Date.now(),
          });
          if (normalized) {
            this.emit(normalized);
            this.observe(sessionId, normalized);
          }
        } else if (parsed.kind === "diagnostic" && parsed.text) {
          this.append("stderr", sessionId, parsed.text + "\n");
        }
      }
    };

    // stdout is the executed program's real output (never event JSON).
    const onStdout = (chunk: Buffer | string): void => {
      active.stdoutBytes += chunk.length;
      active.lastEventAt = Date.now();
      this.append("stdout", sessionId, chunk.toString());
    };

    child.stderr?.on("data", onStderr);
    child.stdout?.on("data", onStdout);

    // Timeout: politely signal the real child, then escalate.
    active.killTimer = setTimeout(() => this.handleTimeout(active), input.timeoutMs);
    active.killTimer.unref?.();

    child.on("error", (err) => {
      logger.error("EXECUTION", "caps spawn error", { sessionId, err: err.message });
      this.finalizeFailed(active, `execution could not start: ${err.message}`);
    });

    child.on("close", (code, signalCode) => {
      if (active.killTimer) clearTimeout(active.killTimer);
      this.flushStderrTail(active);
      this.finalize(active, code, signalCode);
    });

    return { sessionId };
  }

  /** Process any partial last line so a final event/diagnostic is never lost. */
  private flushStderrTail(active: ActiveSession): void {
    const sessionId = active.sessionId;
    const tail = active.stderrEventBuffer.trim();
    if (tail.length === 0) return;
    const parsed = parseCapsLine(tail);
    if (parsed.kind === "event" && parsed.event) {
      const normalized = normalizeCapsEvent(parsed.event, {
        sessionId, sequence: active.nextSeq, evId: newId, rawTs: Date.now(),
      });
      if (normalized) {
        this.emit(normalized);
        this.observe(sessionId, normalized);
      }
    } else if (parsed.kind === "diagnostic" && parsed.text) {
      this.append("stderr", sessionId, parsed.text.trimEnd() + "\n");
    }
    active.stderrEventBuffer = "";
  }

  private handleTimeout(active: ActiveSession): void {
    const sessionId = active.sessionId;
    if (active.timedOut || active.finalized) return;
    active.timedOut = true;
    active.state = "TIMED_OUT";
    logger.warn("EXECUTION", "timeout reached", { sessionId, timeoutMs: active.timeoutMs });
    this.emit(gatewayEvent({ sessionId, sequence: active.nextSeq, evId: newId }, "gateway", "execution.timeout", { timeoutMs: active.timeoutMs }));
    signalChild(active.childPid, "SIGTERM");
    setTimeout(() => signalChild(active.childPid, "SIGKILL"), 2000).unref?.();
  }

  private emit(ev: CanonicalEvent): void {
    const active = this.registry.get(ev.sessionId);
    if (active) ev.sequence = active.nextSeq++;
    this.events.insert(ev);
    this.bus.publish(ev);
  }

  private observe(sessionId: string, ev: CanonicalEvent): void {
    const active = this.registry.get(sessionId);
    if (!active) return;
    switch (ev.type) {
      case "process.started":
        active.state = "RUNNING";
        active.childPid = ev.pid;
        active.processStartedAt = ev.timestamp;
        active.processReaped = false;
        this.processIdentity.delete(sessionId);
        this.lastSampleMonotonic.delete(sessionId);
        if (ev.pid) this.sessions.setPid(sessionId, ev.pid);
        this.sampleProcess(sessionId, ev.pid);
        break;
      case "signal.received":
        if (typeof ev.payload.signal === "number") active.signal = ev.payload.signal;
        break;
      case "process.exited":
        if (typeof ev.payload.exitCode === "number") active.exitCode = ev.payload.exitCode;
        active.processReaped = true;
        this.lastSnapshots.delete(sessionId);
        this.processIdentity.delete(sessionId);
        this.lastSampleMonotonic.delete(sessionId);
        break;
      case "process.exec_error":
        active.processReaped = true;
        this.lastSnapshots.delete(sessionId);
        this.processIdentity.delete(sessionId);
        this.lastSampleMonotonic.delete(sessionId);
        break;
      case "session.summary":
        active.sawSummary = true;
        break;
      default:
        break;
    }
  }

  private sampleTrackedProcesses(): void {
    for (const target of this.registry.listTelemetryTargets()) this.sampleProcess(target.sessionId, target.pid);
  }

  private sampleProcess(sessionId: string, pid: number | null): void {
    if (pid === null) return;
    const active = this.registry.get(sessionId);
    if (!active || active.childPid !== pid || active.processStartedAt === null || active.finalized) return;
    if (this.processIdentity.has(sessionId) && this.processIdentity.get(sessionId) === null) return;

    let snapshot = readProcessSnapshot(pid);
    const capsEnginePid = active.process?.pid;
    snapshot.capsEnginePid = typeof capsEnginePid === "number"
      ? { value: capsEnginePid, provenance: "OBSERVED", source: "gateway child_process.spawn" }
      : { value: null, provenance: "UNAVAILABLE", source: "gateway child_process.spawn", reason: "CAPS child PID was not returned by the host runtime" };
    const procStartTicks = snapshot.identityStartTicks;
    const priorIdentity = this.processIdentity.get(sessionId);
    const capsParentPid = typeof capsEnginePid === "number" ? capsEnginePid : null;
    if (procStartTicks !== null && (capsParentPid === null || snapshot.ppid.value !== capsParentPid)) {
      snapshot = makeUnavailable(snapshot, "procfs PPID does not match the gateway-spawned CAPS process; this PID is not accepted as the tracked child");
      this.processIdentity.set(sessionId, null);
    }
    if (procStartTicks !== null && !this.processIdentity.has(sessionId) && priorIdentity === undefined) {
      const procStartMs = Date.parse(snapshot.startTime.value ?? "");
      const capsStartMs = Date.parse(active.processStartedAt);
      if (!Number.isFinite(procStartMs) || !Number.isFinite(capsStartMs) || Math.abs(procStartMs - capsStartMs) > 2000) {
        snapshot = makeUnavailable(snapshot, "The procfs PID start time does not match this CAPS process-start event; possible PID reuse");
        this.processIdentity.set(sessionId, null);
      } else {
        this.processIdentity.set(sessionId, procStartTicks);
      }
    } else if (procStartTicks !== null && this.processIdentity.get(sessionId) !== null && priorIdentity !== procStartTicks) {
      snapshot = makeUnavailable(snapshot, "The tracked PID identity changed during execution; procfs sampling stopped");
      this.processIdentity.set(sessionId, null);
    }

    if (procStartTicks === null && !this.processIdentity.has(sessionId)) this.processIdentity.set(sessionId, null);

    const previous = this.lastSnapshots.get(sessionId);
    if (snapshot.identityStartTicks !== null && previous) {
      const previousCpu = (previous.cpuUserMs.value ?? 0) + (previous.cpuSystemMs.value ?? 0);
      const currentCpu = (snapshot.cpuUserMs.value ?? 0) + (snapshot.cpuSystemMs.value ?? 0);
      const wallMs = performance.now() - (this.lastSampleMonotonic.get(sessionId) ?? performance.now());
      if (previous.cpuUserMs.value !== null && previous.cpuSystemMs.value !== null && snapshot.cpuUserMs.value !== null && snapshot.cpuSystemMs.value !== null && wallMs > 0) {
        snapshot.cpuPercent = { value: Math.max(0, ((currentCpu - previousCpu) / wallMs) * 100), provenance: "DERIVED", source: "delta(/proc stat utime+stime) / delta(sample wall time)" };
      }
    }

    const { identityStartTicks: _identity, ...payload } = snapshot;
    const event = gatewayEvent({ sessionId, sequence: active.nextSeq, evId: newId }, "gateway", "process.snapshot", payload, { pid });
    this.emit(event);
    if (snapshot.identityStartTicks !== null) {
      this.lastSnapshots.set(sessionId, snapshot);
      this.lastSampleMonotonic.set(sessionId, performance.now());
    }
  }

  private append(channel: "stdout" | "stderr", sessionId: string, text: string): void {
    const k = key(channel, sessionId);
    const cur = this.buffers.get(k) ?? "";
    this.buffers.set(k, keepTail(cur, text, this.config.maxOutputBytes));
  }

  private finalize(active: ActiveSession, code: number | null, signalCode: NodeJS.Signals | null): void {
    const sessionId = active.sessionId;
    if (active.finalized) return;
    active.finalized = true;

    const exitCode = signalCode ? null : code;
    const durationMs = Math.max(0, Date.now() - active.monotonicStartMs);

    const status: ActiveSession["state"] = active.timedOut
      ? "TIMED_OUT"
      : active.terminateRequested && active.signal !== null
        ? "CANCELLED"
        : active.sawSummary
          ? "COMPLETED"
          : "FAILED";

    const isSuccess = status === "COMPLETED" && active.signal === null && (exitCode === 0 || exitCode === null);

    this.sessions.finalize(sessionId, {
      status,
      exitCode,
      signal: active.signal,
      isSuccess,
      durationMs,
      pid: active.childPid,
      error:
        status === "FAILED"
          ? `caps exited with code ${code ?? "?"}${signalCode ? ` (${signalCode})` : ""}`
          : status === "TIMED_OUT"
            ? `execution timed out after ${active.timeoutMs}ms`
            : null,
    });

    const stdout = this.buffers.get(key("stdout", sessionId)) ?? "";
    const stderr = this.buffers.get(key("stderr", sessionId)) ?? "";
    this.buffers.delete(key("stdout", sessionId));
    this.buffers.delete(key("stderr", sessionId));
    this.sessions.appendOutput(sessionId, stdout, stderr);

    const finalType: CanonicalEvent["type"] =
      status === "TIMED_OUT" ? "execution.timeout"
      : status === "FAILED" ? "execution.failed"
      : "execution.completed";

    const payload =
      status === "TIMED_OUT"
        ? { timeoutMs: active.timeoutMs }
        : status === "FAILED"
          ? { reason: `caps exited with code ${code ?? "?"}`, exitCode: exitCode ?? code }
          : { status, exitCode, signal: active.signal, durationMs, isSuccess };

    this.emit(gatewayEvent({ sessionId, sequence: active.nextSeq, evId: newId }, "gateway", finalType, payload));

    this.registry.delete(sessionId);
    this.lastSnapshots.delete(sessionId);
    this.processIdentity.delete(sessionId);
    this.lastSampleMonotonic.delete(sessionId);
    logger.info("EXECUTION", "finalized", { sessionId, status, exitCode, signal: active.signal, durationMs });
  }

  private finalizeFailed(active: ActiveSession, reason: string): void {
    const sessionId = active.sessionId;
    if (active.finalized) return;
    active.finalized = true;
    this.sessions.finalize(sessionId, {
      status: "FAILED", exitCode: null, signal: null, isSuccess: false,
      durationMs: null, pid: null, error: reason,
    });
    this.emit(gatewayEvent({ sessionId, sequence: active.nextSeq, evId: newId }, "gateway", "execution.failed", { reason }));
    this.registry.delete(sessionId);
    this.lastSnapshots.delete(sessionId);
    this.processIdentity.delete(sessionId);
    this.lastSampleMonotonic.delete(sessionId);
  }

  stdoutFor(sessionId: string): string {
    return this.buffers.get(key("stdout", sessionId)) ?? "";
  }
  stderrFor(sessionId: string): string {
    return this.buffers.get(key("stderr", sessionId)) ?? "";
  }

  isTerminal(sessionId: string): boolean {
    const active = this.registry.get(sessionId);
    return active !== null && isTerminalState(active.state);
  }
}

function key(channel: "stdout" | "stderr", sessionId: string): string {
  return `${channel}:${sessionId}`;
}

function isTerminalState(s: string): boolean {
  return s === "COMPLETED" || s === "FAILED" || s === "TIMED_OUT" || s === "CANCELLED";
}

function recordRedirections(sessions: SessionRepository, sessionId: string, redirs: RedirectionSpec): void {
  if (redirs.in) sessions.recordRedirection(sessionId, "in", redirs.in, REDIR_FLAGS.in);
  if (redirs.out) sessions.recordRedirection(sessionId, "out", redirs.out, REDIR_FLAGS.out);
  if (redirs.append) sessions.recordRedirection(sessionId, "append", redirs.append, REDIR_FLAGS.append);
}

function makeUnavailable(snapshot: ProcessSnapshot, reason: string): ProcessSnapshot {
  const missing = <T>(metric: Metric<T>): Metric<T> => ({ value: null, provenance: "UNAVAILABLE", source: metric.source, reason });
  return {
    ...snapshot,
    command: missing(snapshot.command),
    ppid: missing(snapshot.ppid),
    processGroupId: missing(snapshot.processGroupId),
    sessionId: missing(snapshot.sessionId),
    state: missing(snapshot.state),
    startTime: missing(snapshot.startTime),
    elapsedMs: missing(snapshot.elapsedMs),
    cpuUserMs: missing(snapshot.cpuUserMs),
    cpuSystemMs: missing(snapshot.cpuSystemMs),
    cpuPercent: missing(snapshot.cpuPercent),
    rssBytes: missing(snapshot.rssBytes),
    virtualMemoryBytes: missing(snapshot.virtualMemoryBytes),
    threadCount: missing(snapshot.threadCount),
    voluntaryContextSwitches: missing(snapshot.voluntaryContextSwitches),
    nonVoluntaryContextSwitches: missing(snapshot.nonVoluntaryContextSwitches),
    identityStartTicks: null,
  };
}
