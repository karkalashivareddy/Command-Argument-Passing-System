import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import type { CapsConfig } from "../config/env.js";
import { transact } from "../db/database.js";
import type { EventRepository } from "../db/repositories/events.js";
import type { SessionRepository } from "../db/repositories/sessions.js";
import type { EventBus } from "../events/bus.js";
import { isTerminalStatus, type CanonicalEvent, type EngineOutcome, type RedirectionSpec, type SessionStatus } from "../types/observability.js";
import { TelemetrySampler, type TelemetrySample } from "../telemetry/sampler.js";
import { logger } from "../utils/logger.js";
import { newId } from "../utils/ids.js";
import { parseCapsLine } from "./parser.js";
import { classifyLine, splitLines } from "./output.js";
import { gatewayEvent, normalizeCapsEvent } from "./normalizer.js";
import { ExecutionRegistry, type ActiveSession } from "./registry.js";
import { escalateTo, forgetIdentity, rememberIdentity, signalChild, terminateGracefully, type ProcessIdentity } from "./terminator.js";

/** Displayed/recorded flag names for each redirection, matching open()/dup2(). */
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
  /**
   * The full command line, when the caller is the terminal rather than a
   * structured request.
   *
   * The line is NOT lexed by the gateway.  It is handed to the engine, which
   * lexes it with the same C lexer it will use to execute, and the gateway
   * validates the resulting argv through `caps --inspect` first.  Two lexers
   * would eventually disagree about a quoting edge case, and at that point the
   * gateway could approve a command the engine then runs -- which is the exact
   * failure the catalog exists to prevent.
   *
   * Mutually exclusive with `executable` + `redirections`: a line carries its
   * own redirections, and the `--redir-*` flags are a structured-request
   * mechanism.
   */
  commandLine?: string;
  /** Absolute, verified path of the binary that will actually be executed. */
  executable?: string;
  args?: string[];
  redirections?: RedirectionSpec;
  timeoutMs: number;
}

export type StartResult =
  | { sessionId: string }
  | { error: { code: string; message: string } };

/**
 * Environment for the engine and its child.
 *
 * No secrets are forwarded: the child gets PATH, LANG, HOME, TERM and
 * nothing else.  PATH is still needed because a *workload* may itself invoke
 * standard utilities; it is not needed to locate the allowlisted binary,
 * because that is passed to the engine as an absolute path.
 */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "HOME", "TERM"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.LANG ??= "C.UTF-8";
  env.TERM ??= "dumb";
  return env;
}

function key(channel: "stdout" | "stderr", sessionId: string): string {
  return `${channel}:${sessionId}`;
}

export interface OutputSnapshot {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  live: boolean;
}

export class ExecutionRunner {
  private readonly buffers = new Map<string, { text: string; truncated: boolean }>();
  private readonly telemetry: TelemetrySampler;
  private closing = false;

  constructor(
    private readonly config: CapsConfig,
    private readonly sessions: SessionRepository,
    private readonly events: EventRepository,
    private readonly bus: EventBus,
    private readonly registry: ExecutionRegistry,
    private readonly db: DatabaseSync,
  ) {
    mkdirSync(config.workspace, { recursive: true });
    this.telemetry = new TelemetrySampler({
      emit: (sample) => this.publishSnapshot(sample),
    });
  }

  close(): void {
    this.closing = true;
    this.telemetry.close();
    this.buffers.clear();
  }

