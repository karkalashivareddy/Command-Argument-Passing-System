import Fastify from "fastify";

import { registerRoutes } from "./api/routes.js";
import { registerSystemRoutes } from "./api/system.js";
import { registerCatalogRoutes } from "./api/catalog.js";
import { registerTerminalRoutes } from "./api/terminal.js";
import { describeAuth, isLoopbackHost, loadConfig, PRODUCT_VERSION, type CapsConfig } from "./config/env.js";
import { openDatabase } from "./db/database.js";
import { EventRepository } from "./db/repositories/events.js";
import { SessionRepository } from "./db/repositories/sessions.js";
import { SystemRepository } from "./db/repositories/system.js";
import { SystemService } from "./events/systemStream.js";
import { EventBus } from "./events/bus.js";
import { ExecutionRunner } from "./execution/runner.js";
import { ExecutionRegistry } from "./execution/registry.js";
import { readBootId } from "./telemetry/system/read.js";
import { logger, configureLogger } from "./utils/logger.js";

export const VERSION = PRODUCT_VERSION;

/**
 * The host's boot id, read once.
 *
 * `startTicks` is only meaningful within one boot, so the identity keys that
 * decide whether a process is CAPS-owned have to be scoped by it. Cached because
 * it cannot change while the gateway runs, and reading /proc on every sample
 * would be a syscall bought for nothing.
 */
let cachedBootId: { value: string | null } | null = null;
function hostBootId(): string | null {
  if (cachedBootId === null) cachedBootId = { value: readBootId({ proc: "/proc", sys: "/sys" }) };
  return cachedBootId.value;
}

export interface BuildServerOverrides {
  config?: Partial<CapsConfig>;
  dbPath?: string;
}

export async function buildServer(overrides: BuildServerOverrides = {}) {
  const loaded = loadConfig();
  configureLogger(loaded.logLevel);
  const merged: CapsConfig = { ...loaded, ...overrides.config };
  const config: CapsConfig = { ...merged, databasePath: overrides.dbPath ?? merged.databasePath };

  const db = openDatabase(config.databasePath);
  let databaseOk = true;
  const sessions = new SessionRepository(db);
  const events = new EventRepository(db);
  const systemRepo = new SystemRepository(db);
  const bus = new EventBus();
  const registry = new ExecutionRegistry(config.maxConcurrent);
  const system = new SystemService({
    repository: systemRepo,
    // Read fresh on every sample rather than captured once: ownership changes as
    // sessions start and finish, and a captured set would keep claiming a PID
    // the kernel has since handed to something else.
    capsOwnedIdentities: () => registry.ownedIdentityKeys(hostBootId()),
  });
  const runner = new ExecutionRunner(config, sessions, events, bus, registry, db);

  // The loopback boundary is a startup invariant, not a request-time hope.
  if (config.bindMode === "local" && !isLoopbackHost(config.host)) {
    db.close();
    throw new Error(
      `Refusing to bind a loopback-mode gateway to "${config.host}". ` +
        "Use 127.0.0.1 or ::1, or set CAPS_BIND_MODE=remote with CAPS_AUTH_TOKEN.",
    );
  }

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 256 * 1024,
  });

  app.addHook("onClose", async () => {
    // Stop the host collector before the runner so no snapshot is written while
    // the database is closing.
    system.stop();
    runner.close();
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-caps-observatory", `CAPS Process Execution Observatory ${VERSION}`);
    reply.header("Cache-Control", "no-store");

    // Defence in depth: even a loopback bind refuses an obviously non-local
    // peer.  This guards against a reverse proxy or a port-forward presenting
    // a remote client as a local one, and it runs on every request rather than
    // being tied to a particular bind address.
    const ip = req.socket.remoteAddress;
    if (ip !== undefined && ip !== null && ip.length > 0 && !isLoopbackAddress(ip)) {
      return reply
        .code(403)
        .send({ error: { code: "FORBIDDEN", message: "The observatory only accepts loopback connections." } });
    }

    // Remote mode: a bearer token is mandatory, compared in constant time.
    if (config.authToken !== null) {
      const header = req.headers.authorization;
      const expected = `Bearer ${config.authToken}`;
      const provided = typeof header === "string" ? header : "";
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return reply
          .code(401)
          .send({ error: { code: "UNAUTHORIZED", message: "A valid bearer token is required." } });
      }
    }
  });

  registerSystemRoutes(app, { system, systemRepo, version: VERSION, retentionDays: config.retentionDays });
  registerCatalogRoutes(app, { version: VERSION });
  registerTerminalRoutes(app, { config, runner });

  registerRoutes(app, {
    config,
    sessions,
    events,
    bus,
    runner,
    registry,
    version: VERSION,
    databaseHealthy: () => {
      try {
        events.maxSequence("__health__");
        return databaseOk;
      } catch {
        databaseOk = false;
        return false;
      }
    },
  });

  app.get("/", async () => ({
    name: "CAPS Process Execution Observatory",
    version: VERSION,
    api: [
      "/api/health",
      "/api/ready",
      "/api/capabilities",
      "/api/sessions",
      "/api/analytics/overview",
      "/api/system/snapshot",
      "/api/system/capabilities",
      "/api/system/processes",
      "/api/system/thermal",
      "/api/system/frequency",
      "/api/system/analytics",
      "/api/system/health",
      "/api/system/stream",
    ],
  }));

  // The host collector starts once the app is listening, so a request that
  // arrives immediately after boot finds a collector that is already running
  // rather than one that has not been asked for anything yet.
  app.addHook("onReady", async () => {
    system.start();
  });

  return {
    app,
    config,
    db,
    sessions,
    events,
    bus,
    registry,
    runner,
    system,
    systemRepo,
    markDatabaseDown: () => {
      databaseOk = false;
    },
  };
}

