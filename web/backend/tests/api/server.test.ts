import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
    expect(body.telemetry.enabled).toBe(true);
    expect(body.telemetry.intervalMs).toBe(500);
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

  it("reports deterministic exit codes through the fixed status probe", async () => {
    const post = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "status_probe", args: ["exit", "7"] } });
    const sess = await waitFor(app, post.json().sessionId as string);
    expect(sess.status).toBe("COMPLETED"); // ran to completion with non-zero status
    expect(sess.isSuccess).toBe(false);
    expect(sess.exitCode).toBe(7);
    expect(sess.signal).toBeNull();
  });

  it("preserves a real program exit 127 through persistence, replay, and SSE", async () => {
    const post = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "status_probe", args: ["exit", "127"] } });
    expect(post.statusCode).toBe(202);
    const sid = post.json().sessionId as string;
    const sess = await waitFor(app, sid);
    expect(sess.status).toBe("COMPLETED");
    expect(sess.exitCode).toBe(127);

    const replay = await app.inject({ method: "GET", url: `/api/sessions/${sid}/replay` });
    const events = replay.json().events as Array<{ sequence: number; type: string; payload: Record<string, unknown> }>;
    expect(events.map((event) => event.type)).toContain("process.started");
    expect(events.map((event) => event.type)).toContain("process.exited");
    expect(events.some((event) => event.type === "process.exec_error")).toBe(false);
    expect(events.find((event) => event.type === "process.exited")?.payload.exitCode).toBe(127);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, i) => i));

    const stream = await app.inject({ method: "GET", url: `/api/sessions/${sid}/events` });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain("event: execution.received");
    expect(stream.body).toContain('"type":"process.exited"');
    expect(stream.body).toContain('"exitCode":127');

    const resumed = await app.inject({ method: "GET", url: `/api/sessions/${sid}/events`, headers: { "last-event-id": "3" } });
    const resumedIds = [...resumed.body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    const expectedResumedIds = [...events.filter((event) => event.sequence > 3).map((event) => event.sequence), Number.MAX_SAFE_INTEGER];
    expect(resumedIds).toEqual(expectedResumedIds);
    expect(new Set(resumedIds).size).toBe(resumedIds.length);
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
    expect(readFileSync(abs, "utf8")).toBe("via-redirect\n");
  });

  it("appends to an existing file and redirects stdin from the same workspace file", async () => {
    const target = `api-redir-flow-${process.pid}.txt`;
    const run = async (payload: Record<string, unknown>) => {
      const post = await app.inject({ method: "POST", url: "/api/sessions", payload });
      expect(post.statusCode).toBe(202);
      return waitFor(app, post.json().sessionId as string);
    };

    expect((await run({ command: "echo", args: ["first"], redirections: { out: target } })).status).toBe("COMPLETED");
    expect((await run({ command: "echo", args: ["second"], redirections: { append: target } })).status).toBe("COMPLETED");
    const read = await run({ command: "cat", redirections: { in: target } });
    expect(read.stdout).toBe("first\nsecond\n");
    expect(read.exitCode).toBe(0);
    expect(read.stderr).toContain('"event":"REDIRECTION_OPENED"');
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

  it("samples procfs only for the CAPS-owned PID and persists the snapshot as a replayable event", async () => {
    const post = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "sleep", args: ["5"] } });
    expect(post.statusCode).toBe(202);
    const sid = post.json().sessionId as string;
    const processStarted = Date.now();
    let active = (await app.inject({ method: "GET", url: "/api/processes" })).json().processes.find((p: { sessionId: string }) => p.sessionId === sid);
    for (let attempt = 0; attempt < 12 && (!active || !active.telemetry); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      active = (await app.inject({ method: "GET", url: "/api/processes" })).json().processes.find((p: { sessionId: string }) => p.sessionId === sid);
    }
    expect(active).toBeDefined();
    expect(active.pid).toEqual(expect.any(Number));
    expect(active.telemetry.pid).toMatchObject({ value: active.pid, provenance: "OBSERVED" });
    expect(active.telemetry.ppid.value).toBeGreaterThan(0);
    expect(active.telemetry.capsEnginePid.value).toBeGreaterThan(0);
    expect(active.telemetry.ppid.value).toBe(active.telemetry.capsEnginePid.value);
    expect(active.telemetry.processGroupId.value).toBeGreaterThan(0);
    expect(active.telemetry.sessionId.value).toBeGreaterThan(0);
    expect(active.telemetry.state.value).toMatch(/^[A-Za-z]$/);
    expect(active.telemetry.rssBytes.value).toEqual(expect.any(Number));
    expect(active.telemetry.rssBytes.provenance).toBe("OBSERVED");
    expect(active.telemetry.elapsedMs.value).toEqual(expect.any(Number));
    expect(active.telemetry.elapsedMs.provenance).toBe("DERIVED");
    expect(Date.now() - processStarted).toBeLessThan(1500);

    await new Promise((resolve) => setTimeout(resolve, 600));
    const replayBeforeExit = await app.inject({ method: "GET", url: `/api/sessions/${sid}/replay` });
    const recordedBeforeExit = replayBeforeExit.json().events as Array<{ type: string; pid: number | null; payload: Record<string, any> }>;
    const snapshots = recordedBeforeExit.filter((event) => event.type === "process.snapshot");
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots.every((event) => event.pid === active.pid)).toBe(true);
    expect(recordedBeforeExit.findIndex((event) => event.type === "process.started")).toBeLessThan(recordedBeforeExit.findIndex((event) => event.type === "process.snapshot"));

    await app.inject({ method: "POST", url: `/api/sessions/${sid}/terminate`, payload: { signal: "SIGINT" } });
    expect((await waitFor(app, sid)).status).toBe("CANCELLED");
    const finalReplay = await app.inject({ method: "GET", url: `/api/sessions/${sid}/replay` });
    const finalEvents = finalReplay.json().events as Array<{ type: string }>;
    const countAfterExit = finalEvents.filter((event) => event.type === "process.snapshot").length;
    await new Promise((resolve) => setTimeout(resolve, 650));
    const laterReplay = await app.inject({ method: "GET", url: `/api/sessions/${sid}/replay` });
    expect((laterReplay.json().events as Array<{ type: string }>).filter((event) => event.type === "process.snapshot")).toHaveLength(countAfterExit);
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

  it("rejects a nonexistent web executable before starting CAPS", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "definitely-not-a-real-executable" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("COMMAND_NOT_ALLOWED");
  });

  it("rejects an empty command as invalid input", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ARGUMENT");
  });

  it("rejects unsupported stderr redirection instead of silently dropping it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { command: "echo", args: ["x"], redirections: { err: "stderr.txt" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("bounds captured output to the configured limit", async () => {
    const args = Array.from({ length: 20 }, () => "x".repeat(4000));
    const post = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "echo", args } });
    expect(post.statusCode).toBe(202);
    const session = await waitFor(app, post.json().sessionId as string);
    expect(session.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(session.stdout.length).toBeGreaterThan(60 * 1024);
  });

  it("enforces the concurrent execution limit", async () => {
    const starts = await Promise.all(Array.from({ length: 4 }, () =>
      app.inject({ method: "POST", url: "/api/sessions", payload: { command: "sleep", args: ["30"] } }),
    ));
    expect(starts.every((response) => response.statusCode === 202)).toBe(true);
    const ids = starts.map((response) => response.json().sessionId as string);
    const overLimit = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "sleep", args: ["30"] } });
    expect(overLimit.statusCode).toBe(429);
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      for (const id of ids) await app.inject({ method: "POST", url: `/api/sessions/${id}/terminate`, payload: { signal: "SIGINT" } });
      for (const id of ids) expect((await waitFor(app, id)).status).toBe("CANCELLED");
    } finally {
      for (const id of ids) await app.inject({ method: "POST", url: `/api/sessions/${id}/terminate`, payload: { signal: "SIGKILL" } });
    }
  });

  it("rejects shell commands that could bypass the executable allowlist", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "sh", args: ["-c", "echo unsafe"] } });
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

  it("rejects a workspace symlink that points outside the workspace", async () => {
    const outside = `/tmp/caps-api-outside-${process.pid}.txt`;
    const link = `/tmp/caps-api-work/api-symlink-${process.pid}.txt`;
    writeFileSync(outside, "protected");
    symlinkSync(outside, link);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { command: "echo", args: ["escape"], redirections: { out: `api-symlink-${process.pid}.txt` } },
      });
      expect(res.statusCode).toBe(422);
      expect(readFileSync(outside, "utf8")).toBe("protected");
    } finally {
      unlinkSync(link);
      unlinkSync(outside);
    }
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

  it("exports a session as JSON with its persisted telemetry", async () => {
    const post = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "sleep", args: ["1"] } });
    const sid = post.json().sessionId as string;
    await waitFor(app, sid);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sid}/export?format=json` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.json();
    expect(body.session.id).toBe(sid);
    expect(body.generator).toBe("caps-observatory");
    expect(body.events.length).toBeGreaterThanOrEqual(4);
    expect(body.events.some((e: { type: string }) => e.type === "process.snapshot")).toBe(true);
    expect(body.telemetry.sampleCount).toBe(body.events.filter((e: { type: string }) => e.type === "process.snapshot").length);
    expect(body.telemetry.peakRssBytes).not.toBeNull();
    expect(body.session.eventCount).toBe(body.events.length);
  });

  it("exports a session as CSV with a header and payload_json escaping", async () => {
    const post = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "echo", args: ["Export, me"] } });
    const sid = post.json().sessionId as string;
    await waitFor(app, sid);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sid}/export?format=csv` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\n");
    expect(lines[0]).toBe("sequence,type,source,timestamp,monotonic_ms,pid,payload_json");
    expect(lines.length).toBeGreaterThan(1);
    expect(res.body).toContain("session.summary");
    const row = lines.find((l: string) => l.includes("command.received"));
    expect(row).toBeTruthy();
    expect(row).toContain('""echo Export, me""'); // inner quotes are doubled per RFC 4180
  });

  it("produces a markdown observation report over persisted data", async () => {
    const post = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "echo", args: ["report-me"], redirections: { out: "api-report.txt" } } });
    const sid = post.json().sessionId as string;
    await waitFor(app, sid);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sid}/report` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.body).toContain("# CAPS Observation Report");
    expect(res.body).toContain(`\`${sid}\``);
    expect(res.body).toContain("## Event timeline");
    expect(res.body).toContain("## Process resources (observed)");
    expect(res.body).toContain("redirection.opened");
    expect(res.body).toContain("UNAVAILABLE");
  });

  it("reports command profiles over the persisted store", async () => {
    const res = await app.inject({ method: "GET", url: "/api/analytics/commands" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.commands)).toBe(true);
    const echo = body.commands.find((c: { command: string }) => c.command === "echo");
    const sleep = body.commands.find((c: { command: string }) => c.command === "sleep");
    expect(echo.runs).toBeGreaterThanOrEqual(1);
    expect(echo.successRate).toBe(100);
    expect(sleep.runs).toBeGreaterThanOrEqual(2);
    expect(sleep.rssSamples).toBeGreaterThanOrEqual(2);
    expect(sleep.medianRssBytes).not.toBeNull();
    expect(sleep.p95DurationMs).not.toBeNull();
  });

  it("compares two sessions with persisted facts and null-safe deltas", async () => {
    const echoA = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "echo", args: ["alpha"] } });
    const echoB = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "echo", args: ["beta"], redirections: { out: "api-cmp.txt" } } });
    const idA = echoA.json().sessionId as string;
    const idB = echoB.json().sessionId as string;
    await waitFor(app, idA);
    await waitFor(app, idB);

    const res = await app.inject({ method: "GET", url: `/api/analytics/compare?ids=${idA},${idB}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.left.sessionId).toBe(idA);
    expect(body.right.sessionId).toBe(idB);
    expect(body.shared.sameCommand).toBe(true);
    expect(body.shared.command).toBe("echo");
    expect(body.left.status).toBe("COMPLETED");
    expect(typeof body.deltas.eventDelta).toBe("number");
    expect(body.deltas.durationMs).not.toBeNull();
  });

  it("rejects a malformed compare request and a missing session", async () => {
    const bad = await app.inject({ method: "GET", url: "/api/analytics/compare?ids=only-one" });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: "GET", url: "/api/analytics/compare?ids=does-not-exist,does-not-exist-either" });
    expect(missing.statusCode).toBe(404);
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { command: "true", args: [] } });
    const selfId = created.json().sessionId as string;
    await waitFor(app, selfId);
    const self = await app.inject({ method: "GET", url: `/api/analytics/compare?ids=${selfId},${selfId}` });
    expect(self.statusCode).toBe(400);
  });
});
