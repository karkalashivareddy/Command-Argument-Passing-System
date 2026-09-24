import { accessSync, constants } from "node:fs";
import { platform } from "node:os";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { CapsConfig } from "../config/env.js";
import type { EventRepository } from "../db/repositories/events.js";
import type { SessionRepository } from "../db/repositories/sessions.js";
import { EventBus } from "../events/bus.js";
import type { ExecutionRunner } from "../execution/runner.js";
import type { ExecutionRegistry } from "../execution/registry.js";
import { signalChild } from "../execution/terminator.js";
import { computeAnalytics, compareSessions, computeCommandProfiles, computeRuntimePeaks } from "../analytics/service.js";
import {
  allowedCommands,
  assertReadableFileInWorkspace,
  assertTargetInWorkspace,
  isCommandAllowed,
  RedirectionPolicyError,
  resolveAllowedExecutable,
  validateArgVector,
} from "../security/policy.js";
import type { CanonicalEvent } from "../types/observability.js";
import { logger } from "../utils/logger.js";
import { newId } from "../utils/ids.js";
import { SseStream, sendEnd, sendEvent } from "../events/sse.js";
import { playgroundExamples } from "./playground.js";

export interface ApiDeps {
  config: CapsConfig;
  sessions: SessionRepository;
  events: EventRepository;
  bus: EventBus;
  runner: ExecutionRunner;
  registry: ExecutionRegistry;
  version: string;
}

const TERMINAL_EVENT_TYPES = new Set(["execution.completed", "execution.failed", "execution.timeout"]);

function csvField(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, requestId?: string): void {
  reply.code(status).send({ error: { code, message, requestId } });
}

function readLastEventId(req: FastifyRequest): number {
  const raw = req.headers["last-event-id"];
  if (typeof raw === "string") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return -1;
}