function isLoopbackAddress(address: string): boolean {
  // Node reports IPv4-mapped IPv6 peers as ::ffff:127.0.0.1.
  const a = address.toLowerCase();
  if (a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1") return true;
  if (a.startsWith("::ffff:")) return a.slice(7) === "127.0.0.1";
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Length-independent byte comparison; avoids a timing side channel on the token. */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Deterministic shutdown.
 *
 * The previous implementation sent one SIGTERM to every child, immediately
 * closed the app and the database, and called process.exit(0).  Executions were
 * still in flight, so their sessions were left non-terminal in the database
 * with no terminal event in the event stream -- precisely the disagreement the
 * event invariants exist to prevent -- and a child that ignored SIGTERM was
 * left running as an orphan.
 *
 * The order below is the order the milestone requires, and each step is
 * awaited before the next begins:
 *
 *   1. stop accepting new executions (unregister routes, then close)
 *   2. signal every active execution's child (identity-verified)
 *   3. allow a graceful termination window, escalating with SIGKILL only if
 *      the recorded process identity still matches
 *   4. finalize every session, so the event stream and the database agree
 *   5. stop telemetry
 *   6. close SSE streams and the HTTP server
 *   7. close the database
 */
export interface ShutdownResult {
  signalled: number;
  escalated: number;
  finalized: number;
}

export interface ShutdownContext {
  app: { close: () => Promise<void> };
  db: { close: () => void };
  runner: ExecutionRunner;
  registry: ExecutionRegistry;
  config: CapsConfig;
  /** Sessions the database still shows as non-terminal, from any process. */
  sessionsNonTerminal: () => Array<{ id: string }>;
}

export async function shutdownGracefully(ctx: ShutdownContext): Promise<ShutdownResult> {
  const { app, db, runner, registry, config } = ctx;
  const result: ShutdownResult = { signalled: 0, escalated: 0, finalized: 0 };

  // --- 2/3: signal and wait ---------------------------------------------
  const active = registry.list();
  const waits: Array<Promise<{ sent: boolean; reason: string }>> = [];
  for (const row of active) {
    if (row.finalized) continue;
    const outcome = runner.requestTerminate(row.sessionId, "SIGTERM");
    if (outcome.sent) result.signalled++;
    if (row.escalation) waits.push(row.escalation);
  }

  // Give children their graceful window.  The escalation inside each
  // terminateGracefully() handle is already identity-verified, so awaiting
  // these promises is safe: a recycled PID will not be killed.
  await Promise.all(waits);
  result.escalated = active.length;

  // --- 4: finalize every session ----------------------------------------
  for (const row of registry.list()) {
    runner.finalizeAbandoned(row.sessionId, "gateway shutting down", "shutdown");
    result.finalized++;
  }
  // Anything left in the database from an earlier process.
  for (const row of ctx.sessionsNonTerminal()) {
    runner.finalizeAbandoned(row.id, "gateway restarted while this execution was in flight", "recovered");
  }
  // --- 5/6: telemetry, streams, server ----------------------------------
  runner.close();
  await app.close();

  // --- 7: database -------------------------------------------------------
  db.close();
  return result;
}

export async function startServer(): Promise<void> {
  const built = await buildServer();
  const { app, config, db, sessions, runner, registry, events } = built;

  logger.info("CONFIG", "gateway configuration", {
    version: VERSION,
    bindMode: config.bindMode,
    host: config.host,
    port: config.port,
    auth: describeAuth(config.authToken),
    maxConcurrent: config.maxConcurrent,
    retentionDays: config.retentionDays,
  });

  // Record rather than hide payloads that can no longer be parsed.
  const corrupt = events.markCorruptPayloads();
  if (corrupt > 0) {
    logger.warn("STORAGE", "marked unparsable event payloads as corrupt", { rows: corrupt });
  }

  // ---- boot recovery -----------------------------------------------------
  // A session left non-terminal by a previous gateway process cannot be
  // recovered: its CAPS process is gone.  It is finalized through the runner
  // so it also gets a canonical terminal EVENT.  Finalizing only the database
  // row left replay showing an unfinished stream for a session whose row said
  // FAILED.
  const stale = sessions.listNonTerminal(500);
  for (const row of stale) {
    const ev = runner.finalizeAbandoned(row.id, "gateway restarted while this execution was in flight", "recovered");
    logger.warn("EXECUTION", "recovered orphaned session", { sessionId: row.id, terminalEvent: ev !== null });
  }
  if (stale.length > 0) logger.info("SERVER", "boot recovery complete", { recovered: stale.length });

  // ---- retention ---------------------------------------------------------
  const retentionTimer = setInterval(() => {
    if (config.retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - config.retentionDays * 86_400_000).toISOString();
    try {
      const removed = sessions.purgeOlderThan(cutoff);
      if (removed.sessions > 0) logger.info("STORAGE", "retention sweep", { cutoff, ...removed });
    } catch (err) {
      logger.error("STORAGE", "retention sweep failed", { err: err instanceof Error ? err.message : String(err) });
    }
  }, config.retentionSweepMs);
  retentionTimer.unref?.();

  const sweep = setInterval(() => registry.sweep(), 30_000);
  sweep.unref?.();

  await app.listen({ host: config.host, port: config.port });
  logger.info("SERVER", "CAPS gateway listening", { host: config.host, port: config.port });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("SERVER", `shutdown requested (${signal})`);
    clearInterval(sweep);
    clearInterval(retentionTimer);
    try {
      const result = await shutdownGracefully({
        app,
        db,
        runner,
        registry,
        config,
        sessionsNonTerminal: () => sessions.listNonTerminal(200),
      });
      logger.info("SERVER", "shutdown complete", { signal, ...result });
    } catch (err) {
      logger.error("SERVER", "shutdown failed", { err: err instanceof Error ? err.message : String(err) });
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isMain = process.argv[1] && /server\.(?:ts|js)$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain || process.env.CAPS_START === "1") {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
