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
import { computeAnalytics } from "../analytics/service.js";
import {
  allowedCommands,
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
      for (const slot of ["in", "out", "append"] as const) {
        const target = body.redirections?.[slot];
        if (target) {
          assertTargetInWorkspace(config, target);
        }
      }
    } catch (err) {
      if (err instanceof RedirectionPolicyError) {
        return sendError(reply, 422, "REDIRECTION_REJECTED", err.message, rid);
      }
      return sendError(reply, 422, "REDIRECTION_REJECTED", "Redirection target rejected.", rid);
    }

    const result = runner.start({
      command: body.command,
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
    return reply.send({ processes: registry.listProcesses(), capacity: config.maxConcurrent });
  });

  // ------------------------------------------------------------- analytics
  app.get("/api/analytics/overview", async (_req, reply) => {
    return reply.send(computeAnalytics(sessions));
  });

  // ------------------------------------------------------------ playground
  app.get("/api/playground/examples", async (_req, reply) => {
    return reply.send({ examples: playgroundExamples });
  });
}
