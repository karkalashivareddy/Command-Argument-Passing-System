import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Repo-root detection: this file lives at <repo>/web/backend/src/config/env.ts.
 * Ascending four levels from the module directory reaches the repository root.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(HERE, "../../../..");

/**
 * Canonical product version.
 *
 * The C engine, the gateway, and both npm packages previously carried their
 * own version strings and had drifted apart (C said 0.1.0, everything else
 * said 1.0.0).  This is the single source of truth; the C engine's
 * CAPS_VERSION is generated from it at build time (see Makefile) and the npm
 * package versions are asserted against it in tests/unit/version.test.ts.
 */
export const PRODUCT_VERSION = "1.1.0";

/** Loopback literals that are the only acceptable local bind targets. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Host literals that are explicitly *not* loopback even though they look local. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*"]);

export type BindMode = "local" | "remote";

const envSchema = z.object({
  CAPS_BIND_MODE: z.enum(["local", "remote"]).default("local"),
  CAPS_HOST: z.string().min(1).max(255).default("127.0.0.1"),
  CAPS_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /**
   * Bearer token required on every request in remote mode.  Local mode
   * refuses a non-empty token so nobody believes they hardened a loopback
   * service with a token the service never checks.
   */
  CAPS_AUTH_TOKEN: z.string().min(32).max(512).optional(),
  CAPS_EXECUTABLE: z.string().optional().default(""),
  CAPS_DATABASE_PATH: z.string().optional().default(""),
  CAPS_WORKSPACE: z.string().optional().default(""),
  CAPS_MAX_CONCURRENT: z.coerce.number().int().min(1).max(64).default(4),
  CAPS_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  CAPS_MAX_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(120000),
  CAPS_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(64 * 1024),
  /**
   * Retention is explicit and never implicit.  0 means "keep everything" and
   * is a deliberate configuration, not an absence of one, so an operator who
   * wants an unbounded recorder has to say so.
   */
  CAPS_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
  CAPS_RETENTION_SWEEP_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
  /** Graceful window between SIGTERM and SIGKILL during shutdown and timeout. */
  CAPS_TERMINATE_GRACE_MS: z.coerce.number().int().min(0).max(60_000).default(2000),
  CAPS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type CapsConfig = {
  version: string;
  bindMode: BindMode;
  host: string;
  port: number;
  authToken: string | null;
  capsExecutable: string;
  databasePath: string;
  workspace: string;
  maxConcurrent: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
  retentionDays: number;
  retentionSweepMs: number;
  terminateGraceMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
};

/** True for a literal that only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (WILDCARD_HOSTS.has(h)) return false;
  if (LOOPBACK_HOSTS.has(h)) return true;
  // Any address in 127.0.0.0/8 is loopback by definition.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Cross-field validation.
 *
 * This exists because every individual field is individually valid while the
 * combination is not.  The dangerous combination is a non-loopback bind with
 * no authentication: that turns a personal observability tool into an
 * unauthenticated remote command-execution endpoint.  It is refused at
 * startup, not merely warned about at request time.
 */
function validate(env: z.infer<typeof envSchema>): void {
  const problems: string[] = [];

  if (env.CAPS_DEFAULT_TIMEOUT_MS > env.CAPS_MAX_TIMEOUT_MS) {
    problems.push(
      `CAPS_DEFAULT_TIMEOUT_MS (${env.CAPS_DEFAULT_TIMEOUT_MS}) exceeds CAPS_MAX_TIMEOUT_MS (${env.CAPS_MAX_TIMEOUT_MS})`,
    );
  }

  if (env.CAPS_BIND_MODE === "local") {
    if (!isLoopbackHost(env.CAPS_HOST)) {
      problems.push(
        `CAPS_BIND_MODE=local requires a loopback address, but CAPS_HOST="${env.CAPS_HOST}" is not loopback. ` +
          `Use 127.0.0.1 or ::1, or set CAPS_BIND_MODE=remote together with CAPS_AUTH_TOKEN.`,
      );
    }
    if (env.CAPS_AUTH_TOKEN !== undefined) {
      problems.push(
        "CAPS_AUTH_TOKEN is set while CAPS_BIND_MODE=local, where it would never be checked. " +
          "Remove it, or set CAPS_BIND_MODE=remote so it is actually enforced.",
      );
    }
  } else {
    if (env.CAPS_AUTH_TOKEN === undefined) {
      problems.push(
        "CAPS_BIND_MODE=remote requires CAPS_AUTH_TOKEN (at least 32 characters). " +
          "Remote mode exposes authenticated process execution on the network and refuses to start without a token.",
      );
    }
    if (isLoopbackHost(env.CAPS_HOST) && env.CAPS_AUTH_TOKEN === undefined) {
      problems.push("CAPS_BIND_MODE=remote with a loopback CAPS_HOST is a contradiction; use CAPS_BIND_MODE=local.");
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Unsafe or inconsistent CAPS configuration:\n  - ${problems.join("\n  - ")}\n` +
        "The gateway is refusing to start rather than running with a boundary it cannot enforce.",
    );
  }
}

export function loadConfig(): CapsConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const flat = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment configuration: ${JSON.stringify(flat)}`);
  }
  const env = parsed.data;
  validate(env);

  return {
    version: PRODUCT_VERSION,
    bindMode: env.CAPS_BIND_MODE,
    host: env.CAPS_HOST,
    port: env.CAPS_PORT,
    authToken: env.CAPS_AUTH_TOKEN ?? null,
    capsExecutable: env.CAPS_EXECUTABLE
      ? resolve(env.CAPS_EXECUTABLE)
      : resolve(repoRoot, "caps"),
    databasePath: env.CAPS_DATABASE_PATH
      ? resolve(env.CAPS_DATABASE_PATH)
      : resolve(repoRoot, "data", "caps-observatory.db"),
    workspace: env.CAPS_WORKSPACE
      ? resolve(env.CAPS_WORKSPACE)
      : resolve(repoRoot, "data", "work"),
    maxConcurrent: env.CAPS_MAX_CONCURRENT,
    defaultTimeoutMs: env.CAPS_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: env.CAPS_MAX_TIMEOUT_MS,
    maxOutputBytes: env.CAPS_MAX_OUTPUT_BYTES,
    retentionDays: env.CAPS_RETENTION_DAYS,
    retentionSweepMs: env.CAPS_RETENTION_SWEEP_MS,
    terminateGraceMs: env.CAPS_TERMINATE_GRACE_MS,
    logLevel: env.CAPS_LOG_LEVEL,
  };
}

/** Redact a token for logging: never log the value, only whether one exists. */
export function describeAuth(token: string | null): string {
  return token === null ? "none" : `bearer(${token.length} chars)`;
}

/** True when the path is inside the repository, used to avoid leaking paths. */
export function isInsideRepo(absPath: string): boolean {
  return isAbsolute(absPath) && resolve(absPath).startsWith(`${repoRoot}/`);
}
