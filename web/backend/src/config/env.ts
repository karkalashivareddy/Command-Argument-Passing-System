import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Repo-root detection: this file lives at <repo>/web/backend/src/config/env.ts.
 * Ascending four levels from the module directory reaches the repository root.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(HERE, "../../../..");

const envSchema = z.object({
  CAPS_HOST: z.string().default("127.0.0.1"),
  CAPS_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CAPS_EXECUTABLE: z.string().optional().default(""),
  CAPS_DATABASE_PATH: z.string().optional().default(""),
  CAPS_WORKSPACE: z.string().optional().default(""),
  CAPS_MAX_CONCURRENT: z.coerce.number().int().min(1).max(64).default(4),
  CAPS_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  CAPS_MAX_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(120000),
  CAPS_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(64 * 1024),
  CAPS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type CapsConfig = {
  host: string;
  port: number;
  capsExecutable: string;
  databasePath: string;
  workspace: string;
  maxConcurrent: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
};

export function loadConfig(): CapsConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }
  const env = parsed.data;
  return {
    host: env.CAPS_HOST,
    port: env.CAPS_PORT,
    capsExecutable: env.CAPS_EXECUTABLE || resolve(repoRoot, "caps"),
    databasePath: env.CAPS_DATABASE_PATH || resolve(repoRoot, "data", "caps-observatory.db"),
    workspace: env.CAPS_WORKSPACE || resolve(repoRoot, "data", "work"),
    maxConcurrent: env.CAPS_MAX_CONCURRENT,
    defaultTimeoutMs: env.CAPS_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: env.CAPS_MAX_TIMEOUT_MS,
    maxOutputBytes: env.CAPS_MAX_OUTPUT_BYTES,
  };
}