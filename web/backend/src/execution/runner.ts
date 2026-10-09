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
import { escalateTo, forgetIdentity, rememberIdentity, signalChild, signalProcessGroup, terminateGracefully, type ProcessIdentity } from "./terminator.js";
import {
  evaluateThermalGuard,
  logThermalDecision,
  type ThermalDecisionRecord,
} from "./thermalGuard.js";

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
/**
 * The environment the CAPS engine is given.
 *
 * MINIMAL BY DEFAULT. A child inherits nothing from the gateway except these
 * four variables, so an operator's own environment cannot reach the program
 * being observed.
 *
 * THE LIMITS ARE THE EXCEPTION, AND THEY ARE ADDED HERE DELIBERATELY.
 * ------------------------------------------------------------
 * `CAPS_LIMIT_ADDRESS_SPACE_BYTES` and `CAPS_LIMIT_CPU_SECONDS` are the names the
 * C engine reads (src/limits.c) and applies to every pipeline stage before
 * execvp(). They are the only way RLIMIT_AS or RLIMIT_CPU can ever be in force
 * in a child, so omitting them here made both guardrails decorative: the
 * operator set a limit, `/api/capabilities` reported `enforced: true`, and the
 * kernel applied nothing.
 *
 * They are absent unless configured, because the engine treats an absent limit
 * as unlimited and a malformed one as a refusal. That is the correct behaviour,
 * so an unset gateway setting must stay unset all the way down.
 *
 * Note the unit conversion on the CPU budget: the operator configures
 * milliseconds because that is the resolution the gateway's own wall-clock
 * accounting uses, while RLIMIT_CPU is whole seconds. The ceiling rounds UP, so
 * the kernel can only ever be given a limit at least as generous as the one
 * asked for -- rounding down would silently enforce a tighter limit than the
 * configuration states.
 */
function sanitizedEnv(config: CapsConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "HOME", "TERM"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.LANG ??= "C.UTF-8";
  env.TERM ??= "dumb";

  if (config.guardrails.addressSpaceBytes > 0) {
    env.CAPS_LIMIT_ADDRESS_SPACE_BYTES = String(config.guardrails.addressSpaceBytes);
  }
  if (config.guardrails.cpuBudgetMs > 0) {
    env.CAPS_LIMIT_CPU_SECONDS = String(Math.ceil(config.guardrails.cpuBudgetMs / 1000));
  }
  return env;
}

function key(channel: "stdout" | "stderr", sessionId: string): string {
  return `${channel}:${sessionId}`;
}

/**
 * Longest unterminated stderr line retained while waiting for its newline.
 *
 * Sized well above any real diagnostic and well below the output cap, so a
 * program that legitimately writes a long single line is still recorded whole,
 * while an unbounded writer is cut off rather than allowed to grow the heap.
 */
const MAX_PENDING_LINE = 64 * 1024;

/**
 * The serialisable form of one admission decision.
 *
 * Only fields a reader can check are carried.  The sensor path and the raw
 * millidegree value are included precisely so the decision can be re-verified
 * against sysfs by hand: a guard that publishes "the temperature was high"
 * without saying where it read it is asking to be believed.
 *
 * When the guard could not read a sensor, `celsius` and `rawMilliCelsius` are
 * null and `provenance` is UNAVAILABLE.  No field is ever defaulted to a number
 * that was not measured.
 */