  start(input: StartExecutionInput): StartResult {
    if (this.registry.hasCapacity()) {
      const sessionId = newId("exec");
      const startedAt = new Date().toISOString();

      // Session row, redirection rows, and the first event are one unit of
      // work.  A failure part-way through would otherwise leave a session with
      // no events, which replay cannot represent.
      //
      // A command-line request carries its redirections inside the line, so it
      // contributes no redirection rows: duplicating them here would claim the
      // gateway opened a file it never opened.
      const args = input.args ?? [];
      const redirections: RedirectionSpec = input.commandLine === undefined ? (input.redirections ?? {}) : {};
      const redirDetail: Array<{ slot: string; target: string; flags: string }> = [];
      if (redirections.in) redirDetail.push({ slot: "in", target: redirections.in, flags: REDIR_FLAGS.in });
      if (redirections.out) redirDetail.push({ slot: "out", target: redirections.out, flags: REDIR_FLAGS.out });
      if (redirections.append) redirDetail.push({ slot: "append", target: redirections.append, flags: REDIR_FLAGS.append });

      const firstEventId = newId("evt");
      try {
        this.sessions.createWithFirstEvent({
          id: sessionId,
          command: input.command,
          args,
          redirections,
          redirectionsDetail: redirDetail,
          timeoutMs: input.timeoutMs,
          startedAt,
          firstEvent: {
            id: firstEventId,
            sequence: 0,
            type: "execution.created",
            source: "gateway",
            timestamp: startedAt,
            payload: {
              command: input.command,
              argumentCount: args.length,
              timeoutMs: input.timeoutMs,
              // Recorded so replay can reconstruct what the user typed, not
              // just the first stage's argv. The full argv per stage arrives
              // with each process.started event.
              ...(input.commandLine === undefined ? {} : { commandLine: input.commandLine }),
            },
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("EXECUTION", "could not persist a new execution", { command: input.command, err: message });
        return { error: { code: "PERSISTENCE_FAILED", message: "The execution could not be recorded and was not started." } };
      }

      const spawned = this.spawnFor(sessionId, input, startedAt);
      if (spawned !== null) return spawned;
      return { sessionId };
    }

    return {
      error: {
        code: "CONCURRENCY_LIMIT_REACHED",
        message: `Maximum concurrent executions reached (${this.config.maxConcurrent}).`,
      },
    };
  }

  private spawnFor(
    sessionId: string,
    input: StartExecutionInput,
    startedAt: string,
  ): StartResult | null {
    const args = input.args ?? [];
    const redirections: RedirectionSpec = input.commandLine === undefined ? (input.redirections ?? {}) : {};

    /*
     * The engine's argv[0] is always this absolute, verified path, so the
     * kernel executes exactly the file the gateway probed -- never whatever a
     * PATH lookup would have found.
     */
    const capsArgv: string[] = [this.config.capsExecutable, "--monitor", "--json"];

    if (input.commandLine !== undefined) {
      /*
       * Command-line form.  The line carries its own redirections, so the
       * --redir-* flags are deliberately NOT added: passing both would apply
       * the redirection twice, and the recorded evidence would claim a file
       * the gateway never opened.
       *
       * The line is a single argv element, not a shell string.  spawn() is
       * called with shell:false, so the engine receives it verbatim and lexes
       * it itself.  No shell ever sees this string.
       */
      capsArgv.push("--run-line", input.commandLine);
    } else {
      if (redirections.in) capsArgv.push("--redir-in", redirections.in);
      if (redirections.out) capsArgv.push("--redir-out", redirections.out);
      if (redirections.append) capsArgv.push("--redir-append", redirections.append);
      capsArgv.push(input.executable!, ...args);
    }

    logger.info("EXECUTION", "spawning caps", {
      sessionId,
      command: input.command,
      form: input.commandLine === undefined ? "structured" : "command-line",
      argumentCount: args.length,
      argvBytes:
        input.commandLine === undefined
          ? Buffer.byteLength(input.executable ?? "") + args.reduce((t, a) => t + Buffer.byteLength(a), 0)
          : Buffer.byteLength(input.commandLine),
      cwd: this.config.workspace,
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
      this.failBeforeStart(sessionId, `execution could not be started: ${message}`, 1);
      return { error: { code: "SPAWN_FAILED", message } };
    }

    this.buffers.set(key("stdout", sessionId), { text: "", truncated: false });
    this.buffers.set(key("stderr", sessionId), { text: "", truncated: false });

    const active: ActiveSession = {
      sessionId,
      command: input.command,
      /*
       * The session's summary argv, used by the `/argv` endpoint for display.
       *
       * For a command-line request this records the first stage's command only.
       * The authoritative per-stage argv is NOT reconstructed here: it arrives
       * in each `process.started` event from the engine, which built it. A
       * gateway-side reconstruction would be a second, divergent answer to
       * "what argv did this process receive", which is precisely the kind of
       * duplication this product's evidence model exists to avoid.
       */
      argv: input.commandLine === undefined ? [input.command, ...args] : [input.command],
      state: "STARTING",
      process: child,
      childPid: null,
      childIdentity: null,
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
      sawExecError: false,
      sawWaitFailure: false,
      sawLaunchFailure: false,
      engineOutcome: null,
      engineReason: null,
      killTimer: null,
      escalation: null,
      stderrLineBuffer: "",
      finalized: false,
      nextSeq: 1,
    };
    this.registry.add(active);

    this.emit(gatewayEvent({ sessionId, sequence: 0, evId: newId }, "gateway", "execution.started", {
      argv: capsArgv.slice(1),
      command: input.command,
      executable: input.executable,
    }));
    // nextSeq is already correct: sequence 0 was written by the transaction
    // that created the session, and emit() above consumed sequence 1.
    active.state = "RUNNING";

    child.stderr?.on("data", (chunk: Buffer | string) => this.onStderr(active, chunk));
    child.stdout?.on("data", (chunk: Buffer | string) => this.onStdout(active, chunk));

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

    return null;
  }

  /**
   * Persist a terminal failure for an execution that never got a child, and
   * publish it.  Going through the same path as a normal finalization is what
   * keeps the event stream and the session row in agreement.
   */
  private failBeforeStart(sessionId: string, reason: string, nextSequence: number): void {
    this.sessions.finalize(sessionId, {
      status: "FAILED", exitCode: null, signal: null, isSuccess: false,
      durationMs: null, pid: null, error: reason,
    });
    const ev = gatewayEvent({ sessionId, sequence: nextSequence, evId: newId }, "gateway", "execution.failed", {
      reason,
      outcome: "LAUNCH_FAILED",
    });
    this.events.insert(ev);
    this.bus.publish(ev);
  }

  /**
   * stderr carries the monitor protocol, CAPS diagnostics, and the executed
   * program's own stderr.  Each line is classified exactly once and routed to
   * exactly one destination; nothing is appended twice, and protocol lines
   * never appear in the user's stderr.
   */
  private onStderr(active: ActiveSession, chunk: Buffer | string): void {
    active.stderrBytes += chunk.length;
    active.lastEventAt = Date.now();
    const text = chunk.toString();
    const { lines, rest } = splitLines(active.stderrLineBuffer + text);
    active.stderrLineBuffer = rest;

    for (const line of lines) this.routeStderrLine(active, line);
  }

  private routeStderrLine(active: ActiveSession, line: string): void {
    const { sessionId } = active;
    const classified = classifyLine(line);

    switch (classified.kind) {
      case "monitor-event": {
        const parsed = parseCapsLine(line);
        if (parsed.kind === "event" && parsed.event) {
          const normalized = normalizeCapsEvent(parsed.event, {
            sessionId, sequence: active.nextSeq, evId: newId, rawTs: Date.now(),
          });
          if (normalized) {
            this.emit(normalized);
            this.observe(sessionId, normalized);
            return;
          }
        }
        // A JSON object the normalizer does not recognise: keep it visible as
        // a protocol fault, not as command output.
        this.append("stderr", sessionId, line + "\n");
        return;
      }
      case "caps-diagnostic":
        this.append("stderr", sessionId, classified.text + "\n");
        return;
      case "protocol-error":
        this.append("stderr", sessionId, `[monitor protocol] ${classified.text}\n`);
        return;
      case "target-output":
        this.append("stderr", sessionId, classified.text + "\n");
        return;
    }
  }

  /** Process any partial last line so a final event or diagnostic is not lost. */
  private flushStderrTail(active: ActiveSession): void {
    const tail = active.stderrLineBuffer;
    active.stderrLineBuffer = "";
    if (tail.length === 0) return;
    this.routeStderrLine(active, tail);
  }

  private onStdout(active: ActiveSession, chunk: Buffer | string): void {
    active.stdoutBytes += chunk.length;
    active.lastEventAt = Date.now();
    // The target's stdout is copied through verbatim, including a final line
    // with no trailing newline.  Only the length is bounded.
    this.append("stdout", active.sessionId, chunk.toString());
  }

  private handleTimeout(active: ActiveSession): void {
    const { sessionId } = active;
    if (active.timedOut || active.finalized) return;
    active.timedOut = true;
    active.state = "TIMED_OUT";
    logger.warn("EXECUTION", "timeout reached", { sessionId, timeoutMs: active.timeoutMs });
    this.emit(gatewayEvent({ sessionId, sequence: 0, evId: newId }, "gateway", "execution.timeout", { timeoutMs: active.timeoutMs }));

    // SIGTERM, then a SIGKILL that is only delivered if the PID still belongs
    // to the process that was actually signalled.
    const handle = terminateGracefully(active.childPid, this.config.terminateGraceMs);
    active.childIdentity = handle.identity;
    active.escalation = handle.waitForEscalation();
  }

  /**
   * Persist one event, then publish it.
   *
   * The event row is always written before the bus is told, so a client can
   * never be handed an event that replay would not return.
   *
   * A persistence failure is caught and logged rather than thrown: this runs
   * inside a stream 'data' callback, where an escaping exception becomes an
   * unhandled rejection that takes the process down and loses the execution
   * entirely.  The sequence counter still advances, because a sequence that
   * was skipped must not later be reused -- a gap is visible in the invariant
   * report, whereas a duplicate is silent corruption.
   */
  private emit(ev: CanonicalEvent): void {
    const active = this.registry.get(ev.sessionId);
    if (active) ev.sequence = active.nextSeq++;
    try {
      this.events.insert(ev);
    } catch (err) {
      logger.error("EXECUTION", "failed to persist event", {
        sessionId: ev.sessionId,
        type: ev.type,
        sequence: ev.sequence,
        err: err instanceof Error ? err.message : String(err),
      });
      if (ev.type === "process.snapshot") return; // telemetry is best-effort
    }
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
        if (ev.pid !== null) this.sessions.setPid(sessionId, ev.pid);
        if (typeof ev.pid === "number") {
          /*
           * Capture the kernel identity NOW, at the moment the engine reports the
           * fork, rather than lazily when a signal is first sent.
           *
           * This is the safest instant to do it: the child was just created by
           * this gateway and has not been reaped, so an unreaped child keeps its
           * PID reserved and the value cannot already belong to something else.
           *
           * It also has to happen here. The identity is what makes a process
           * attributable (`capsOwned` in the host inventory) and what a delayed
           * SIGKILL is validated against. Capturing it only on the first signal
           * meant a process that was never signalled had no identity at all --
           * which is every process that simply ran to completion -- so ownership
           * was structurally unreachable and the Process Explorer could never
           * show a single CAPS-owned row.
           */
          active.childIdentity = rememberIdentity(ev.pid);
          // One sampler loop for this execution, started with an immediate
          // first sample so even a very short process is observed once.
          this.telemetry.start({
            sessionId,
            pid: ev.pid,
            capsEnginePid: active.process?.pid ?? null,
            processStartedAt: ev.timestamp,
            isFinalized: () => active.finalized,
          });
        }
        break;
      case "signal.received":
        if (typeof ev.payload.signal === "number") active.signal = ev.payload.signal;
        if (typeof ev.payload.outcome === "string") active.engineOutcome = ev.payload.outcome as EngineOutcome;
        break;
      case "process.exited": {
        if (typeof ev.payload.exitCode === "number") active.exitCode = ev.payload.exitCode;
        if (typeof ev.payload.outcome === "string") active.engineOutcome = ev.payload.outcome as EngineOutcome;
        active.processReaped = true;
        this.telemetry.stop(sessionId);
        break;
      }
      case "process.exec_error":
      case "process.wait_failed":
      case "process.launch_failed":
        if (typeof ev.payload.outcome === "string") active.engineOutcome = ev.payload.outcome as EngineOutcome;
        active.engineReason = typeof ev.payload.reason === "string" ? ev.payload.reason : null;
        if (ev.type === "process.exec_error") active.sawExecError = true;
        if (ev.type === "process.wait_failed") active.sawWaitFailure = true;
        if (ev.type === "process.launch_failed") active.sawLaunchFailure = true;
        active.processReaped = true;
        this.telemetry.stop(sessionId);
        break;
      case "session.summary":
        // Recorded, but deliberately NOT treated as evidence of success: the
        // summary only says the monitor reached the end of its input.
        active.sawSummary = true;
        break;
      default:
        break;
    }
  }

  private publishSnapshot({ sessionId, pid, snapshot }: TelemetrySample): void {
    const active = this.registry.get(sessionId);
    if (!active || active.finalized) return;
    const { identityStartTicks: _identityStartTicks, ...payload } = snapshot;
    this.emit(gatewayEvent({ sessionId, sequence: 0, evId: newId }, "gateway", "process.snapshot", payload, { pid }));
  }

  private append(channel: "stdout" | "stderr", sessionId: string, text: string): void {
    const k = key(channel, sessionId);
    const cur = this.buffers.get(k) ?? { text: "", truncated: false };
    const combined = cur.text + text;
    if (combined.length <= this.config.maxOutputBytes) {
      this.buffers.set(k, { text: combined, truncated: cur.truncated });
    } else {
      this.buffers.set(k, { text: combined.slice(-this.config.maxOutputBytes), truncated: true });
    }
  }

  /**
   * Decide the session status from the observed lifecycle.
   *
   * The single most important property here is what is *absent*: the presence
   * of a session summary.  A failed `execvp()` produces a summary, and the
   * previous implementation read that as success, reporting a nonexistent
   * program run as COMPLETED.  Status now follows the engine's own outcome
   * field, which is set only when a program actually ran.
   */
  private decideStatus(active: ActiveSession, exitCode: number | null): {
    status: SessionStatus;
    isSuccess: boolean;
    error: string | null;
  } {
    if (active.timedOut) {
      return { status: "TIMED_OUT", isSuccess: false, error: `execution timed out after ${active.timeoutMs}ms` };
    }
    if (active.terminateRequested && active.signal !== null) {
      return { status: "CANCELLED", isSuccess: false, error: `terminated by signal ${active.signal}` };
    }
    if (active.sawExecError) {
      return {
        status: "FAILED",
        isSuccess: false,
        error: `execvp() failed (${active.engineReason ?? "exec_failed"}); no program ran`,
      };
    }
    if (active.sawWaitFailure) {
      return {
        status: "FAILED",
        isSuccess: false,
        error: `waitpid() failed (${active.engineReason ?? "wait_failed"}); the process outcome is unknown`,
      };
    }
    if (active.sawLaunchFailure) {
      return {
        status: "FAILED",
        isSuccess: false,
        error: `the engine could not launch the child (${active.engineReason ?? "launch_failed"})`,
      };
    }
    if (active.engineOutcome === "SIGNALED" || active.signal !== null) {
      return { status: "FAILED", isSuccess: false, error: `terminated by signal ${active.signal ?? "?"}` };
    }
    if (active.engineOutcome === "COMPLETED") {
      return { status: "COMPLETED", isSuccess: true, error: null };
    }
    if (active.engineOutcome === "EXITED") {
      return { status: "COMPLETED", isSuccess: false, error: `exited with code ${active.exitCode ?? exitCode ?? "?"}` };
    }
    // No lifecycle verdict at all: the engine produced no process event, so
    // the outcome is genuinely unknown.  "FAILED" with an explicit reason is
    // the honest answer; inferring COMPLETED from the summary is the bug this
    // replaces.
    return {
      status: "FAILED",
      isSuccess: false,
      error: active.sawSummary
        ? "the engine closed the monitor stream without reporting a process outcome"
        : "no process lifecycle event was observed",
    };
  }

  private finalize(active: ActiveSession, code: number | null, signalCode: NodeJS.Signals | null): void {
    const { sessionId } = active;
    if (active.finalized) return;
    active.finalized = true;

    const exitCode = signalCode ? null : code;
    const durationMs = Math.max(0, Date.now() - active.monotonicStartMs);
    const { status, isSuccess, error } = this.decideStatus(active, exitCode);

    const live = this.buffers.get(key("stdout", sessionId)) ?? { text: "", truncated: false };
    const liveErr = this.buffers.get(key("stderr", sessionId)) ?? { text: "", truncated: false };
    this.buffers.delete(key("stdout", sessionId));
    this.buffers.delete(key("stderr", sessionId));

    // Sampling stops before the terminal event, so a snapshot can never follow
    // the end of the stream (invariant I7).
    this.telemetry.stop(sessionId);
    forgetIdentity(active.childPid);

    // One terminal event type per terminal session status, so the row and the
    // stream can never describe the same ending differently. A cancelled
    // execution is not a success and not a timeout, and calling it "failed"
    // would misattribute the cause to the program.
    const finalType: CanonicalEvent["type"] =
      status === "TIMED_OUT"
        ? "execution.timeout"
        : status === "CANCELLED"
          ? "execution.cancelled"
          : status === "COMPLETED"
            ? "execution.completed"
            : "execution.failed";

    const payload: Record<string, unknown> = {
      status,
      exitCode,
      signal: active.signal,
      durationMs,
      isSuccess,
      capsExitCode: code,
      capsSignal: signalCode,
      engineOutcome: active.engineOutcome,
      execError: active.sawExecError,
      waitFailure: active.sawWaitFailure,
      launchFailure: active.sawLaunchFailure,
      stdoutTruncated: live.truncated,
      stderrTruncated: liveErr.truncated,
    };
    if (error !== null) payload.reason = error;
    if (this.closing) payload.shutdown = true;

    // One transaction for the session row, its output, and the terminal event,
    // so a failure cannot leave the row and the stream disagreeing.
    const ev = gatewayEvent({ sessionId, sequence: 0, evId: newId }, "gateway", finalType, payload, {
      pid: active.childPid,
    });
    try {
      transact(this.db, () => {
        this.sessions.finalize(sessionId, {
          status, exitCode, signal: active.signal, isSuccess, durationMs,
          pid: active.childPid, error,
        });
        this.sessions.appendOutput(sessionId, live.text, liveErr.text);
        ev.sequence = active.nextSeq++;
        this.events.insert(ev);
      });
    } catch (err) {
      // A persistence failure must still leave a terminal event in the stream
      // and the execution out of the registry, or the session would hang in
      // the API forever.
      logger.error("EXECUTION", "failed to persist terminal state", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      active.nextSeq += 1;
    }

    this.bus.publish(ev);
    this.registry.delete(sessionId);
    logger.info("EXECUTION", "finalized", { sessionId, status, exitCode, signal: active.signal, durationMs, engineOutcome: active.engineOutcome });
  }

  private finalizeFailed(active: ActiveSession, reason: string): void {
    const { sessionId } = active;
    if (active.finalized) return;
    active.finalized = true;
    this.telemetry.stop(sessionId);
    forgetIdentity(active.childPid);
    this.sessions.finalize(sessionId, {
      status: "FAILED", exitCode: null, signal: null, isSuccess: false,
      durationMs: Math.max(0, Date.now() - active.monotonicStartMs), pid: active.childPid, error: reason,
    });
    this.emit(gatewayEvent({ sessionId, sequence: 0, evId: newId }, "gateway", "execution.failed", {
      reason, outcome: "LAUNCH_FAILED",
    }));
    this.registry.delete(sessionId);
  }

  /**
   * Finalize an execution the gateway is abandoning (shutdown, or boot
   * recovery of a session left in flight by a previous process).
   *
   * This is the path that keeps the database and the event stream in
   * agreement: a recovered session gets a real terminal event, so replay never
   * shows an unfinished stream for a row that says FAILED.
   */
  finalizeAbandoned(
    sessionId: string,
    reason: string,
    kind: "recovered" | "shutdown",
  ): CanonicalEvent | null {
    const existing = this.registry.get(sessionId);
    if (existing !== null && !existing.finalized) {
      this.finalizeFailed(existing, reason);
      return null;
    }
    const record = this.sessions.findById(sessionId);
    if (record === null) return null;
    if (isTerminalStatus(record.status)) return null;

    const startedAt = Date.parse(record.startedAt);
    const durationMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null;
    const ev = gatewayEvent({ sessionId, sequence: this.events.maxSequence(sessionId) + 1, evId: newId }, "gateway", "execution.failed", {
      reason,
      recovered: kind === "recovered",
      shutdown: kind === "shutdown",
      outcome: "LAUNCH_FAILED",
      durationMs,
    });
    try {
      transact(this.db, () => {
        this.sessions.finalize(sessionId, {
          status: "FAILED", exitCode: null, signal: null, isSuccess: false,
          durationMs, pid: record.pid, error: reason,
        });
        this.events.insert(ev);
      });
    } catch (err) {
      logger.error("EXECUTION", "failed to persist recovery", { sessionId, err: err instanceof Error ? err.message : String(err) });
      return null;
    }
    this.bus.publish(ev);
    return ev;
  }

  /** Live output for a running execution; persisted output once it is done. */
  outputFor(sessionId: string): OutputSnapshot | null {
    const live = this.buffers.get(key("stdout", sessionId));
    const liveErr = this.buffers.get(key("stderr", sessionId));
    if (live === undefined && liveErr === undefined) return null;
    return {
      stdout: live?.text ?? "",
      stderr: liveErr?.text ?? "",
      stdoutTruncated: live?.truncated ?? false,
      stderrTruncated: liveErr?.truncated ?? false,
      live: true,
    };
  }

  /** Terminate one execution, verifying identity before escalating. */
  requestTerminate(sessionId: string, signal: NodeJS.Signals): { sent: boolean; reason: string | null; identity: ProcessIdentity | null } {
    const active = this.registry.get(sessionId);
    if (!active) return { sent: false, reason: "execution is not running", identity: null };
    const result = signalChild(active.childPid, signal);
    if (result.sent) {
      active.terminateRequested = true;
      active.childIdentity = result.identity;
      // A terminate request is also escalated, with the same identity guard,
      // so a process that ignores the requested signal cannot linger.
      active.escalation = terminateGracefully(active.childPid, this.config.terminateGraceMs).waitForEscalation();
    }
    return result;
  }

  /** Await any pending escalation for a session, if there is one. */
  async awaitEscalation(sessionId: string): Promise<void> {
    const active = this.registry.get(sessionId);
    if (active?.escalation) await active.escalation;
  }

  /**
   * Direct, identity-checked kill used only by the shutdown sequence.
   *
   * Async because a pidfd-bound escalation forks a helper; the caller is
   * already on a shutdown path where one turn of latency is irrelevant, and
   * making this synchronous would mean either blocking the event loop on a
   * fork or dropping the pidfd guarantee.
   */
  killVerified(pid: number | null, identity: ProcessIdentity | null): Promise<void> {
    if (pid === null) return Promise.resolve();
    return escalateTo(identity, "SIGKILL").then((outcome) => {
      if (!outcome.sent) {
        logger.info("EXECUTION", "shutdown kill declined", { pid, reason: outcome.reason });
      }
    });
  }
}
