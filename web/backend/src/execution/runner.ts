import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";

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
  args: string[];
  redirections: RedirectionSpec;
  timeoutMs: number;
}

export type StartResult = { sessionId: string } | { error: { code: string; message: string } };

/** Minimal env for child processes: no secrets, PATH/LANG/TERM only. */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "HOME", "TERM"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.LANG ??= "C.UTF-8";
  env.TERM ??= "dumb";
  return env;
}

export class ExecutionRunner {
  /** "stdout:<id>" and "stderr:<id>" bounded text channels. */
  private readonly buffers = new Map<string, string>();

  constructor(
    private readonly config: CapsConfig,
    private readonly sessions: SessionRepository,
    private readonly events: EventRepository,
    private readonly bus: EventBus,
    private readonly registry: ExecutionRegistry,
  ) {
    mkdirSync(config.workspace, { recursive: true });
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
      sessionId, command: input.command, args: input.args, cwd: this.config.workspace,
    });

    let child: ChildProcess;
    try {
      child = spawn(capsArgv[0]!, capsArgv.slice(1), {
        cwd: this.config.workspace,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedEnv(),
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
        if (ev.pid) this.sessions.setPid(sessionId, ev.pid);
        break;
      case "signal.received":
        if (typeof ev.payload.signal === "number") active.signal = ev.payload.signal;
        break;
      case "process.exited":
        if (typeof ev.payload.exitCode === "number") active.exitCode = ev.payload.exitCode;
        break;
      case "session.summary":
        active.sawSummary = true;
        break;
      default:
        break;
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