import Fastify from "fastify";

import { registerRoutes } from "./api/routes.js";
import { loadConfig, type CapsConfig } from "./config/env.js";
import { openDatabase } from "./db/database.js";
import { EventRepository } from "./db/repositories/events.js";
import { SessionRepository } from "./db/repositories/sessions.js";
import { EventBus } from "./events/bus.js";
import { ExecutionRunner } from "./execution/runner.js";
import { ExecutionRegistry } from "./execution/registry.js";
import { logger } from "./utils/logger.js";

export const VERSION = "1.0.0";

export async function buildServer(overrides: { config?: Partial<ReturnType<typeof loadConfig>>; dbPath?: string } = {}) {
  const loaded = loadConfig();
  const merged = { ...loaded, ...overrides.config };
  const config: CapsConfig = { ...merged, databasePath: overrides.dbPath ?? merged.databasePath };

  const db = openDatabase(config.databasePath);
  const sessions = new SessionRepository(db);
  const events = new EventRepository(db);
  const bus = new EventBus();
  const registry = new ExecutionRegistry(config.maxConcurrent);
  const runner = new ExecutionRunner(config, sessions, events, bus, registry);

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 256 * 1024,
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-caps-observatory", "CAPS Process Execution Observatory");
    reply.header("Cache-Control", "no-store");
    if (req.socket.remoteAddress && config.host === "127.0.0.1") {
      // localhost-only intent; refuse obviously non-loopback peers despite
      // the bind being loopback (defense in depth against forward proxies).
      const ip = req.socket.remoteAddress;
      if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Observatory only accepts loopback connections." } });
      }
    }
  });

  registerRoutes(app, { config, sessions, events, bus, runner, registry, version: VERSION });

  app.get("/", async () => ({
    name: "CAPS Process Execution Observatory",
    version: VERSION,
    api: ["/api/health", "/api/capabilities", "/api/sessions", "/api/analytics/overview"],
  }));

  return { app, config, db, sessions, events, bus, registry, runner };
}

export async function startServer(): Promise<void> {
  const { app, config, db, sessions, registry, runner } = await buildServer();

  // Boot sweep: executions left non-terminal by a previous gateway crash
  // cannot be recovered (their CAPS process is gone) — record that honestly.
  const stuck = sessions.list(500, 0).filter((s) => ["CREATED", "STARTING", "RUNNING"].includes(s.status));
  for (const s of stuck) {
    sessions.finalize(s.id, {
      status: "FAILED",
      exitCode: null,
      signal: null,
      isSuccess: false,
      durationMs: null,
      pid: null,
      error: "gateway restarted while this execution was in flight",
    });
    logger.warn("EXECUTION", "recovered orphaned session", { sessionId: s.id });
  }
  void registry;

  // Defensive timer for malformed states.
  const sweep = setInterval(() => registry.sweep(), 30_000);
  sweep.unref?.();

  await app.listen({ host: config.host, port: config.port });
  logger.info("SERVER", "CAPS gateway listening", { host: config.host, port: config.port, caps: config.capsExecutable, workspace: config.workspace });

  const shutdown = async (signal: string) => {
    logger.info("SERVER", `shutdown (${signal})`);
    clearInterval(sweep);
    for (const row of registry.listProcesses()) {
      logger.warn("EXECUTION", "terminating child on shutdown", { sessionId: row.sessionId, pid: row.pid });
      try {
        process.kill(row.pid!, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  void runner;
}

const isMain = process.argv[1] && /server\.ts$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain || process.env.CAPS_START === "1") {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