function thermalGuardPayload(record: ThermalDecisionRecord): Record<string, unknown> {
  return {
    decision: record.decision,
    action: record.action,
    enabled: record.decision !== "DISABLED",
    threshold: record.threshold === null ? null : record.threshold.kind,
    thresholdCelsius: record.threshold === null ? null : record.threshold.celsius,
    sensor: record.sensor === null ? null : record.sensor.name,
    sensorPath: record.sensor === null ? null : record.sensor.path,
    sensorSourceClass: record.sensor === null ? null : record.sensor.sourceClass,
    sensorIsPackage: record.sensor === null ? null : record.sensor.isPackage,
    celsius: record.reading.celsius,
    rawMilliCelsius: record.reading.rawMilliCelsius,
    readingProvenance: record.reading.provenance,
    readingSource: record.reading.source,
    result: record.result,
    reason: record.reason,
    decidedAt: record.timestamp,
  };
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

      /*
       * Thermal admission, before anything is persisted and long before
       * anything is spawned.
       *
       * The guard module existed but nothing on the execution path called it, so
       * `CAPS_THERMAL_GUARD_ENABLED=true` was documented behaviour that never
       * happened: no sensor was read, no threshold evaluated, no workload
       * refused, and the API reported the guard's configuration as if it were in
       * force. Configuration that is displayed but not enforced is worse than
       * configuration that is absent, because it is believed.
       *
       * Scope is unchanged and is enforced here rather than in the module:
       *   - the decision is about a CAPS-owned workload, and nothing else. No
       *     host process is inspected, signalled, or protected.
       *   - the guard reads sysfs and never writes it: no trip point, no fan
       *     curve, no MSR.
       *   - a host with no sensor yields UNAVAILABLE_ALLOW. The workload runs
       *     and the record says the admission carries NO thermal justification.
       *     That is the opposite of inventing a temperature.
       *   - WARN admits and records a warning. TERM and TERM_THEN_KILL refuse to
       *     start, which at admission is the whole action available: there is no
       *     process yet to escalate against.
       *
       * The decision is recorded whether it allowed or refused, so "why did this
       * workload start?" and "why was this workload refused?" are both answerable
       * from the event stream, replay, and the database.
       */
      const guard = evaluateThermalGuard({
        config: this.config.thermalGuard,
        target: { sessionId },
      });
      logThermalDecision(guard);
      const guardPayload = thermalGuardPayload(guard);

      if (guard.decision === "REFUSE_TERM" || guard.decision === "REFUSE_KILL") {
        return this.refuseForThermal(sessionId, input, startedAt, guard, guardPayload);
      }

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
              thermalGuard: guardPayload,
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

  /**
   * Persist and publish a workload the thermal guard refused to admit.
   *
   * A refusal that leaves no trace is indistinguishable from a request that was
   * never made, so the refused execution is given the same durable shape a
   * started one has: a session row, an `execution.created` event carrying the
   * decision, and a terminal `execution.failed` event naming the threshold. It
   * appears in history, in replay, and over SSE, and it never spawns a process.
   */
  private refuseForThermal(
    sessionId: string,
    input: StartExecutionInput,
    startedAt: string,
    record: ThermalDecisionRecord,
    guardPayload: Record<string, unknown>,
  ): StartResult {
    const args = input.args ?? [];
    try {
      this.sessions.createWithFirstEvent({
        id: sessionId,
        command: input.command,
        args,
        redirections: {},
        redirectionsDetail: [],
        timeoutMs: input.timeoutMs,
        startedAt,
        firstEvent: {
          id: newId("evt"),
          sequence: 0,
          type: "execution.created",
          source: "gateway",
          timestamp: startedAt,
          payload: {
            command: input.command,
            argumentCount: args.length,
            timeoutMs: input.timeoutMs,
            thermalGuard: guardPayload,
            ...(input.commandLine === undefined ? {} : { commandLine: input.commandLine }),
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("EXECUTION", "could not record a thermally refused execution", { command: input.command, err: message });
      return { error: { code: "PERSISTENCE_FAILED", message: "The refusal could not be recorded and no workload was started." } };
    }

    this.failBeforeStart(sessionId, record.reason, 1, {
      outcome: "LAUNCH_FAILED",
      refusedBy: "thermal-guard",
      thermalGuard: guardPayload,
    });

    return {
      error: {
        code: "THERMAL_REFUSED",
        message: `This workload was refused by the thermal guard and was not started. ${record.reason}`,
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
        env: sanitizedEnv(this.config),
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
      // The pipeline's process group and its leader's identity, both taken from
      // the engine's observed records. Null until a `process.started` carries
      // them; the single-PID path remains available until then.
      childPgid: null,
      childGroupLeader: null,
      ownedIdentities: [],
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
 *
 * `extra` carries whatever a caller needs a reader to be able to act on.  A
 * thermal refusal, for instance, is only auditable if the terminal event names
 * the sensor and the threshold: "it failed" with no sensor attached is not a
 * fact anyone can check against the kernel.
 */
private failBeforeStart(
    sessionId: string,
    reason: string,
    nextSequence: number,
    extra: Record<string, unknown> = {},
  ): void {
    this.sessions.finalize(sessionId, {
      status: "FAILED", exitCode: null, signal: null, isSuccess: false,
      durationMs: null, pid: null, error: reason,
    });
    const ev = gatewayEvent({ sessionId, sequence: nextSequence, evId: newId }, "gateway", "execution.failed", {
      reason,
      outcome: "LAUNCH_FAILED",
      ...extra,
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

    /*
     * The partial line is bounded.
     *
     * The retained output channels are capped, but this buffer is not output --
     * it is an unterminated line waiting for its newline -- and it was
     * accumulated without a bound. A program that writes one enormous line with
     * no `\n` therefore grew the gateway's heap without limit, which is the exact
     * failure the stderr guardrail exists to prevent, on the one path that
     * bypassed it.
     *
     * When the cap is exceeded the fragment is emitted as truncated output and
     * the buffer restarts. Dropping the excess is honest here in a way it is not
     * for a metric: the record says the line was truncated, and a line this long
     * is not a human-readable diagnostic in any case.
     */
    if (rest.length > MAX_PENDING_LINE) {
      this.append(
        "stderr",
        active.sessionId,
        `${rest.slice(0, MAX_PENDING_LINE)}\n[truncated: an unterminated line exceeded ${MAX_PENDING_LINE} characters]\n`,
      );
      active.stderrLineBuffer = "";
    } else {
      active.stderrLineBuffer = rest;
    }

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

  /**
 * Signal an execution, preferring the whole pipeline over one PID.
 *
 * The group is preferred because the engine puts every stage in it and because
 * signalling only the LAST stage -- which is what `active.childPid` holds for a
 * multi-stage pipeline, since `observe` overwrites it on every
 * `process.started` -- leaves earlier stages running while the session is
 * finalised as terminated. terminateGracefully makes that choice and reports
 * which mechanism actually ran, so the audit record says "kill-group" or "kill"
 * rather than a bare "terminated".
 */
  private terminateActive(active: ActiveSession, signal: NodeJS.Signals): ReturnType<typeof terminateGracefully> {
    return terminateGracefully(active.childPid, this.config.terminateGraceMs, {
      signal,
      group: { pgid: active.childPgid, leader: active.childGroupLeader },
    });
  }

  private handleTimeout(active: ActiveSession): void {
    const { sessionId } = active;
    if (active.timedOut || active.finalized) return;
    active.timedOut = true;
    active.state = "TIMED_OUT";
    logger.warn("EXECUTION", "timeout reached", { sessionId, timeoutMs: active.timeoutMs });

    /*
     * No event is emitted here, and that used to be a defect worth reading.
     *
     * `execution.timeout` is a TERMINAL event type, and this used to emit one.
     * The session was not finalized, so finalize() emitted the same terminal type
     * again. On every timeout that produced three real problems, two of which
     * the product reports about itself:
     *
     *   1. invariant I5 (one terminal event) was violated;
     *   2. invariant I6 (terminal event is last) was violated, because the
     *      sampler kept running and wrote process.snapshot events after it;
     *   3. the live SSE stream closed on the FIRST terminal event, so a
     *      subscriber never received process.exited, the escalation, or the real
     *      terminal event -- and a reconnecting subscriber replaying the backlog
     *      hit `if (stream.isClosed) break;` and got the same truncated history.
     *
     * The /replay integrity block was reporting violations of the product's own
     * rules, on every timed-out session, with no test failing: the one test on
     * this path asserted only the session status.
     *
     * The timeout is therefore recorded once, by finalize(), as the single
     * terminal event it is. The log line above still marks the moment the timer
     * fired, which is what an operator watching the console needs; the event
     * stream is not a place to announce something twice.
     */

    // SIGTERM, then a SIGKILL that is only delivered if the PID still belongs
    // to the process that was actually signalled. The pipeline's process group is
    // preferred, so every stage is reached rather than only the last one observed.
    const handle = this.terminateActive(active, "SIGTERM");
    active.childIdentity = handle.identity ?? active.childIdentity;
    active.escalation = handle.waitForEscalation();
    logger.warn("EXECUTION", "timeout signal delivered", {
      sessionId,
      mechanism: handle.first.mechanism,
      pgid: active.childPgid,
    });
  }

  /**
   * Persist one event, then publish it.
   *
   * The event row is always written before the bus is told, so a client can
   * never be handed an event that replay would not return. That is the whole
   * contract, and it used to be honoured for telemetry alone: only
   * `process.snapshot` returned early on a persistence failure, so every other
   * event type -- including `process.exited` and every terminal event -- could
   * be pushed to a live subscriber and never appear in /replay. A client that
   * reconnected would then see the event twice in its lifetime, having recorded
   * it once.
   *
   * A persistence failure is caught and logged rather than thrown: this runs
   * inside a stream 'data' callback, where an escaping exception becomes an
   * unhandled rejection that takes the process down and loses the execution
   * entirely. The sequence counter still advances, because a sequence that was
   * skipped must not later be reused -- a gap is visible in the invariant
   * report, whereas a duplicate is silent corruption.
   *
   * So the trade is now uniform and deliberate: an event that could not be
   * persisted is not published. Live delivery is allowed to lose a row; replay
   * completeness is not allowed to lie about one. Telemetry is treated exactly
   * like every other event rather than being the exception, because an
   * inconsistent rule here is how the original bug happened.
   */
  private emit(ev: CanonicalEvent): void {
    const active = this.registry.get(ev.sessionId);
    if (active) ev.sequence = active.nextSeq++;
    try {
      this.events.insert(ev);
    } catch (err) {
      logger.error("EXECUTION", "failed to persist event; not publishing it", {
        sessionId: ev.sessionId,
        type: ev.type,
        sequence: ev.sequence,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
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
        /*
         * The pipeline's process group, taken from the engine's own record of
         * it rather than assumed. Stage 0 is the group leader, so the first
         * `process.started` to arrive carries the pgid the gateway must be able
         * to signal as a unit; later stages report the same value, so this
         * assignment is idempotent rather than last-writer-wins.
         *
         * This is what makes a timeout reach every stage instead of only the
         * last one -- see signalProcessGroup for the verification that makes
         * signalling a negative pid safe here.
         */
        const observedPgid = typeof ev.payload.pgid === "number" ? ev.payload.pgid : null;
        if (observedPgid !== null && observedPgid > 1) {
          active.childPgid = observedPgid;
          // The leader's identity is captured here for the same reason the PID's
          // is: it must be recorded while the process provably cannot be recycled.
          if (active.childGroupLeader === null && ev.pid === observedPgid) {
            active.childGroupLeader = rememberIdentity(ev.pid);
          }
        }
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
          /*
           * Ownership is per PROCESS, not per session. A pipeline reports one
           * `process.started` per stage, and `childIdentity` above is
           * overwritten by each one, so without this list every stage except the
           * last would be reported as host work by the Process Explorer while
           * CAPS held a verified identity for it.
           */
          const identity = active.childIdentity;
          if (identity !== null && !active.ownedIdentities.some((i) => i.pid === identity.pid)) {
            active.ownedIdentities.push(identity);
          }
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

  /**
   * Retain one output channel, bounded, and record that it was truncated.
   *
   * The two channels are bounded SEPARATELY, which is what `/api/capabilities`
   * claims and what the deadlock argument in that claim actually requires: a
   * program writing megabytes of stderr while its stdout pipe fills would
   * otherwise wedge on a stream the gateway had silently discarded. Sharing one
   * cap across both channels would make a loud stderr consume the stdout budget,
   * so the caps are looked up per channel.
   *
   * The bound is on what the gateway RETAINS, not on what the child produces.
   * The child is never stopped for writing too much, and this does not claim to
   * be: the gateway drains both pipes continuously, so a chatty program cannot
   * block on a full pipe and cannot deadlock. What is bounded is memory.
   *
   * Truncation keeps the TAIL. For a terminal view the last thing a program said
   * is the useful part, and it is the part that explains a failure.
   */
  private append(channel: "stdout" | "stderr", sessionId: string, text: string): void {
    const k = key(channel, sessionId);
    const cur = this.buffers.get(k) ?? { text: "", truncated: false };
    const limit = this.outputCapFor(channel);
    const combined = cur.text + text;
    if (combined.length <= limit) {
      this.buffers.set(k, { text: combined, truncated: cur.truncated });
    } else {
      this.buffers.set(k, { text: combined.slice(-limit), truncated: true });
    }
  }

  /** The retention cap for one channel: stderr has its own, stdout the global one. */
  private outputCapFor(channel: "stdout" | "stderr"): number {
    return channel === "stderr"
      ? this.config.guardrails.stderrBytes
      : this.config.guardrails.stdoutBytes;
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
      return { status: "FAILED", isSuccess: false, error: `exited with code ${active.exitCode ?? exitCode ?? "?"}` };
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
    let persisted = false;
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
      persisted = true;
    } catch (err) {
      // A persistence failure must still leave the session out of the registry,
      // or it would hang in the API forever. It must NOT, however, publish the
      // terminal event: that would hand a live subscriber an event that replay
      // will never return, which is the same live-versus-replay divergence
      // emit() was corrected to avoid. The sequence advances either way, so a
      // later event cannot reuse the number.
      logger.error("EXECUTION", "failed to persist terminal state", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      active.nextSeq += 1;
    }

    // Published only when it is durable, for the same reason emit() gates on it.
    if (persisted) this.bus.publish(ev);
    this.registry.delete(sessionId);
    logger.info("EXECUTION", "finalized", { sessionId, status, exitCode, signal: active.signal, durationMs, engineOutcome: active.engineOutcome, terminalEventPersisted: persisted });
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
  requestTerminate(
    sessionId: string,
    signal: NodeJS.Signals,
  ): { sent: boolean; reason: string | null; identity: ProcessIdentity | null; mechanism: string } {
    const active = this.registry.get(sessionId);
    if (!active) {
      return { sent: false, reason: "execution is not running", identity: null, mechanism: "none" };
    }
    const result = this.terminateActive(active, signal);
    if (result.first.sent) {
      active.terminateRequested = true;
      active.childIdentity = result.identity ?? active.childIdentity;
      // A terminate request is also escalated, with the same identity guard,
      // so a process that ignores the requested signal cannot linger.
      active.escalation = result.waitForEscalation();
    }
    return { ...result.first, identity: result.identity };
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
