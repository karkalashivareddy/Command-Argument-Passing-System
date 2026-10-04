import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../../src/server.js";
import { repoRoot } from "../../src/config/env.js";

/**
 * Where stderr redirection is available is a per-route fact, and publishing one
 * global flag got it wrong in both directions.
 *
 * `GET /api/capabilities` used to answer `redirection.stderr: false`. That is
 * true of `POST /api/sessions`, whose body schema is a strict object of
 * in/out/append, and false of the product: `POST /api/terminal/execute` accepts
 * `2>` and `2>>`, the grammar publishes them, and the engine implements them
 * (CAPS_REDIR_ERR_OUT / _APPEND, opened O_WRONLY|O_CREAT|O_NOFOLLOW). A reader
 * who trusted the flag would conclude the capability was absent.
 *
 * These tests hold the capability response to what the routes actually do, so
 * the flag cannot drift away from the behaviour again.
 */

const CAPS_PATH = resolve(repoRoot, "caps");
const WORK = "/tmp/caps-redir-work";
const capsAvailable = process.platform === "linux" && existsSync(CAPS_PATH);
const describeFx = capsAvailable ? describe : describe.skip;

describeFx("stderr redirection capability", () => {
  let app: Awaited<ReturnType<typeof buildServer>>["app"];

  beforeAll(async () => {
    mkdirSync(WORK, { recursive: true });
    const server = await buildServer({
      dbPath: `/tmp/caps-redir-${process.pid}.db`,
      config: {
        host: "127.0.0.1",
        port: 0,
        capsExecutable: CAPS_PATH,
        workspace: WORK,
        maxConcurrent: 4,
        defaultTimeoutMs: 30_000,
        maxTimeoutMs: 120_000,
        maxOutputBytes: 64 * 1024,
      },
    });
    app = server.app;
    await app.ready();
  });

  afterAll(() => {
    rmSync(WORK, { recursive: true, force: true });
  });

  it("reports the route split instead of one global flag", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities" });
    const redirection = res.json().redirection as {
      stderr: boolean;
      stderrByRoute: Record<string, boolean>;
      modes: string[];
    };
    expect(redirection.stderr).toBe(true);
    expect(redirection.stderrByRoute["/api/sessions"]).toBe(false);
    expect(redirection.stderrByRoute["/api/terminal/execute"]).toBe(true);
    // The session route's own modes, which are the three it really accepts.
    expect(redirection.modes).toEqual(["in", "out", "append"]);
  });

  it("the terminal route accepts 2>, and the sessions route refuses a stderr slot", async () => {
    const term = await app.inject({
      method: "POST",
      url: "/api/terminal/execute",
      payload: { commandLine: "status_probe print boom 2> redir.err" },
    });
    expect(term.statusCode).toBe(202);

    const sess = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { command: "status_probe", args: ["print", "boom"], redirections: { stderr: "x.err" } },
    });
    // 400, not a silently ignored field: a redirection the caller asked for and
    // did not get must not be reported as applied.
    expect(sess.statusCode).toBe(400);
    expect(sess.json().error.message).toMatch(/stderr/);
  });

  it("uses the error codes docs/web-api.md documents", async () => {
    const syntax = await app.inject({ method: "POST", url: "/api/terminal/execute", payload: { commandLine: "echo |" } });
    expect(syntax.statusCode).toBe(400);
    expect(syntax.json().error.code).toBe("TERMINAL_SYNTAX");

    const policy = await app.inject({
      method: "POST",
      url: "/api/terminal/execute",
      payload: { commandLine: "echo x | sudo rm /tmp/y" },
    });
    expect(policy.statusCode).toBe(403);
    expect(policy.json().error.code).toBe("TERMINAL_POLICY");

    const grammar = await app.inject({ method: "GET", url: "/api/terminal/grammar" });
    expect(grammar.statusCode).toBe(200);
  });
});
