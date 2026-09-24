import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../../src/server.js";
import { repoRoot } from "../../src/config/env.js";

const CAPS_PATH = resolve(repoRoot, "caps");
const capsAvailable = process.platform === "linux" && existsSync(CAPS_PATH);

const describeFx = capsAvailable ? describe : describe.skip;
void describeFx;

interface SessJson {
  id: string;
  status: string;
  exitCode: number | null;
  signal: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  argv: string[];
}

async function waitFor(app: Awaited<ReturnType<typeof buildServer>>["app"], id: string, timeoutMs = 10_000): Promise<SessJson> {
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}` });
    const body = res.json() as SessJson;
    if (["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(body.status)) return body;
    if (Date.now() - start > timeoutMs) throw new Error(`execution did not finish (${body.status})`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describeFx("CAPS gateway API (real engine)", () => {
  const dbPath = `/tmp/caps-api-${process.pid}.db`;
  let app: Awaited<ReturnType<typeof buildServer>>["app"];

  beforeAll(async () => {
    const server = await buildServer({
      dbPath,
      config: {
        host: "127.0.0.1",
        port: 0,
        capsExecutable: CAPS_PATH,
        workspace: "/tmp/caps-api-work",
        maxConcurrent: 4,
        defaultTimeoutMs: 30_000,
        maxTimeoutMs: 120_000,
        maxOutputBytes: 64 * 1024,
      },
    });
    app = server.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports health with the real engine available", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.engine.available).toBe(true);
    expect(body.engine.path).toBe(CAPS_PATH);
  });

  it("reports capabilities", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities" });
    const body = res.json();
    expect(body.allowlist).toContain("echo");
    expect(body.limits.maxConcurrent).toBe(4);
  });

  it("executes echo and records the full flight", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { command: "echo", args: ["Hello", "Shiva"] },
    });
    expect(post.statusCode).toBe(202);
    const sid = post.json().sessionId as string;

    const sess = await waitFor(app, sid);
    expect(sess.status).toBe("COMPLETED");
    expect(sess.exitCode).toBe(0);
    expect(sess.stdout).toBe("Hello Shiva\n");

    const argv = await app.inject({ method: "GET", url: `/api/sessions/${sid}/argv` });
    expect(argv.json().argc).toBe(3);
    expect(argv.json().argv).toEqual(["echo", "Hello", "Shiva"]);

    const replay = await app.inject({ method: "GET", url: `/api/sessions/${sid}/replay` });
    const types = (replay.json().events as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain("execution.created");
    expect(types).toContain("command.received");
    expect(types).toContain("process.started");
    expect(types).toContain("process.exited");
    expect(types).toContain("session.summary");
    expect(types[types.length - 1]).toBe("execution.completed");
  });

  it("reports deterministic exit codes through sh", async () => {
    const post = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "sh", args: ["-c", "exit 7"] } });
    const sess = await waitFor(app, post.json().sessionId as string);
    expect(sess.status).toBe("COMPLETED"); // ran to completion with non-zero status
    expect(sess.isSuccess).toBe(false);
    expect(sess.exitCode).toBe(7);
    expect(sess.signal).toBeNull();
  });

  it("marks false as a completed but unsuccessful execution (exit 1)", async () => {
    const post = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "false" } });
    const sess = await waitFor(app, post.json().sessionId as string);
    expect(sess.exitCode).toBe(1);
    expect(sess.status).toBe("COMPLETED");
    expect(sess.isSuccess).toBe(false);
  });

  it("executes real redirection and records it", async () => {
    const target = "api-redir.txt";
    const post = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { command: "echo", args: ["via-redirect"], redirections: { out: target } },
    });
    const sid = post.json().sessionId as string;
    const sess = await waitFor(app, sid);
    expect(sess.status).toBe("COMPLETED");

    const replay = await app.inject({ method: "GET", url: `/api/sessions/${sid}/replay` });
    const types = (replay.json().events as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain("redirection.opened");

    const abs = `/tmp/caps-api-work/${target}`;
    expect(existsSync(abs)).toBe(true);
  });

  it("terminates a running execution with SIGINT (CANCELLED, 130)", async () => {
    const post = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "sleep", args: ["30"] } });
    const sid = post.json().sessionId as string;

    // Allow the child to spawn first.
    await new Promise((r) => setTimeout(r, 800));
    const term = await app.inject({ method: "POST", url: `/api/sessions/${sid}/terminate`, payload: { signal: "SIGINT" } });
    expect(term.statusCode).toBe(202);

    const sess = await waitFor(app, sid);
    expect(sess.status).toBe("CANCELLED");
    expect(sess.exitCode).toBe(130);
    expect(sess.signal).toBe(2);
  });

  it("times out long executions", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { command: "sleep", args: ["60"], timeoutMs: 1200 },
    });
    const sess = await waitFor(app, post.json().sessionId as string, 12_000);
    expect(sess.status).toBe("TIMED_OUT");
  });

  it("rejects commands off the allowlist", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "rm", args: ["-rf", "/"] } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("COMMAND_NOT_ALLOWED");
  });

  it("rejects redirection targets that escape the workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { command: "echo", args: ["x"], redirections: { out: "../escape" } },
    });
    expect(res.statusCode).toBe(422);
  });

  it("exposes history and analytics over persisted data", async () => {
    const list = await app.inject({ method: "GET", url: "/api/sessions?limit=50" });
    const listBody = list.json();
    expect(listBody.total).toBeGreaterThanOrEqual(6);

    const ana = await app.inject({ method: "GET", url: "/api/analytics/overview" });
    const a = ana.json();
    expect(a.totalExecutions).toBeGreaterThanOrEqual(6);
    expect(a.byExitCode["7"]).toBeGreaterThanOrEqual(1);
    expect(a.byExitCode["130"]).toBeGreaterThanOrEqual(1);
    expect(a.byCommand.sleep).toBeGreaterThanOrEqual(2);
  });
});