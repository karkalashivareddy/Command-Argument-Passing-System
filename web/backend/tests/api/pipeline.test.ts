/**
 * Pipeline evidence, end to end, through the real gateway and the real C engine.
 *
 * The property under test is that a multi-process execution is reconstructable
 * from the stored record alone. That matters because every downstream surface --
 * the flight recorder, the 2D timeline, the 3D Process Space -- reads the record
 * and never sees the live processes. If the record is ambiguous or lossy, every
 * one of those surfaces is quietly wrong.
 *
 * Concretely, for each pipeline this asserts:
 *   - the stage count matches what was asked for;
 *   - every stage has its own distinct PID (three stages are three processes,
 *     not one process described three times);
 *   - every stage shares one process group, so the pipeline is addressable as
 *     one unit;
 *   - each stage's start and exit agree on pid, stage, and pgid;
 *   - the record satisfies the structural invariants;
 *   - replay reproduces the same evidence with no re-execution.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import type { CanonicalEvent } from "../../src/types/observability.js";
import { validateEventStream } from "../../src/events/invariants.js";
import { engineAvailable, startTestServer, stopTestServer, TERMINAL } from "./harness.js";

const describeFx = engineAvailable ? describe : describe.skip;
void describeFx;

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"] as const;

let app: FastifyInstance;
let stop: () => void;

beforeAll(async () => {
  const started = await startTestServer();
  app = started.app;
  stop = () => stopTestServer(started);
});

afterAll(async () => {
  await app.close();
  if (stop !== undefined) stop();
});

interface PipelineRun {
  sessionId: string;
  status: string;
  stdout: string;
  events: CanonicalEvent[];
  stages: number;
  violations: Array<{ invariant: string; message: string }>;
}

/** Execute a command line through the terminal route and collect its evidence. */
async function runPipeline(commandLine: string): Promise<PipelineRun> {
  const posted = await app.inject({
    method: "POST",
    url: TERMINAL.execute,
    payload: { commandLine },
  });
  expect(posted.statusCode, posted.body).toBe(202);
  const sessionId = posted.json().sessionId as string;
  const stages = posted.json().stageCount as number;

  // Poll until terminal, exactly as a client would.
  //
  // The loop must continue while the status is *not* terminal, rather than while
  // it is specifically "RUNNING". A session is observable as CREATED and
  // STARTING before the runner reaches RUNNING, so a loop keyed on "RUNNING"
  // returns on its very first poll with a non-terminal status and then fails the
  // terminal-status assertion. That is a race against runner startup, not
  // anything about the pipeline: on a loaded CI runner the first poll landed
  // before the run began and reported CREATED.
  const isTerminal = (s: string): boolean => (TERMINAL_STATUSES as readonly string[]).includes(s);
  let status = "PENDING";
  for (let i = 0; i < 100 && !isTerminal(status); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const got = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    status = got.json().status as string;
  }
  expect(isTerminal(status), `session ${sessionId} never reached a terminal status (last: ${status})`).toBe(true);

  const record = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
  const replay = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/replay` });
  expect(replay.statusCode).toBe(200);
  const body = replay.json();
  return {
    sessionId,
    status,
    stdout: (record.json().stdout ?? "") as string,
    events: body.events as CanonicalEvent[],
    stages,
    violations: (body.integrity.violations ?? []) as Array<{ invariant: string; message: string }>,
  };
}

/** The per-stage lifecycle events for one stage index. */
function stageEvents(events: readonly CanonicalEvent[], type: CanonicalEvent["type"], stage: number): CanonicalEvent[] {
  return events.filter((e) => e.type === type && e.payload["stage"] === stage);
}

function starts(events: readonly CanonicalEvent[]): CanonicalEvent[] {
  return events.filter((e) => e.type === "process.started");
}

describeFx("a pipeline is recorded as real processes", () => {
  it("runs two stages and produces the counted result", async () => {
    const run = await runPipeline("seq 1 2000 | wc -l");
    expect(run.status).toBe("COMPLETED");
    expect(run.stages).toBe(2);
    // The number must be exact: any other value means bytes were lost or
    // duplicated crossing the pipe.
    expect(run.stdout.trim()).toBe("2000");
  });

  it("gives each stage its own PID", async () => {
    const run = await runPipeline("seq 1 5 | cat | cat | wc -l");
    expect(run.status).toBe("COMPLETED");
    expect(run.stages).toBe(4);
    expect(run.stdout.trim()).toBe("5");

    const pids = starts(run.events).map((e) => e.pid);
    expect(pids).toHaveLength(4);
    for (const pid of pids) expect(typeof pid).toBe("number");
    expect(new Set(pids).size, "each stage must be a distinct process").toBe(4);
  });

  it("puts every stage in one process group", async () => {
    const run = await runPipeline("seq 1 5 | cat | cat");
    const pgids = starts(run.events)
      .map((e) => e.payload["pgid"])
      .filter((v): v is number => typeof v === "number");
    expect(pgids).toHaveLength(3);
    // One group is what lets a timeout or a signal reach the whole pipeline
    // instead of orphaning an early stage.
    expect(new Set(pgids).size).toBe(1);
  });

  it("pairs each stage's start with its own exit", async () => {
    const run = await runPipeline("seq 1 10 | grep 1 | wc -l");
    expect(run.status).toBe("COMPLETED");

    for (let stage = 0; stage < 3; stage += 1) {
      const began = stageEvents(run.events, "process.started", stage);
      const ended = stageEvents(run.events, "process.exited", stage);
      expect(began, `stage ${stage} must have a start`).toHaveLength(1);
      expect(ended, `stage ${stage} must have an exit`).toHaveLength(1);
      // The pairing is what makes a stage's evidence self-contained: a reader
      // can pair start to exit with nothing but the two events.
      expect(ended[0]!.pid).toBe(began[0]!.pid);
      expect(ended[0]!.payload["pgid"]).toBe(began[0]!.payload["pgid"]);
    }
  });

  it("records the pipeline envelope", async () => {
    const run = await runPipeline("seq 1 5 | cat");
    expect(run.events.find((e) => e.type === "pipeline.parsed"), "parsed").toBeDefined();
    expect(run.events.find((e) => e.type === "pipeline.started"), "started").toBeDefined();
    const completed = run.events.find((e) => e.type === "pipeline.completed");
    expect(completed, "completed").toBeDefined();
    expect(completed!.payload["stages"]).toBe(2);
  });

  it("reports a single command as stage 0 of 1, with no sentinel", async () => {
    const run = await runPipeline("echo solo");
    expect(run.status).toBe("COMPLETED");
    expect(run.events.some((e) => e.type === "pipeline.started")).toBe(false);

    // A single command really is one process at stage 0 of one, which is what
    // --inspect reports too. There is no "not a pipeline" sentinel: the rule a
    // consumer needs is `0 <= stage < stages`, plus `stages > 1` to ask
    // whether there was a pipeline at all.
    const began = starts(run.events)[0]!;
    expect(began.payload["stage"]).toBe(0);
    expect(began.payload["stages"]).toBe(1);

    // Every process event agrees on the position. This is the assertion that
    // caught the engine reporting stage 0 on start and -1 on exit for the same
    // process, which made the exit look like an orphan.
    for (const e of run.events) {
      const stage = e.payload["stage"];
      const stages = e.payload["stages"];
      if (typeof stage !== "number" || typeof stages !== "number") continue;
      expect(stage, `${e.type} stage`).toBeGreaterThanOrEqual(0);
      expect(stage, `${e.type} stage`).toBeLessThan(stages);
    }
  });

  it("a single command's exit pairs with its own start", async () => {
    const run = await runPipeline("echo solo");
    const began = starts(run.events)[0]!;
    const ended = run.events.find((e) => e.type === "process.exited")!;
    expect(ended.pid).toBe(began.pid);
    expect(ended.payload["stage"]).toBe(began.payload["stage"]);
    // And the orphan-lifecycle invariant agrees, keyed on (pid, stage).
    expect(run.violations.map((v) => v.invariant)).not.toContain("I11-no-orphan-process-lifecycle");
  });

  it("a single command validates clean under the invariants", async () => {
    const run = await runPipeline("echo solo");
    const validated = validateEventStream(run.events);
    expect(validated.violations.filter((v) => v.severity === "error")).toEqual([]);
  });

  it("records a producer killed by SIGPIPE when the consumer exits early", async () => {
    // `seq`, not `yes`: an unbounded producer is refused by the catalog, which
    // is the correct answer for a product that caps output. This pipeline still
    // produces the same condition -- the consumer exits long before the producer
    // finishes, so the producer is terminated by SIGPIPE.
    const run = await runPipeline("seq 1 100000 | head -1");
    const signals = run.events.filter((e) => e.type === "signal.received");
    expect(signals.length, "the producer must be recorded as signalled").toBeGreaterThanOrEqual(1);
    // Stage 0 is the producer, and it is the one that receives SIGPIPE.
    expect(signals.some((s) => s.payload["stage"] === 0)).toBe(true);
  });
});

describeFx("pipeline records satisfy the structural invariants", () => {
  it("a two-stage pipeline validates clean", async () => {
    const run = await runPipeline("seq 1 20 | wc -l");
    const errors = run.violations.filter((v) => v.invariant !== undefined && /I\d/.test(v.invariant));
    expect(errors).toEqual([]);
    expect(validateEventStream(run.events).valid).toBe(true);
  });

  it("a three-stage pipeline validates clean", async () => {
    const run = await runPipeline("seq 10 100 | grep 0 | wc -l");
    expect(validateEventStream(run.events).valid).toBe(true);
  });

  it("a SIGPIPE pipeline validates clean", async () => {
    const run = await runPipeline("seq 1 100000 | head -1");
    const validated = validateEventStream(run.events);
    expect(validated.violations.filter((v) => v.severity === "error")).toEqual([]);
  });

  it("detects a pipeline that completed without accounting for every stage", async () => {
    // Asserted directly rather than through a real run, because a truncated
    // pipeline stream cannot be produced reliably on demand. The point is that
    // the invariant exists: if the envelope ever claims more stages than the
    // evidence covers, this catches it.
    const run = await runPipeline("seq 1 5 | cat");
    const truncated = run.events.filter(
      (e) => !(e.type === "process.exited" && e.payload["stage"] === 1),
    );
    const validated = validateEventStream(truncated, { sessionStatus: null });
    expect(
      validated.violations.map((v) => v.invariant),
      "I14 must fire when a declared stage has no exit",
    ).toContain("I14-pipeline-stages-accounted");
  });

  it("detects an event claiming a stage outside its own pipeline", async () => {
    const run = await runPipeline("seq 1 5 | cat");
    const tampered = run.events.map((e) =>
      e.type === "process.started" && e.payload["stage"] === 0 ? { ...e, payload: { ...e.payload, stage: 7 } } : e,
    );
    const validated = validateEventStream(tampered, { sessionStatus: null });
    expect(validated.violations.map((v) => v.invariant)).toContain("I14-pipeline-stages-accounted");
  });

  it("detects a stage lifecycle event whose start is missing for that pid and stage", async () => {
    // The (pid, stage) key is the point: an exit for a pid whose only start was
    // a different stage is an orphan even though the pid was seen.
    const run = await runPipeline("seq 1 5 | cat");
    const orphaned = run.events.map((e) =>
      e.type === "process.exited" && e.payload["stage"] === 1 ? { ...e, pid: 999_999 } : e,
    );
    const validated = validateEventStream(orphaned, { sessionStatus: null });
    expect(validated.violations.map((v) => v.invariant)).toContain("I11-no-orphan-process-lifecycle");
  });
});

describeFx("replay reconstructs a pipeline without re-executing it", () => {
  it("replay is identical to a second replay of the same session", async () => {
    const run = await runPipeline("seq 1 30 | grep 3 | wc -l");
    const a = await app.inject({ method: "GET", url: `/api/sessions/${run.sessionId}/replay` });
    const b = await app.inject({ method: "GET", url: `/api/sessions/${run.sessionId}/replay` });

    expect(b.statusCode).toBe(200);
    // Determinism is the property: identical input must yield an identical
    // record, so a reader can trust a replay as evidence rather than a summary.
    expect(JSON.stringify(b.json())).toBe(JSON.stringify(a.json()));
    expect(run.events.some((e) => e.type === "pipeline.completed")).toBe(true);
  });

  it("replaying a pipeline creates no new session", async () => {
    const run = await runPipeline("seq 1 100 | wc -l");
    const before = await app.inject({ method: "GET", url: "/api/sessions?limit=1" });
    const totalBefore = before.json().total as number;

    for (let i = 0; i < 3; i += 1) {
      const replayed = await app.inject({ method: "GET", url: `/api/sessions/${run.sessionId}/replay` });
      expect(replayed.statusCode).toBe(200);
    }

    const after = await app.inject({ method: "GET", url: "/api/sessions?limit=1" });
    expect(after.json().total).toBe(totalBefore);
  });

  it("the replayed stage PIDs match the live run exactly", async () => {
    const run = await runPipeline("seq 1 5 | cat | wc -l");
    const replayed = await app.inject({ method: "GET", url: `/api/sessions/${run.sessionId}/replay` });
    const replayPids = (replayed.json().events as CanonicalEvent[])
      .filter((e) => e.type === "process.started")
      .map((e) => e.pid);
    expect(replayPids).toEqual(starts(run.events).map((e) => e.pid));
  });
});

describeFx("the terminal refuses before anything executes", () => {
  it("refuses a shell, and the session count does not move", async () => {
    const before = await app.inject({ method: "GET", url: "/api/sessions?limit=1" });
    const totalBefore = before.json().total as number;

    const refused = await app.inject({
      method: "POST",
      url: TERMINAL.execute,
      payload: { commandLine: 'bash -c "touch /tmp/caps-should-not-exist"' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("TERMINAL_POLICY");

    const after = await app.inject({ method: "GET", url: "/api/sessions?limit=1" });
    expect(after.json().total, "a refused line must not create a session").toBe(totalBefore);
  });

  it("refuses a privilege tool in a later stage, not just the first", async () => {
    const refused = await app.inject({
      method: "POST",
      url: TERMINAL.execute,
      payload: { commandLine: "echo x | sudo id" },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.stageIndex).toBe(1);
  });

  it("reports the offending stage index for a mid-pipeline violation", async () => {
    const refused = await app.inject({
      method: "POST",
      url: TERMINAL.execute,
      payload: { commandLine: "echo a | /bin/echo b | echo c" },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.stageIndex).toBe(1);
  });

  it("refuses a syntax error with the engine's own reason", async () => {
    const refused = await app.inject({
      method: "POST",
      url: TERMINAL.execute,
      payload: { commandLine: "echo a | | cat" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe("TERMINAL_SYNTAX");
    // The reason comes from the engine's parser, not from the gateway guessing.
    expect(refused.json().error.message).toMatch(/empty stage/i);
  });
});

describe("the grammar endpoint documents what is accepted", () => {
  it("lists the supported operators and states what is not implemented", async () => {
    const res = await app.inject({ method: "GET", url: TERMINAL.grammar });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ops = (body.operators as Array<{ syntax: string }>).map((o) => o.syntax);
    for (const op of ["|", ">", ">>", "<", "2>", "2>>"]) {
      expect(ops, `operator ${op} must be documented`).toContain(op);
    }
    const notImplemented = (body.notImplemented as Array<{ syntax: string; reason: string }>).map((n) => n.syntax);
    // The product must state plainly what it does not do, so nobody assumes a
    // shell is underneath.
    const joined = notImplemented.join(" ");
    expect(joined).toContain("$(");
    expect(joined).toContain("&&");
    for (const entry of body.notImplemented as Array<{ reason: string }>) {
      expect(entry.reason.length, "an unsupported form needs a stated reason").toBeGreaterThan(0);
    }
    expect(body.pipelineSemantics.exitStatus).toMatch(/LAST stage/);
    expect(body.limits.maxStages).toBeGreaterThan(1);
  });
});

describe("the catalog endpoint exposes the same facts", () => {
  it("states availability and a reason for every command", async () => {
    const res = await app.inject({ method: "GET", url: "/api/catalog" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.commands.length).toBeGreaterThan(30);
    expect(body.summary.total).toBe(body.commands.length);
    // Every command states whether it is available here, and why -- including
    // the unavailable ones. Silence would read as "fine".
    for (const c of body.commands as Array<{ availability: string; reason: string }>) {
      expect(["AVAILABLE", "UNAVAILABLE", "BLOCKED"]).toContain(c.availability);
      expect(c.reason.length, `${c.availability} needs a reason`).toBeGreaterThan(0);
    }
  });

  it("names the commands that would make this a remote shell, with reasons", async () => {
    const res = await app.inject({ method: "GET", url: "/api/catalog" });
    const refused = (res.json().refusedByPolicy as Array<{ name: string; reason: string }>);
    for (const name of ["bash", "sh", "sudo", "rm", "chmod", "kill"]) {
      const entry = refused.find((r) => r.name === name);
      // Refused, not silently absent: an operator who types sudo deserves an
      // answer rather than a "command not found".
      expect(entry, `${name} must be named as refused`).toBeDefined();
      expect(entry!.reason.length).toBeGreaterThan(0);
    }
  });

  it("per-command help is generated from the registry", async () => {
    const res = await app.inject({ method: "GET", url: "/api/catalog/wc/help" });
    expect(res.statusCode).toBe(200);
    const help = res.json();
    expect(help.name).toBe("wc");
    expect(help.safeArguments.length).toBeGreaterThan(10);
    expect(help.securityRestrictions.length).toBeGreaterThan(3);
    // The help must not claim a command is available when it is not.
    expect(["AVAILABLE", "UNAVAILABLE"]).toContain(help.availability);
    expect(help.availabilityReason.length).toBeGreaterThan(0);
  });

  it("a command that is not in the catalog is refused, and the refusal is specific", async () => {
    const res = await app.inject({ method: "GET", url: "/api/catalog/nc" });
    expect(res.statusCode).toBe(404);
    // `nc` gets a named refusal rather than "unknown command", because an
    // operator who reaches for it deserves to be told why it is not here.
    expect(res.json().error.message).toContain('"nc"');
    expect(res.json().error.message).toMatch(/socket/i);
  });

  it("a wholly unknown name still gets an explanation", async () => {
    const res = await app.inject({ method: "GET", url: "/api/catalog/zzzznotacommand" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toContain("zzzznotacommand");
    expect(res.json().error.message.length).toBeGreaterThan(20);
  });
});