export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { config, sessions, events, bus, runner, registry, version } = deps;

  const executionSchema = z.object({
    command: z.string().min(1).max(256),
    args: z.array(z.string().max(4096)).max(512).default([]),
    redirections: z
        .object({
          in: z.string().optional(),
          out: z.string().optional(),
          append: z.string().optional(),
        })
        .strict()
      .optional(),
    timeoutMs: z.number().int().min(1000).optional(),
  });

  const terminateSchema = z.object({
    signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL", "SIGQUIT", "SIGTSTP"]).default("SIGINT"),
  });

  // ---------------------------------------------------------------- health
  app.get("/api/health", async (_req, reply) => {
    let engineAvailable = false;
    try {
      accessSync(config.capsExecutable, constants.X_OK);
      engineAvailable = true;
    } catch {
      engineAvailable = false;
    }
    return reply.send({
      status: "ok",
      engine: { available: engineAvailable, path: config.capsExecutable },
      database: { available: true },
      version,
      platform: platform() === "linux" ? "linux/posix" : platform(),
    });
  });

  const requestId = (req: FastifyRequest): string => (req.headers["x-request-id"] as string) ?? `req_${newId("req")}`;

  // ---------------------------------------------------------- capabilities
  app.get("/api/capabilities", async (_req, reply) => {
    let engineAvailable = false;
    try {
      accessSync(config.capsExecutable, constants.X_OK);
      engineAvailable = true;
    } catch {
      engineAvailable = false;
    }
    return reply.send({
      platform: platform() === "linux" ? "linux/posix" : platform(),
      engineAvailable,
      capsPath: config.capsExecutable,
      allowlist: allowedCommands(),
      limits: {
        maxConcurrent: config.maxConcurrent,
        defaultTimeoutMs: config.defaultTimeoutMs,
        maxTimeoutMs: config.maxTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
      },
      workspace: config.workspace,
      redirection: { supported: true, modes: ["in", "out", "append"] },
      signals: { supported: true },
      telemetry: {
        enabled: platform() === "linux",
        intervalMs: 500,
        source: platform() === "linux" ? "/proc/<tracked-pid>" : "UNAVAILABLE",
        metrics: ["pid", "ppid", "state", "startTime", "elapsedMs", "cpuUserMs", "cpuSystemMs", "cpuPercent", "rssBytes", "virtualMemoryBytes", "threadCount", "voluntaryContextSwitches", "nonVoluntaryContextSwitches", "processGroupId", "sessionId"],
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
      bind: `${config.host}:${config.port}`,
    });
  });

  // ------------------------------------------------------------- sessions
  app.post("/api/sessions", async (req, reply) => {
    const rid = requestId(req);
    const parsed = executionSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_ARGUMENT", "Invalid execution request: " + parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "), rid);
    }
    const body = parsed.data;
    const timeoutMs = Math.min(body.timeoutMs ?? config.defaultTimeoutMs, config.maxTimeoutMs);

    validateArgVector(body.command, body.args);

    if (!isCommandAllowed(body.command)) {
      return sendError(reply, 403, "COMMAND_NOT_ALLOWED", `Command "${body.command}" is not on the allowlist.`, rid);
    }

    const resolved = resolveAllowedExecutable(body.command);
    if (resolved === null) {
      return sendError(reply, 403, "COMMAND_NOT_ALLOWED", `Command "${body.command}" is unavailable (helper binary missing).`, rid);
    }

    try {
      if (body.command === "cat") {
        for (const path of body.args) assertReadableFileInWorkspace(config, path);
      }
      for (const slot of ["in", "out", "append"] as const) {
        const target = body.redirections?.[slot];
        if (target) {
          assertTargetInWorkspace(config, target);
        }
      }
    } catch (err) {
      if (err instanceof RedirectionPolicyError) {
        return sendError(reply, 422, body.command === "cat" ? "FILE_ARGUMENT_REJECTED" : "REDIRECTION_REJECTED", err.message, rid);
      }
      return sendError(reply, 422, "REDIRECTION_REJECTED", "Redirection target rejected.", rid);
    }

    const result = runner.start({
      command: body.command,
      executable: resolved,
      args: body.args,
      redirections: body.redirections ?? {},
      timeoutMs,
    });
    if ("error" in result) {
      return sendError(reply, result.error.code === "CONCURRENCY_LIMIT_REACHED" ? 429 : 500, result.error.code, result.error.message, rid);
    }
    const session = sessions.findById(result.sessionId);
    return reply.code(202).send({
      sessionId: result.sessionId,
      status: session?.status ?? "STARTING",
      eventsUrl: `/api/sessions/${result.sessionId}/events`,
      argvPreview: ["--monitor", "--json", body.command, ...body.args],
    });
  });

  app.get("/api/sessions", async (req, reply) => {
    const q = req.query as { limit?: string; offset?: string; status?: string; q?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    const list = sessions.list(limit, offset, { status: q.status, q: q.q });
    const total = sessions.count({ status: q.status, q: q.q });
    return reply.send({ sessions: list, total });
  });

  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.findById(id);
    if (!session) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    return reply.send(session);
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const active = registry.get(id);
    if (active && !["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(active.state)) {
      return sendError(reply, 409, "RUNNING", "Cannot delete a running execution.");
    }
    const res = sessions.deleteById(id);
    if (!res.sessions && !res.events) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    return reply.send({ deleted: true, id });
  });

  // ---------------------------------------------------------------- argv
  app.get("/api/sessions/:id/argv", async (req, reply) => {
    const { id } = req.params as { id: string };
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
  app.get("/api/sessions/:id/output", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.findById(id);
    if (!session) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    const live = runner.stdoutFor(id);
    return reply.send({
      sessionId: id,
      stdout: session.stdout || live,
      stderr: session.stderr,
      live: live.length > 0,
    });
  });

  // ------------------------------------------------------------- replay
  app.get("/api/sessions/:id/replay", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.findById(id);
    if (!session) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    const evs = events.listAllForSession(id);
    return reply.send({
      sessionId: id,
      command: session.command,
      argv: session.argv,
      startedAt: session.startedAt,
      status: session.status,
      events: evs,
      result: {
        exitCode: session.exitCode,
        signal: session.signal,
        durationMs: session.durationMs,
        isSuccess: session.isSuccess,
        status: session.status,
      },
    });
  });

  // ---------------------------------------------------- events (SSE)
  app.get("/api/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.findById(id);
    if (!session) {
      return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    }
    void req;

    const lastSeq = readLastEventId(req);
    const stream = new SseStream(req, reply, () => {
      busSub?.();
    });

    let busSub: (() => void) | null = null;

    // Replay persisted events first (reconnect-safe).
    const persisted = events.listForSession(id, lastSeq);
    for (const ev of persisted) {
      if (stream.isClosed) break;
      sendEvent(stream, ev);
      if (TERMINAL_EVENT_TYPES.has(ev.type)) {
        finalizeStream(stream, id);
        return;
      }
    }

    if (stream.isClosed) return;

    const last = events.maxSequence(id);
    if (session.status === "COMPLETED" || session.status === "FAILED" || session.status === "TIMED_OUT" || session.status === "CANCELLED") {
      // No more events will arrive; the persisted replay above is complete.
      const ev = events.listAllForSession(id).at(-1);
      if (ev && TERMINAL_EVENT_TYPES.has(ev.type)) {
        finalizeStream(stream, id);
        return;
      }
      sendEnd(stream, id, session.status, { exitCode: session.exitCode, signal: session.signal, durationMs: session.durationMs });
      return;
    }

    busSub = bus.subscribe(id, (ev: CanonicalEvent) => {
      if (stream.isClosed) {
        busSub?.();
        return;
      }
      if (ev.sequence <= last) return; // already replayed
      sendEvent(stream, ev);
      if (TERMINAL_EVENT_TYPES.has(ev.type)) {
        finalizeStream(stream, id);
      }
    });

    function finalizeStream(s: SseStream, sid: string): void {
      const sess = sessions.findById(sid);
      sendEnd(s, sid, sess?.status ?? "COMPLETED", {
        exitCode: sess?.exitCode ?? null,
        signal: sess?.signal ?? null,
        durationMs: sess?.durationMs ?? null,
      });
    }

    logger.debug("SSE", "attached to session", { sessionId: id, lastSeq });
  });

  // -------------------------------------------------- live global stream
  app.get("/api/live/stream", async (req, reply) => {
    const stream = new SseStream(req, reply, () => {
      busGlobal?.();
    });
    let busGlobal: (() => void) | null = null;

    const recent = events.listRecentGlobal(30);
    for (const ev of recent) sendEvent(stream, ev);

    busGlobal = bus.subscribe(EventBus.GLOBAL, (ev: CanonicalEvent) => {
      if (stream.isClosed) {
        busGlobal?.();
        return;
      }
      if (recent.some((r) => r.id === ev.id)) return;
      sendEvent(stream, ev);
    });
  });

  // ---------------------------------------------------------- terminate
  app.post("/api/sessions/:id/terminate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = terminateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, "INVALID_ARGUMENT", "Invalid signal name.", requestId(req));

    const active = registry.get(id);
    if (!active) return sendError(reply, 404, "NOT_FOUND", "Execution is not running (or does not exist).");
    if (["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(active.state)) {
      return sendError(reply, 409, "NOT_RUNNING", "Execution is already terminal.");
    }

    const sig = parsed.data.signal;
    const result = signalChild(active.childPid, sig);
    if (result.sent) {
      active.terminateRequested = true;
      logger.info("SECURITY", "terminate requested", { sessionId: id, signal: sig, pid: active.childPid });
      return reply.code(202).send({ sessionId: id, signal: sig, status: "SIGNAL_SENT" });
    }
    return sendError(reply, 409, "SIGNAL_FAILED", result.reason ?? "Signal could not be delivered.", requestId(req));
  });

  // ------------------------------------------------------------ processes
  app.get("/api/processes", async (_req, reply) => {
    const processes = registry.listProcesses().map((process) => ({
      ...process,
      telemetry: events.latestForSessionByType(process.sessionId, "process.snapshot")?.payload ?? null,
    }));
    return reply.send({ processes, capacity: config.maxConcurrent });
  });

  // ------------------------------------------------------------- analytics
  app.get("/api/analytics/overview", async (_req, reply) => {
    return reply.send(computeAnalytics(sessions));
  });

  app.get("/api/analytics/commands", async (_req, reply) => {
    const commands = computeCommandProfiles(sessions);
    return reply.send({ commands, totalCommandRuns: commands.reduce((sum, c) => sum + c.runs, 0) });
  });

  app.get("/api/analytics/compare", async (req, reply) => {
    const idsRaw = (req.query as { ids?: string }).ids;
    const idList = (idsRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 2);
    if (idList.length !== 2) {
      return sendError(reply, 400, "INVALID_ARGUMENT", "Provide exactly two session ids (?ids=a,b).", requestId(req));
    }
    const a = sessions.findById(idList[0]!);
    const b = sessions.findById(idList[1]!);
    if (!a || !b) {
      const missing = [a ? null : idList[0], b ? null : idList[1]].filter(Boolean).join(", ");
      return sendError(reply, 404, "NOT_FOUND", `No execution found for: ${missing}.`);
    }
    if (a.id === b.id) {
      return sendError(reply, 400, "INVALID_ARGUMENT", "A session cannot be compared with itself.", requestId(req));
    }
    return reply.send(compareSessions(a, b, events.listAllForSession(a.id), events.listAllForSession(b.id)));
  });

  // ------------------------------------------------------------- export
  app.get("/api/sessions/:id/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const format = (req.query as { format?: string }).format === "csv" ? "csv" : "json";
    const session = sessions.findById(id);
    if (!session) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    const evs = events.listAllForSession(id);
    const peaks = computeRuntimePeaks(evs);

    if (format === "csv") {
      const lines = ["sequence,type,source,timestamp,monotonic_ms,pid,payload_json"];
      for (const ev of evs) {
        lines.push(
          [
            String(ev.sequence),
            ev.type,
            ev.source,
            ev.timestamp,
            ev.monotonicMs === null ? "" : String(ev.monotonicMs),
            ev.pid === null ? "" : String(ev.pid),
            csvField(JSON.stringify(ev.payload)),
          ].join(","),
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
      session: {
        id: session.id,
        command: session.command,
        args: session.args,
        argv: session.argv,
        status: session.status,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationMs: session.durationMs,
        exitCode: session.exitCode,
        signal: session.signal,
        isSuccess: session.isSuccess,
        pid: session.pid,
        timeoutMs: session.timeoutMs,
        eventCount: evs.length,
      },
      telemetry: peaks,
      events: evs,
    });
  });

  // ------------------------------------------------------------- report
  app.get("/api/sessions/:id/report", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.findById(id);
    if (!session) return sendError(reply, 404, "NOT_FOUND", `No execution with id "${id}".`);
    const evs = events.listAllForSession(id);
    const peaks = computeRuntimePeaks(evs);

    const counts = new Map<string, number>();
    for (const ev of evs) counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1);
    const timeline = [...counts.entries()].map(([type, n]) => `- \`${type}\` × ${n}`).join("\n");
    const started = evs.find((e) => e.type === "process.started");
    const exited = evs.find((e) => e.type === "process.exited");
    const execError = evs.find((e) => e.type === "process.exec_error");
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
            `- Peak CPU utilization: ${peaks.peakCpuPercent === null ? "UNAVAILABLE (needs ≥2 valid samples)" : `${peaks.peakCpuPercent.value.toFixed(1)}% at ${peaks.peakCpuPercent.atTimeMs}ms`} (DERIVED from tick deltas)`,
            `- Total CPU time (user+system, final sample): ${peaks.cpuTimeMs === null ? "UNAVAILABLE" : `${(peaks.cpuTimeMs / 1000).toFixed(2)}s`}`,
          ]),
      "",
      "## Lifecycle observations",
      `- Process started: ${started ? `PID ${started.pid ?? "UNAVAILABLE"} at ${started.timestamp}` : "UNAVAILABLE"}`,
      `- Exec outcome: ${execError ? "EXEC_ERROR observed" : exited ? "ordinary process exit (exec success inferred)" : "UNAVAILABLE"}`,
      exited ? `- Process exited: exit \`${exited.payload.exitCode ?? "UNAVAILABLE"}\` at ${exited.timestamp}` : signalEv ? `- Signal received: \`${signalEv.payload.signal ?? "UNAVAILABLE"}\` at ${signalEv.timestamp}` : "UNAVAILABLE",
      "",
      "## Provenance",
      "- Process snapshots come from `/proc/<tracked-pid>/stat` and `status`; CPU utilization and CPU time are derived from kernel tick counters and the system clock-tick rate.",
      "- Event timestamps are gateway receive times, not kernel timestamps. Session duration uses the gateway clock; an engine monotonic duration may differ.",
      "- Missing values are UNAVAILABLE rather than filled with zero.",
      "",
      "## Limits of this report",
      "- stderr redirection and low-level `open()`/`dup2()`/`close()` events are unsupported.",
      "- Only the CAPS-owned child PID is sampled; arbitrary descendants are not discovered.",
      "- This is a summary of the persisted event store; it does not re-execute the command.",
    ].join("\n");

    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${id}-report.md"`);
    return reply.send(body);
  });

  // ------------------------------------------------------------ playground
  app.get("/api/playground/examples", async (_req, reply) => {
    return reply.send({ examples: playgroundExamples });
  });
}
