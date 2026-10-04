import { accessSync, constants, existsSync, statSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { relative } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { CapsConfig } from "../config/env.js";
import { isInsideRepo, repoRoot } from "../config/env.js";
import type { EventRepository } from "../db/repositories/events.js";
import type { SessionRepository } from "../db/repositories/sessions.js";
import { EventBus } from "../events/bus.js";
import { describeValidation, validateEventStream } from "../events/invariants.js";
import type { ExecutionRunner } from "../execution/runner.js";
import { isTerminalState, type ExecutionRegistry } from "../execution/registry.js";
import { computeAnalytics, compareSessions, computeCommandProfiles, computeRuntimePeaks } from "../analytics/service.js";
import {
  allowedCommands,
  assertReadableFileInWorkspace,
  assertTargetInWorkspace,
  RedirectionPolicyError,
  resolveAllowedExecutable,
  validateArgVector,
} from "../security/policy.js";
import { ArgumentError, validateArguments } from "../catalog/validation.js";
import { isTerminalEventType, type CanonicalEvent } from "../types/observability.js";
import { telemetryCapabilities } from "../telemetry/capabilities.js";
import { inspectThermalGuard } from "../execution/thermalGuard.js";
import { pidfdCapability } from "../execution/pidfd.js";
import {
  isWorkloadId,
  materializeWorkloadArgv,
  WORKLOAD_LIMITS,
  WorkloadArgumentError,
  workloadCapabilities,
} from "../execution/workloadCatalog.js";
import { logger } from "../utils/logger.js";
import { newId } from "../utils/ids.js";
import { readLastEventId, SseStream, sendSessionEnd } from "../events/sse.js";
import { playgroundExamples } from "./playground.js";

export interface ApiDeps {
  config: CapsConfig;
  sessions: SessionRepository;
  events: EventRepository;
  bus: EventBus;
  runner: ExecutionRunner;
  registry: ExecutionRegistry;
  version: string;
  /** Test seam: true after the database has been opened successfully. */
  databaseHealthy: () => boolean;
}

function csvField(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, requestId?: string): void {
  reply.code(status).send({ error: { code, message, requestId } });
}

const requestId = (req: FastifyRequest): string => {
  const raw = req.headers["x-request-id"];
  if (typeof raw === "string" && raw.length > 0 && raw.length <= 128) return raw;
  return `req_${newId("req")}`;
};

/** Session ids are opaque, but they are still bounded and shaped. */
const SESSION_ID = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const ID_PARAMS = z.object({ id: SESSION_ID });

/**
 * Shared query-parameter validation.
 *
 * Every externally supplied value gets a shape, a size limit, and a semantic
 * check.  `limit` and `offset` are additionally clamped so a single request
 * cannot force an unbounded scan, and `status` must be a status the system can
 * actually produce, so a typo does not silently return "no results".
 */
const PAGINATION = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const SESSION_STATUS_VALUES = ["CREATED", "STARTING", "RUNNING", "COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED", "ALL"] as const;
const SESSION_LIST_QUERY = PAGINATION.extend({
  status: z.enum(SESSION_STATUS_VALUES).optional(),
  q: z.string().min(1).max(128).optional(),
});

/** A redirection target must be present and non-blank when the field is given. */
const REDIRECTION_TARGET = z.string().min(1).max(255).refine((v) => v.trim().length > 0, {
  message: "must not be empty or whitespace-only",
});

const EXECUTION_SCHEMA = z
  .object({
    command: z.string().min(1).max(256),
    args: z.array(z.string().max(4096)).max(512).default([]),
    redirections: z
      .object({
        in: REDIRECTION_TARGET.optional(),
        out: REDIRECTION_TARGET.optional(),
        append: REDIRECTION_TARGET.optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(1000).optional(),
  })
  .strict();

const TERMINATE_SCHEMA = z.object({
  signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL", "SIGQUIT", "SIGTSTP"]).default("SIGINT"),
});

const EXPORT_FORMAT = z.enum(["json", "csv"]);

export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { config, sessions, events, bus, runner, registry, version } = deps;

  /**
   * Readiness, not liveness.
   *
   * `/api/health` reports that the process is running.  `/api/ready` reports
   * whether it can actually do its job, and returns 503 when a critical
   * dependency is unavailable.  The previous single endpoint returned
   * `status: "ok"` with a literal `database: { available: true }`, so a
   * gateway that could not open its database still looked healthy.
   */
  const engineProbe = (): { available: boolean; path: string; relativePath: string } => {
    let available = false;
    try {
      accessSync(config.capsExecutable, constants.X_OK);
      available = statSync(config.capsExecutable).isFile();
    } catch {
      available = false;
    }
    return {
      available,
      path: config.capsExecutable,
      // Absolute paths are not needed by a UI and are not something a
      // capability response should hand out by default.
      relativePath: isInsideRepo(config.capsExecutable)
        ? relative(repoRoot, config.capsExecutable)
        : "(outside repository)",
    };
  };

  const workspaceProbe = (): { available: boolean; relativePath: string } => {
    let available = false;
    try {
      available = statSync(config.workspace).isDirectory();
    } catch {
      available = false;
    }
    return {
      available,
      relativePath: isInsideRepo(config.workspace) ? relative(repoRoot, config.workspace) : "(outside repository)",
    };
  };

  app.get("/api/health", async () => {
    const engine = engineProbe();
    return {
      status: "ok",
      version,
      platform: platform() === "linux" ? "linux/posix" : platform(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  app.get("/api/ready", async (_req, reply) => {
    const engine = engineProbe();
    const workspace = workspaceProbe();
    const database = deps.databaseHealthy();
    const telemetrySupported = platform() === "linux";

    const checks = {
      engine: { available: engine.available, detail: engine.available ? "caps engine is executable" : "caps engine is missing or not executable (run: make)" },
      database: { available: database, detail: database ? "event store is open" : "event store is unavailable" },
      workspace: { available: workspace.available, detail: workspace.available ? "workspace is writable" : "workspace is missing (run: make web-backend or set CAPS_WORKSPACE)" },
      telemetry: { available: telemetrySupported, detail: telemetrySupported ? "procfs sampling is available" : "procfs telemetry is only available on Linux" },
    };
    const ready = Object.values(checks).every((c) => c.available);

    const storage = database ? sessions.storageStats() : null;
    const payload = {
      ready,
      version,
      checks,
      retention: {
        days: config.retentionDays,
        enabled: config.retentionDays > 0,
        policy: config.retentionDays > 0 ? `sessions older than ${config.retentionDays} day(s) are deleted` : "disabled: every session is kept",
      },
      storage,
    };
    return reply.code(ready ? 200 : 503).send(payload);
  });

  // ---------------------------------------------------------- capabilities
  app.get("/api/capabilities", async () => {
    const engine = engineProbe();
    const workspace = workspaceProbe();
    const onLinux = platform() === "linux";
    // Async because the process-identity half of the capability answer is a real
    // pidfd probe, not a static declaration. Publishing "VERIFIED" without
    // measuring would make the strongest claim in the API an unverified one.
    const telemetry = await telemetryCapabilities({
      enabled: onLinux,
      source: onLinux ? "/proc/<tracked-pid>/{stat,status,io}" : "UNAVAILABLE",
    });
    const identity = await pidfdCapability();
    return {
      version,
      platform: onLinux ? "linux/posix" : platform(),
      engineAvailable: engine.available,
      enginePath: engine.relativePath,
      allowlist: allowedCommands(),
      limits: {
        maxConcurrent: config.maxConcurrent,
        defaultTimeoutMs: config.defaultTimeoutMs,
        maxTimeoutMs: config.maxTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
      },
      /*
       * Guardrails, published as three separable things per limit:
       * `configured` is what was set, `enforced` says whether the gateway can
       * actually apply it, and the two are allowed to disagree.
       *
       * A limit that is configured but not enforced is the failure this
       * structure exists to make visible. Reporting a flat number invites the
       * reader to assume enforcement, and an unenforced limit that looks
       * enforced is worse than no limit at all.
       */
      guardrails: {
        wallTime: {
          configuredBytesOrMs: config.guardrails.wallTimeMs,
          unit: "ms",
          enforced: true,
          mechanism: "the engine's own timeout; the gateway escalates with an identity-verified SIGKILL",
        },
        wallTimeCeiling: { configuredBytesOrMs: config.guardrails.maxWallTimeMs, unit: "ms", enforced: true },
        stdout: {
          configuredBytesOrMs: config.guardrails.stdoutBytes,
          unit: "bytes",
          enforced: true,
          mechanism: "the engine stops the child when a stream exceeds the cap and records the truncation",
        },
        stderr: {
          configuredBytesOrMs: config.guardrails.stderrBytes,
          unit: "bytes",
          enforced: true,
          mechanism:
            "stderr is bounded separately from stdout; an unbounded stderr fills its pipe and would deadlock a child that is otherwise healthy",
        },
        cpuTime: {
          configuredBytesOrMs: config.guardrails.cpuBudgetMs,
          unit: "ms of kernel-reported CPU time",
          enforced: config.guardrails.cpuBudgetMs > 0,
          mechanism:
            config.guardrails.cpuBudgetMs > 0
              ? "compared against the kernel's own accounting after each wait; a process that exhausts its CPU budget is terminated"
              : "not configured; CPU time is observed and recorded but not limited",
          caveat: "This is CPU time, not wall-clock time. A process sleeping on I/O consumes none.",
        },
        addressSpace: {
          configuredBytesOrMs: config.guardrails.addressSpaceBytes,
          unit: "bytes of virtual address space (RLIMIT_AS)",
          enforced: config.guardrails.addressSpaceBytes > 0,
          mechanism:
            config.guardrails.addressSpaceBytes > 0
              ? "RLIMIT_AS applied to the child before exec"
              : "not configured",
          caveat:
            "RLIMIT_AS caps VIRTUAL ADDRESS SPACE, not physical memory. It bears no simple relation to RSS or to the machine's RAM: a modest limit can be exhausted by mappings that never touch a page, and a generous one says nothing about resident memory. It is reported as address space everywhere in CAPS for this reason.",
        },
        concurrency: {
          configuredBytesOrMs: config.guardrails.maxConcurrent,
          unit: "simultaneous executions",
          enforced: true,
          mechanism: "a request beyond the limit is refused with 503 rather than queued indefinitely",
        },
        thermal: await (async () => {
          const guard = inspectThermalGuard(config.thermalGuard);
          return {
            enabled: config.thermalGuard.enabled,
            availability: guard.availability,
            reason: guard.unavailableReason ?? guard.selected?.selectionReason ?? "not inspected",
            sensor: guard.selected?.name ?? null,
            sensorPath: guard.selected?.path ?? null,
            warningC: config.thermalGuard.warningC,
            criticalC: config.thermalGuard.criticalC,
            action: config.thermalGuard.action,
            scope: "CAPS-owned workloads only; never an unrelated host process",
            restrictions: [
              "no writes to /sys/class/thermal",
              "no writes to /sys/class/hwmon",
              "no MSR access",
              "no fan control",
              "no temperature synthesis when no sensor exists",
            ],
          };
        })(),
      },
      workspace: workspace.relativePath,
      workspaceAvailable: workspace.available,
      security: {
        bindMode: config.bindMode,
        loopbackOnly: config.bindMode === "local",
        authentication: config.authToken === null ? "none (loopback only)" : "bearer token required",
        executableResolution: "absolute verified path; PATH is never consulted for an allowlisted command",
        redirectionHardening: "O_NOFOLLOW plus a regular-file check at open time",
      },
      /*
       * Stderr redirection is reported per route, not as one global flag.
       *
       * It used to publish `stderr: false`, which was true of
       * /api/sessions -- whose request schema accepts only in/out/append -- and
       * false in general: the terminal grammar accepts `2>` and `2>>`, the engine
       * implements them (CAPS_REDIR_ERR_OUT / _APPEND, opened O_WRONLY|O_CREAT
       * with O_NOFOLLOW), and the target is validated against the workspace
       * policy. A single flag cannot describe that, and a reader who trusted it
       * would conclude the capability is absent from the product.
       */
      redirection: {
        supported: true,
        modes: ["in", "out", "append"],
        stderr: true,
        stderrByRoute: {
          "/api/sessions": false,
          "/api/terminal/execute": true,
        },
        stderrNote:
          "stderr redirection is a terminal-route feature. POST /api/sessions accepts only in/out/append and rejects a stderr slot with 400. Both routes validate the target against the workspace policy and the engine opens it with O_NOFOLLOW.",
      },
      signals: { supported: ["SIGINT", "SIGTERM", "SIGKILL", "SIGQUIT", "SIGTSTP"], identityVerified: true },
      workloads: {
        count: workloadCapabilities().length,
        available: workloadCapabilities().filter((w) => w.available).length,
        profiles: workloadCapabilities(),
        limits: WORKLOAD_LIMITS,
      },
      telemetry,
      /*
       * Process identity, from the real probe rather than from a declaration.
       *
       * This is the answer to "what does a signal sent by CAPS actually
       * guarantee?", and the guarantee is different depending on whether pidfd is
       * available. Publishing a fixed "VERIFIED" would make the strongest claim
       * in the API an unmeasured one on exactly the hosts where it is weakest.
       */
      processIdentity: {
        model: identity.available
          ? "pidfd: a kernel handle bound to one specific process"
          : identity.confidence === "UNVERIFIED"
            ? "start-ticks validation against /proc/<pid>/stat"
            : "unavailable: CAPS will not signal a process whose identity it cannot establish",
        confidence: identity.confidence,
        reason: identity.reason,
        kernel: identity.kernel,
        terminationMechanism: identity.available ? "pidfd" : identity.confidence === "UNVERIFIED" ? "start-ticks" : "unavailable",
        invariant:
          "CAPS signals only processes it started, and only after checking that the kernel still reports the identity it recorded at spawn. A PID on its own is never sufficient, because PIDs are reused.",
      },
      observability: {
        timeline: { enabled: true, axis: "seconds-relative-to-first-event" },
        annotations: true,
        peaks: true,
        replaySync: true,
        sequenceIntegrity: true,
        export: { formats: ["json", "csv"] },
        report: true,
        comparison: true,
        commandProfiles: true,
      },
      bind: { mode: config.bindMode, host: config.host, port: config.port },
    };
  });

  // ------------------------------------------------------------- sessions
  app.post("/api/sessions", async (req, reply) => {
    const rid = requestId(req);
    const parsed = EXECUTION_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendError(
        reply, 400, "INVALID_ARGUMENT",
        "Invalid execution request: " + parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "),
        rid,
      );
    }
    const body = parsed.data;
    const timeoutMs = Math.min(body.timeoutMs ?? config.defaultTimeoutMs, config.maxTimeoutMs);

    try {
      validateArgVector(body.command, body.args);
    } catch (err) {
      return sendError(reply, 400, "INVALID_ARGUMENT", err instanceof Error ? err.message : "invalid argument vector", rid);
    }

    // Resolve to a verified absolute path BEFORE anything is persisted or
    // spawned.  A name that cannot be resolved is not a command, and the
    // session must not be created for it.
    const resolved = resolveAllowedExecutable(body.command);
    if (!resolved.ok) {
      const known = allowedCommands().includes(body.command);
      return sendError(
        reply,
        known ? 503 : 403,
        known ? "COMMAND_UNAVAILABLE" : "COMMAND_NOT_ALLOWED",
        known
          ? `Command "${body.command}" is allowlisted but unavailable: ${resolved.reason}.`
          : `Command "${body.command}" is not on the allowlist.`,
        rid,
      );
    }

    let args = body.args;
    if (isWorkloadId(body.command)) {
      try {
        args = materializeWorkloadArgv(body.command, body.args);
      } catch (err) {
        if (err instanceof WorkloadArgumentError) {
          return sendError(reply, 400, err.code, err.message, rid);
        }
        return sendError(reply, 400, "WORKLOAD_ARGUMENT_REJECTED", "Workload arguments rejected.", rid);
      }
      // A workload owns its own runtime budget; the transport timeout must
      // not be shorter than the budget or the sample series would be cut
      // off before the workload ends on its own.
      const budgetS = Number.parseInt(args[0] ?? "10", 10);
      const required = budgetS * 1000 + 2000;
      if (timeoutMs < required) {
        return sendError(reply, 400, "TIMEOUT_TOO_SHORT", `timeoutMs must be at least ${required} for a ${budgetS}s workload (budget plus cleanup margin).`, rid);
      }
    }

    /*
     * The catalog already declares, per command, which positional arguments are
     * paths and how many leading positionals are patterns rather than paths.
     *
     * This route used to special-case `cat` and hand-check its arguments, which
     * left the other thirteen path-taking commands -- head, tail, wc, stat,
     * file, grep, sort, uniq, cut, sed, awk, du, ls -- completely unchecked on
     * the primary execution route. `grep root /etc/passwd` returned the matching
     * line. Nothing enforced the per-command argument schemas published at
     * /api/catalog either.
     *
     * So the schema is enforced here, from the same registry the catalog is
     * generated from. One validator, both routes: a rule that exists only on
     * /api/terminal/* is a rule the flagship execution path does not have.
     */
    /*
     * The per-command argument schema and the workspace path policy, from the
     * same registry the catalog is generated from.
     *
     * This route used to special-case `cat` and hand-check its arguments, which
     * left the other thirteen path-taking commands -- head, tail, wc, stat,
     * file, grep, sort, uniq, cut, sed, awk, du, ls -- completely unchecked on
     * the primary execution route. `grep root /etc/passwd` returned the matching
     * line. Nothing enforced the per-command schemas published at /api/catalog
     * either, so `seq --not-a-flag` was accepted.
     *
     * `validateArguments` is the same function the terminal route uses, so a rule
     * that exists on one route is not absent from the other. Validated AFTER the
     * workload argv is materialised, because the materialized vector is what
     * actually reaches execvp.
     */
    let validatedArgs: string[];
    try {
      validatedArgs = [...validateArguments(body.command, args, config)];
    } catch (err) {
      const reason = err instanceof ArgumentError ? err.message : `Arguments rejected for "${body.command}".`;
      return sendError(reply, 422, "ARGUMENT_REJECTED", reason, rid);
    }

    try {
      for (const slot of ["in", "out", "append"] as const) {
        const target = body.redirections?.[slot];
        if (target !== undefined) assertTargetInWorkspace(config, target);
      }
    } catch (err) {
      if (err instanceof RedirectionPolicyError) {
        return sendError(reply, 422, "REDIRECTION_REJECTED", err.message, rid);
      }
      return sendError(reply, 422, "REDIRECTION_REJECTED", "Redirection target rejected.", rid);
    }

    const result = runner.start({
      command: body.command,
      executable: resolved.path,
      // The validated vector, not the raw one. `validatedArgs` is what the
      // catalog's schema and the workspace policy actually approved, so passing
      // `args` here would record an execution nobody checked.
      args: validatedArgs,
      redirections: body.redirections ?? {},
      timeoutMs,
    });
    if ("error" in result) {
      const status = result.error.code === "CONCURRENCY_LIMIT_REACHED" ? 429 : 500;
      return sendError(reply, status, result.error.code, result.error.message, rid);
    }
    const session = sessions.findById(result.sessionId);
    return reply.code(202).send({
      sessionId: result.sessionId,
      status: session?.status ?? "STARTING",
      eventsUrl: `/api/sessions/${result.sessionId}/events`,
      argvPreview: ["--monitor", "--json", body.command, ...args],
    });
  });

  app.get("/api/sessions", async (req, reply) => {
    const q = SESSION_LIST_QUERY.safeParse(req.query ?? {});
    if (!q.success) {
      return sendError(reply, 400, "INVALID_ARGUMENT", q.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "), requestId(req));
    }
    const { limit, offset, status, q: search } = q.data;
    const list = sessions.list(limit, offset, { status, q: search });
    const total = sessions.count({ status, q: search });
    return reply.send({ sessions: list, total, limit, offset });
  });

  const parseId = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const parsed = ID_PARAMS.safeParse(req.params ?? {});
    if (!parsed.success) {
      sendError(reply, 400, "INVALID_ARGUMENT", "Malformed execution id.", requestId(req));
      return null;
    }
    return parsed.data.id;
  };

  app.get("/api/sessions/:id", async (req, reply) => {
    const id = parseId(req, reply);
    if (id === null) return;
    const session = sessions.findById(id);
    if (!session) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    return reply.send(session);
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    const id = parseId(req, reply);
    if (id === null) return;
    const active = registry.get(id);
    if (active && !isTerminalState(active.state)) {
      return sendError(reply, 409, "RUNNING", "Cannot delete a running execution.");
    }
    const res = sessions.deleteById(id);
    if (!res.sessions && !res.events) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    return reply.send({ deleted: true, id });
  });

  // ---------------------------------------------------------------- argv
  app.get("/api/sessions/:id/argv", async (req, reply) => {
    const id = parseId(req, reply);
    if (id === null) return;
    const session = sessions.findById(id);
    if (!session) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    return reply.send({
      sessionId: id,
      argc: session.argv.length,
      argv: session.argv,
      argvDisplay: [...session.argv, "NULL"],
      terms: ["argv", "argc", "index"],
    });
  });

  // -------------------------------------------------------------- output
  /**
   * Live output while running, persisted output once finished.
   *
   * The previous version returned `session.stdout || live` for stdout but only
   * the persisted value for stderr, so the stderr panel stayed empty for the
   * whole run and only filled in at the end.  Both channels are now live, and
   * the response says whether the values are live or persisted so a consumer
   * is never guessing.
   */
  app.get("/api/sessions/:id/output", async (req, reply) => {
    const id = parseId(req, reply);
    if (id === null) return;
    const session = sessions.findById(id);
    if (!session) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);

    const live = runner.outputFor(id);
    if (live !== null) {
      return reply.send({
        sessionId: id,
        stdout: live.stdout,
        stderr: live.stderr,
        live: true,
        stdoutTruncated: live.stdoutTruncated,
        stderrTruncated: live.stderrTruncated,
        channels: {
          stdout: "the executed program's own stdout, copied verbatim",
          stderr: "the executed program's stderr plus CAPS diagnostics; the CAPS monitor protocol is not included",
          limitation: "CAPS diagnostics and the target's stderr share one descriptor and are separated line-wise, not at descriptor level",
        },
      });
    }
    return reply.send({
      sessionId: id,
      stdout: session.stdout,
      stderr: session.stderr,
      live: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      channels: {
        stdout: "the executed program's own stdout, copied verbatim",
        stderr: "the executed program's stderr plus CAPS diagnostics; the CAPS monitor protocol is not included",
        limitation: "CAPS diagnostics and the target's stderr share one descriptor and are separated line-wise, not at descriptor level",
      },
    });
  });

  // ------------------------------------------------------------- replay
  /**
   * Replay is strictly read-only.
   *
   * Nothing in this handler writes, spawns, samples, or starts a telemetry
   * loop.  The response includes the stream's invariant report so a reader can
   * see that the replayed evidence satisfies the same rules the gateway
   * enforces when writing it.
   */
  app.get("/api/sessions/:id/replay", async (req, reply) => {
    const id = parseId(req, reply);
    if (id === null) return;
    const session = sessions.findById(id);
    if (!session) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    const evs = events.listAllForSession(id);
    const validation = validateEventStream(evs, { sessionStatus: session.status });
    return reply.send({
      sessionId: id,
      command: session.command,
      argv: session.argv,
      startedAt: session.startedAt,
      status: session.status,
      events: evs,
      integrity: {
        valid: validation.valid,
        errors: validation.errorCount,
        warnings: validation.warningCount,
        corruptPayloads: events.countCorruptPayloads(id),
        summary: validation.summary,
        violations: validation.violations,
      },
      result: {
        exitCode: session.exitCode,
        signal: session.signal,
        durationMs: session.durationMs,
        isSuccess: session.isSuccess,
        status: session.status,
        error: session.error,
      },
    });
  });

  // ---------------------------------------------------- events (SSE)
  /**
   * Per-session event stream.
   *
   * The delivery order is what makes this correct:
   *
   *   1. subscribe to the bus with a BUFFER (the listener exists, but events
   *      go into the buffer);
   *   2. read the persisted backlog;
   *   3. send the backlog;
   *   4. flush the buffer, dropping anything already sent.
   *
   * The previous order -- read, compute the last sequence, then subscribe --
   * left a window in which an event could be persisted and published with no
   * listener attached, so a connected client silently missed it.  The
   * guarantee this implements is: a client never misses a persisted event
   * because it connected at the wrong moment.
   */
  app.get("/api/sessions/:id/events", async (req, reply) => {
    const id = parseId(req, reply);
    if (id === null) return;
    const session = sessions.findById(id);
    if (!session) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);

    const lastSeq = readLastEventId(req);
    let subscription: ReturnType<EventBus["subscribeBuffered"]> | null = null;
    const stream = new SseStream(req, reply, () => subscription?.close());

    // ---- step 1: attach before reading --------------------------------
    subscription = bus.subscribeBuffered(id);

    const sentSequences = new Set<number>();
    const deliver = (ev: CanonicalEvent): void => {
      if (stream.isClosed) return;
      if (sentSequences.has(ev.sequence)) return;
      sentSequences.add(ev.sequence);
      stream.sendEvent(ev);
      if (isTerminalEventType(ev.type)) {
        const sess = sessions.findById(id);
        sendSessionEnd(stream, id, sess?.status ?? "COMPLETED", {
          exitCode: sess?.exitCode ?? null,
          signal: sess?.signal ?? null,
          durationMs: sess?.durationMs ?? null,
        });
        subscription?.close();
      }
    };

    // ---- step 2/3: read and send the persisted backlog ------------------
    const persisted = events.listForSession(id, lastSeq);
    for (const ev of persisted) {
      if (stream.isClosed) break;
      deliver(ev);
    }

    if (stream.isClosed) {
      subscription.close();
      return;
    }

    // ---- a session already finished: the backlog above was everything ----
    const finalized = ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(session.status);
    if (finalized) {
      const last = events.listAllForSession(id).at(-1);
      if (last && isTerminalEventType(last.type)) {
        subscription.close();
        sendSessionEnd(stream, id, session.status, {
          exitCode: session.exitCode,
          signal: session.signal,
          durationMs: session.durationMs,
        });
        return;
      }
      subscription.close();
      sendSessionEnd(stream, id, session.status, {
        exitCode: session.exitCode,
        signal: session.signal,
        durationMs: session.durationMs,
      });
      return;
    }

    // ---- step 4: go live, then drain what accumulated during the read ---
    subscription.setDelivery(deliver);
    const caughtUp = subscription.flush((ev) => sentSequences.has(ev.sequence));
    logger.debug("SSE", "attached to session", { sessionId: id, lastSeq, backlog: persisted.length, caughtUp: caughtUp.length });
  });

  // -------------------------------------------------- live global stream
  /**
   * Global stream across every session, with the same race-free ordering as
   * the per-session stream.  The recent-events preload uses the id set the
   * repository returns, so the duplicate filter is a Set lookup rather than a
   * linear scan per delivered frame.
   */
  app.get("/api/live/stream", async (req, reply) => {
    let subscription: ReturnType<EventBus["subscribeBuffered"]> | null = null;
    const stream = new SseStream(req, reply, () => subscription?.close());

    subscription = bus.subscribeBuffered(EventBus.GLOBAL);
    const sentIds = new Set<string>();
    const deliver = (ev: CanonicalEvent): void => {
      if (stream.isClosed || sentIds.has(ev.id)) return;
      sentIds.add(ev.id);
      stream.sendEvent(ev);
    };

    const { events: recent, ids } = events.listRecentGlobal(30);
    for (const ev of recent) {
      if (stream.isClosed) break;
      sentIds.add(ev.id);
      stream.sendEvent(ev);
    }
    ids.forEach((id) => sentIds.add(id));

    subscription.setDelivery(deliver);
    subscription.flush((ev) => sentIds.has(ev.id));
    logger.debug("SSE", "attached to global stream", { preload: recent.length });
  });

  // ---------------------------------------------------------- terminate
  app.post("/api/sessions/:id/terminate", async (req, reply) => {
    const id = parseId(req, reply);
    if (id === null) return;
    const parsed = TERMINATE_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, "INVALID_ARGUMENT", "Invalid signal name.", requestId(req));

    const active = registry.get(id);
    if (!active) return sendError(reply, 404, "NOT_FOUND", "Execution is not running (or does not exist).");
    if (isTerminalState(active.state)) return sendError(reply, 409, "NOT_RUNNING", "Execution is already terminal.");

    const result = runner.requestTerminate(id, parsed.data.signal);
    if (result.sent) {
      logger.info("SECURITY", "terminate requested", { sessionId: id, signal: parsed.data.signal, pid: active.childPid, identityVerified: true });
      return reply.code(202).send({ sessionId: id, signal: parsed.data.signal, status: "SIGNAL_SENT" });
    }
    return sendError(reply, 409, "SIGNAL_FAILED", result.reason ?? "Signal could not be delivered.", requestId(req));
  });

  // ------------------------------------------------------------ processes
  app.get("/api/processes", async () => {
    const processes = registry.listProcesses().map((process) => ({
      ...process,
      telemetry: events.latestForSessionByType(process.sessionId, "process.snapshot")?.payload ?? null,
    }));
    return { processes, capacity: config.maxConcurrent };
  });

  // ------------------------------------------------------------- analytics
  app.get("/api/analytics/overview", async () => computeAnalytics(sessions, events));

  app.get("/api/analytics/commands", async () => {
    const commands = computeCommandProfiles(sessions, events);
    return { commands, totalCommandRuns: commands.reduce((sum, c) => sum + c.runs, 0) };
  });

  app.get("/api/analytics/compare", async (req, reply) => {
    const q = z.object({ ids: z.string().min(3).max(300) }).safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, "INVALID_ARGUMENT", "Provide exactly two session ids (?ids=a,b).", requestId(req));
    const idList = q.data.ids.split(",").map((s) => s.trim()).filter(Boolean);
    if (idList.length !== 2) {
      return sendError(reply, 400, "INVALID_ARGUMENT", `Provide exactly two session ids (?ids=a,b); received ${idList.length}.`, requestId(req));
    }
    const invalid = idList.filter((id) => !SESSION_ID.safeParse(id).success);
    if (invalid.length > 0) {
      return sendError(reply, 400, "INVALID_ARGUMENT", `Malformed session id: ${invalid.join(", ")}.`, requestId(req));
    }
    if (idList[0] === idList[1]) {
      return sendError(reply, 400, "INVALID_ARGUMENT", "A session cannot be compared with itself.", requestId(req));
    }
    const a = sessions.findById(idList[0]!);
    const b = sessions.findById(idList[1]!);
    if (!a || !b) {
      const missing = [a ? null : idList[0], b ? null : idList[1]].filter(Boolean).join(", ");
      return sendError(reply, 404, "NOT_FOUND", `No execution found for: ${missing}.`);
    }
    return reply.send(compareSessions(a, b, events.listAllForSession(a.id), events.listAllForSession(b.id)));
  });

  // ------------------------------------------------------------- export
  app.get("/api/sessions/:id/export", async (req, reply) => {
    const id = parseId(req, reply);
    if (id === null) return;
    const raw = (req.query as { format?: string }).format;
    // An unknown format is a client error, not something to silently turn into
    // a different format than the one that was asked for.
    let format: "json" | "csv" = "json";
    if (raw !== undefined) {
      const parsedFormat = EXPORT_FORMAT.safeParse(raw);
      if (!parsedFormat.success) {
        return sendError(reply, 400, "INVALID_ARGUMENT", `Unsupported export format "${raw}". Supported: json, csv.`, requestId(req));
      }
      format = parsedFormat.data;
    }
    const session = sessions.findById(id);
    if (!session) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    const evs = events.listAllForSession(id);
    const peaks = computeRuntimePeaks(evs);
    const validation = validateEventStream(evs, { sessionStatus: session.status });

    if (format === "csv") {
      const lines = ["sequence,type,source,timestamp,monotonic_ms,pid,payload_json"];
      for (const ev of evs) {
        lines.push(
          [String(ev.sequence), ev.type, ev.source, ev.timestamp,
            ev.monotonicMs === null ? "" : String(ev.monotonicMs),
            ev.pid === null ? "" : String(ev.pid),
            csvField(JSON.stringify(ev.payload))].join(","),
        );
      }
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="${id}.csv"`);
      return reply.send(lines.join("\n"));
    }

    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${id}.json"`);
    return reply.send({
      exportedAt: new Date().toISOString(),
      generator: "caps-observatory",
      version,
      session: {
        id: session.id, command: session.command, args: session.args, argv: session.argv,
        status: session.status, startedAt: session.startedAt, endedAt: session.endedAt,
        durationMs: session.durationMs, exitCode: session.exitCode, signal: session.signal,
        isSuccess: session.isSuccess, pid: session.pid, timeoutMs: session.timeoutMs, eventCount: evs.length,
        error: session.error,
      },
      integrity: { valid: validation.valid, errors: validation.errorCount, warnings: validation.warningCount, summary: validation.summary },
      telemetry: peaks,
      events: evs,
    });
  });

  // ------------------------------------------------------------- report
  const mib = (bytes: number | null): string => (bytes === null ? "UNAVAILABLE" : `${(bytes / (1024 * 1024)).toFixed(2)} MiB`);
  const kibPerSec = (bytes: number | null): string => {
    if (bytes === null) return "UNAVAILABLE";
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB/s` : `${(bytes / 1024).toFixed(1)} KiB/s`;
  };

  app.get("/api/sessions/:id/report", async (req, reply) => {
    const id = parseId(req, reply);
    if (id === null) return;
    const session = sessions.findById(id);
    if (!session) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    const evs = events.listAllForSession(id);
    const peaks = computeRuntimePeaks(evs);
    const validation = validateEventStream(evs, { sessionStatus: session.status });

    const counts = new Map<string, number>();
    for (const ev of evs) counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1);
    const timeline = [...counts.entries()].map(([type, n]) => `- \`${type}\` × ${n}`).join("\n");
    const started = evs.find((e) => e.type === "process.started");
    const exited = evs.find((e) => e.type === "process.exited");
    const execError = evs.find((e) => e.type === "process.exec_error");
    const waitFailed = evs.find((e) => e.type === "process.wait_failed");
    const launchFailed = evs.find((e) => e.type === "process.launch_failed");
    const signalEv = evs.find((e) => e.type === "signal.received");
    const snapshotCount = peaks.sampleCount;

    const span = peaks.firstSampleAt && peaks.lastSampleAt
      ? `${Math.max(0, Math.round((new Date(peaks.lastSampleAt).getTime() - new Date(peaks.firstSampleAt).getTime()) / 100) / 10)}s (first sample ${peaks.firstSampleAt}, last ${peaks.lastSampleAt})`
      : "no persistable samples";

    const body = [
      "# CAPS Observation Report",
      "",
      `- Execution: \`${session.id}\``,
      `- Command: \`${session.command} ${session.args.join(" ")}\``,
      `- Status: \`${session.status}\``,
      `- Exit: ${session.exitCode === null ? "UNAVAILABLE" : `\`${session.exitCode}\``} · Signal: ${session.signal === null ? "none" : `\`${session.signal}\``}`,
      `- Duration: ${session.durationMs === null ? "UNAVAILABLE (gateway did not finalize)" : `${(session.durationMs / 1000).toFixed(2)}s (gateway clock)`}`,
      `- Started: ${session.startedAt} · Ended: ${session.endedAt ?? "still running"}`,
      `- Events: ${evs.length} (sequences ${evs.length > 0 ? `0–${evs.at(-1)?.sequence ?? 0}` : "none"})`,
      `- Event-stream integrity: **${validation.valid ? "valid" : "INVALID"}** (${validation.errorCount} error(s), ${validation.warningCount} warning(s)) — ${describeValidation(validation)}`,
      "",
      "## Event timeline",
      timeline === "" ? "No events recorded." : timeline,
      "",
      "## Process resources (observed)",
      ...(snapshotCount === 0
        ? ["No procfs snapshots were collected for this execution."]
        : [
            `- Samples: \`${snapshotCount}\` · span ${span}`,
            `- Peak RSS: ${peaks.peakRssBytes === null ? "UNAVAILABLE" : `${(peaks.peakRssBytes.value / (1024 * 1024)).toFixed(2)} MiB at ${peaks.peakRssBytes.atTimeMs}ms after first event`} (OBSERVED /proc/${session.pid ?? "?"}/status)`,
            `- Median RSS: ${peaks.medianRssBytes === null ? "UNAVAILABLE (needs ≥2 valid samples)" : `${(peaks.medianRssBytes / (1024 * 1024)).toFixed(2)} MiB`}`,
            `- Peak CPU utilization: ${peaks.peakCpuPercent === null ? "UNAVAILABLE (needs ≥2 valid samples)" : `${peaks.peakCpuPercent.value.toFixed(1)}% at ${peaks.peakCpuPercent.atTimeMs}ms`} (DERIVED from tick deltas, percentage of one core)`,
            `- Total CPU time (user+system, final sample): ${peaks.cpuTimeMs === null ? "UNAVAILABLE" : `${(peaks.cpuTimeMs / 1000).toFixed(2)}s`} (DERIVED from ticks)`,
            `- Peak page faults: minor ${peaks.peakMinorFaults === null ? "UNAVAILABLE" : peaks.peakMinorFaults.value} · major ${peaks.peakMajorFaults === null ? "UNAVAILABLE" : peaks.peakMajorFaults.value} (OBSERVED /proc/${session.pid ?? "?"}/stat)`,
            `- Peak fault rates: minor ${peaks.peakMinorFaultsPerSec === null ? "UNAVAILABLE" : `${peaks.peakMinorFaultsPerSec.value}/s`} · major ${peaks.peakMajorFaultsPerSec === null ? "UNAVAILABLE" : `${peaks.peakMajorFaultsPerSec.value}/s`} (DERIVED)`,
            `- Syscall I/O totals (rchar/wchar): ${mib(peaks.totalRcharBytes)} / ${mib(peaks.totalWcharBytes)} (OBSERVED /proc/${session.pid ?? "?"}/io; characters, not disk throughput)`,
            `- Block-device I/O totals (read_bytes/write_bytes): ${mib(peaks.totalReadBytes)} / ${mib(peaks.totalWriteBytes)} (OBSERVED /proc/${session.pid ?? "?"}/io)`,
            `- Peak I/O rates: rchar ${kibPerSec(peaks.peakRcharBytesPerSec?.value ?? null)} · wchar ${kibPerSec(peaks.peakWcharBytesPerSec?.value ?? null)} (DERIVED)`,
          ]),
      "",
      "## Lifecycle observations",
      `- Process started: ${started ? `PID ${started.pid ?? "UNAVAILABLE"} at ${started.timestamp}` : "UNAVAILABLE"}`,
      `- Engine verdict: \`${exited?.payload.outcome ?? execError?.payload.outcome ?? waitFailed?.payload.outcome ?? launchFailed?.payload.outcome ?? "UNAVAILABLE"}\``,
      `- Exec outcome: ${execError
        ? `EXEC_ERROR — ${execError.payload.reason ?? "unknown"} (exit_code ${execError.payload.exitCode ?? "n/a"}, errno ${execError.payload.errno ?? "n/a"} ${execError.payload.errnoName ?? ""}); no program ran`
        : waitFailed
          ? `WAIT_FAILED — ${waitFailed.payload.reason ?? "unknown"}; the process outcome is unknown`
          : launchFailed
            ? `LAUNCH_FAILED — ${launchFailed.payload.reason ?? "unknown"}; the child was never created`
            : exited
              ? `ordinary process exit, code ${exited.payload.exitCode ?? "UNAVAILABLE"}`
              : "UNAVAILABLE — no process lifecycle event was recorded"}`,
      exited
        ? `- Process exited: exit \`${exited.payload.exitCode ?? "UNAVAILABLE"}\` at ${exited.timestamp}`
        : signalEv
          ? `- Signal received: \`${signalEv.payload.signal ?? "UNAVAILABLE"}\` at ${signalEv.timestamp}`
          : "- Process end: UNAVAILABLE",
      `- Session error: ${session.error ?? "none"}`,
      "",
      "## Provenance",
      "- Process snapshots come from `/proc/<tracked-pid>/stat`, `status`, and `io`. CPU utilization and every per-second rate are DERIVED by differencing two valid samples over a measured interval; they are not single procfs fields.",
      "- The first sample of a process reports every rate as UNAVAILABLE with a reason, because a rate needs two valid samples; it is never invented or zero-filled.",
      "- A cumulative counter that decreases between samples is reported as UNAVAILABLE, never as zero: a decrease means the identity changed, not that nothing was measured.",
      "- rchar/wchar count characters passed to read()/write(), including page-cache hits. read_bytes/write_bytes count bytes that reached the block layer. Character counters are not disk throughput.",
      "- A sampled PID is accepted only while its procfs PPID matches the gateway-spawned CAPS process and its start ticks stay constant.",
      "- Event timestamps are gateway receive times, not kernel timestamps. Session duration uses the gateway clock; an engine monotonic duration may differ.",
      "- A `SESSION_SUMMARY` event means the monitor closed, not that execution succeeded. The session status is derived from the engine's `outcome` field.",
      "- Missing values are UNAVAILABLE rather than filled with zero.",
      "",
      "## Limits of this report",
      "- stderr redirection and low-level `open()`/`dup2()`/`close()` events are unsupported.",
      "- Only the CAPS-owned child PID is sampled; descendants it forks are NOT discovered, so a fork-heavy workload shows fork activity of one process, not a process tree.",
      "- CAPS diagnostics and the target's stderr share one descriptor and are separated line-wise, not at descriptor level.",
      "- Syscall tracing, eBPF, cgroup accounting, network I/O, and file-descriptor counts are not collected.",
      "- This is a summary of the persisted event store; it does not re-execute the command.",
    ].join("\n");

    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${id}-report.md"`);
    return reply.send(body);
  });

  // -------------------------------------------------------- playground
  app.get("/api/playground/examples", async () => ({ examples: playgroundExamples }));

  // ------------------------------------------------------------ retention
  /**
   * Retention sweep.
   *
   * Enabled only when CAPS_RETENTION_DAYS > 0; the endpoint reports what the
   * policy is either way, so an operator can confirm whether the recorder is
   * keeping or discarding without reading the configuration.
   */
  app.post("/api/retention/sweep", async (_req, reply) => {
    if (config.retentionDays <= 0) {
      return reply.send({ enabled: false, reason: "retention is disabled (CAPS_RETENTION_DAYS=0); nothing was deleted", ...sessions.storageStats() });
    }
    const cutoff = new Date(Date.now() - config.retentionDays * 86_400_000).toISOString();
    const removed = sessions.purgeOlderThan(cutoff);
    logger.info("STORAGE", "retention sweep", { cutoff, ...removed });
    return reply.send({ enabled: true, cutoff, ...removed, ...sessions.storageStats() });
  });
}
