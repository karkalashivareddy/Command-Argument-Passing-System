/**
 * Shared setup for API suites that drive the real engine.
 *
 * Exists because a pipeline suite and the original session suite need the same
 * three things: the engine must be built, the database and workspace must be
 * throwaway, and the whole suite must SKIP rather than fail on a platform
 * without a Linux process model. Duplicating that preamble in two files is how
 * the two drift, and a suite that silently starts passing for the wrong reason
 * is worse than one that fails.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";
import { repoRoot } from "../../src/config/env.js";

export const CAPS_PATH = resolve(repoRoot, "caps");

/**
 * True only when a real CAPS binary exists.
 *
 * Every assertion in a suite guarded by this is a claim about the Linux
 * process model: fork, exec, pipes, waitpid. On a platform without those the
 * suite must skip, because a failing assertion there would say nothing about
 * the product.
 */
export const engineAvailable = process.platform === "linux" && existsSync(CAPS_PATH);

/**
 * The documented terminal API prefix, so a route rename fails these tests
 * rather than leaving them passing against a path nothing serves.
 */
export const TERMINAL = {
  validate: "/api/terminal/validate",
  execute: "/api/terminal/execute",
  grammar: "/api/terminal/grammar",
} as const;

export interface StartedServer {
  app: FastifyInstance;
  root: string;
}

/**
 * Build a server against a fresh temporary database and workspace.
 *
 * A real temporary directory rather than a fixed path, so two suites running
 * concurrently cannot see each other's sessions and a leftover directory from
 * an aborted run cannot make a later one pass for the wrong reason. The
 * workspace lives inside the same temporary root, so cleaning up removes the
 * database and every file a test wrote, with nothing outside the root touched.
 */
export async function startTestServer(): Promise<StartedServer> {
  const root = mkdtempSync(join(tmpdir(), "caps-api-"));
  const built = await buildServer({
    dbPath: join(root, "caps.db"),
    config: {
      host: "127.0.0.1",
      port: 0,
      capsExecutable: CAPS_PATH,
      workspace: join(root, "work"),
      maxConcurrent: 4,
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 120_000,
      maxOutputBytes: 64 * 1024,
    },
  });
  await built.app.ready();
  return { app: built.app, root };
}

/** Remove the temporary root created by `startTestServer`. */
export function stopTestServer(started: StartedServer): void {
  rmSync(started.root, { recursive: true, force: true });
}
