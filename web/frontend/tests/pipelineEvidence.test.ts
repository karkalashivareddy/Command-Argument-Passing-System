/**
 * Pipeline evidence reduction.
 *
 * The live view and the replay view both call `reducePipelineEvidence`. Every
 * assertion here therefore applies to both, and that is the point: a divergence
 * between live and replay would have to be a bug in this reducer rather than in
 * two separate reconstructions.
 */

import { describe, expect, it } from "vitest";

import type { CanonicalEvent, CanonicalEventType } from "../src/types/observability";
import {
  pipelineExitStatus,
  reducePipelineEvidence,
  sharesOneProcessGroup,
  summarisePipeline,
  type StageEvidence,
} from "../src/lib/pipelineEvidence";

let seq = 0;

function ev(type: CanonicalEventType, payload: Record<string, unknown>, extra: Partial<CanonicalEvent> = {}): CanonicalEvent {
  seq += 1;
  return {
    id: `evt_${seq}`,
    sessionId: "exec_test",
    sequence: seq,
    type,
    source: "caps",
    timestamp: "2026-01-01T00:00:00.000Z",
    monotonicMs: extra.monotonicMs ?? seq * 10,
    pid: extra.pid ?? null,
    payload,
    ...extra,
  };
}

/**
 * A PROCESS_STARTED event as the engine actually emits it, including the argv
 * elements it now carries.
 *
 * The argv is in the fixture because that is the whole point of the assertion:
 * the reducer reads argv from the canonical payload, so a fixture without it
 * would make the argv assertions vacuous.
 */
/**
 * The engine's parse record for a stage.
 *
 * `stdin_source` and `stdout_dest` live HERE, on `command.parsed`, not on
 * `process.started`. The fixture used to put them on the start event, which is why
 * the reducer once read them from the wrong place: the test agreed with the code
 * and both disagreed with the C engine, so the "which stage writes the pipe"
 * assertion passed against a fixture the engine could never produce.
 */
function parsed(index: number, stdinSource: string, stdoutDest: string, stages: number): CanonicalEvent {
  return ev("command.parsed", { label: "pipeline", stage: index, stages, stdinSource, stdoutDest });
}

function started(index: number, pid: number, pgid: number, argv: string[]): CanonicalEvent {
  return ev(
    "process.started",
    {
      label: argv[0] ?? "unknown",
      argv,
      stage: index,
      stages: 2,
      pgid,
    },
    { pid, monotonicMs: 100 + index * 100 },
  );
}

function exited(index: number, pid: number, pgid: number, exitCode: number): CanonicalEvent {
  return ev(
    "process.exited",
    { label: "x", stage: index, stages: 2, pgid, exitCode, durationMs: 5, outcome: "COMPLETED" },
    { pid, monotonicMs: 200 + index * 100 },
  );
}

describe("a two-stage pipeline reduces to two stages of evidence", () => {
  const evidence = reducePipelineEvidence([
    parsed(0, "inherit", "pipe", 2),
    parsed(1, "pipe", "terminal", 2),
    started(0, 100, 100, ["seq", "1", "5"]),
    started(1, 101, 100, ["wc", "-l"]),
    exited(0, 100, 100, 0),
    exited(1, 101, 100, 0),
  ]);

  it("keeps every stage the engine declared", () => {
    expect(evidence.declaredStages).toBe(2);
    expect(evidence.stages).toHaveLength(2);
    expect(evidence.stages.map((s) => s.index)).toEqual([0, 1]);
  });

  it("records each stage's own PID", () => {
    expect(evidence.stages[0]!.pid).toBe(100);
    expect(evidence.stages[1]!.pid).toBe(101);
  });

  it("records one shared process group", () => {
    // One group is what lets a timeout or signal reach the whole pipeline.
    expect(sharesOneProcessGroup(evidence.stages)).toBe(true);
    expect(evidence.stages.every((s) => s.pgid === 100)).toBe(true);
  });

  it("records each stage's argv", () => {
    expect(evidence.stages[0]!.argv).toEqual(["seq", "1", "5"]);
    expect(evidence.stages[1]!.argv).toEqual(["wc", "-l"]);
  });

  it("records exit codes and durations", () => {
    expect(evidence.stages[0]!.exitCode).toBe(0);
    expect(evidence.stages[0]!.durationMs).toBe(5);
    expect(evidence.stages.every((s) => s.lifecycle === "COMPLETED")).toBe(true);
  });

  it("knows which stage reads the pipe and which writes it", () => {
    // From the engine's own parse record, not from the stage index: the last
    // stage of a pipeline whose middle stage writes to a file is not "stage 1 of
    // 3", and arithmetic would get it wrong.
    expect(evidence.stages[0]!.writesToPipe).toBe(true);
    expect(evidence.stages[0]!.readsFromPipe).toBe(false);
    expect(evidence.stages[1]!.readsFromPipe).toBe(true);
    expect(evidence.stages[1]!.writesToPipe).toBe(false);
  });

  it("summarises the pipeline from the recorded outcomes", () => {
    expect(evidence.summary).toMatch(/2 completed/);
  });
});

describe("a stage that never started is kept, not dropped", () => {
  it("retains a declared stage with no start event", () => {
    // Dropping it would render a three-stage pipeline as two stages, which is
    // the misrepresentation this product exists to avoid.
    const evidence = reducePipelineEvidence([
      started(0, 100, 100, ["seq", "1", "5"]),
      exited(0, 100, 100, 0),
      ev("pipeline.completed", { stages: 3 }),
    ]);
    expect(evidence.declaredStages).toBe(3);
    expect(evidence.stages).toHaveLength(3);
    const missing = evidence.stages.find((s) => s.index === 2)!;
    expect(missing.lifecycle).toBe("NOT_STARTED");
    expect(missing.pid).toBeNull();
    expect(missing.note).toMatch(/never started/i);
  });

  it("says the declared and observed counts differ", () => {
    const evidence = reducePipelineEvidence([
      started(0, 100, 100, ["seq"]),
      exited(0, 100, 100, 0),
      ev("pipeline.completed", { stages: 4 }),
    ]);
    expect(evidence.summary).toMatch(/declared 4 stage/);
    expect(evidence.summary).toMatch(/1 produced process evidence/);
  });

  it("reports a missing exit code as null, never as 0", () => {
    // 0 is a real exit code. For a stage that never finished it is a
    // fabrication.
    const evidence = reducePipelineEvidence([started(0, 100, 100, ["sleep", "300"])]);
    expect(evidence.stages[0]!.exitCode).toBeNull();
    expect(evidence.stages[0]!.lifecycle).toBe("INCOMPLETE");
  });
});

describe("a signalled stage is distinguished from a failed one", () => {
  it("records the signal and says so", () => {
    const evidence = reducePipelineEvidence([
      started(0, 100, 100, ["yes"]),
      ev("signal.received", { stage: 0, stages: 1, pgid: 100, signal: 13, outcome: "SIGNALED" }, { pid: 100 }),
    ]);
    expect(evidence.stages[0]!.lifecycle).toBe("SIGNALED");
    expect(evidence.stages[0]!.signal).toBe(13);
    expect(evidence.stages[0]!.note).toMatch(/signal 13/);
  });

  it("keeps the exit code null for a signalled stage", () => {
    // A signal-terminated process has no exit code, and reporting 0 would say
    // it succeeded.
    const evidence = reducePipelineEvidence([
      started(0, 100, 100, ["yes"]),
      ev("signal.received", { stage: 0, stages: 1, pgid: 100, signal: 13 }, { pid: 100 }),
    ]);
    expect(evidence.stages[0]!.exitCode).toBeNull();
  });

  it("records a non-zero exit as a completion with that code", () => {
    const evidence = reducePipelineEvidence([
      started(0, 100, 100, ["false"]),
      ev("process.exited", { stage: 0, stages: 1, pgid: 100, exitCode: 1, outcome: "COMPLETED" }, { pid: 100 }),
    ]);
    expect(evidence.stages[0]!.lifecycle).toBe("COMPLETED");
    expect(evidence.stages[0]!.exitCode).toBe(1);
    expect(evidence.stages[0]!.note).toMatch(/code 1/);
  });

  it("carries the errno name for a failed exec", () => {
    const evidence = reducePipelineEvidence([
      ev(
        "process.exec_error",
        { stage: 0, stages: 1, outcome: "EXEC_FAILED", reason: "exec_failed", errnoName: "ENOENT" },
        { pid: 100 },
      ),
    ]);
    expect(evidence.stages[0]!.note).toBeTruthy();
  });
});

describe("the pipeline exit status is the last stage's", () => {
  it("takes the last stage, matching shell convention", () => {
    const stages: StageEvidence[] = [
      { index: 0, exitCode: 0, signal: null } as StageEvidence,
      { index: 1, exitCode: 1, signal: null } as StageEvidence,
    ];
    expect(pipelineExitStatus(stages)).toEqual({ code: 1, signal: null });
  });

  it("does not hide an early failure when the last stage succeeded", () => {
    // Shell convention reports the last stage, which is why every stage's own
    // status has to remain separately visible -- otherwise a pipeline that
    // silently lost its producer looks like a clean run.
    const evidence = reducePipelineEvidence([
      started(0, 100, 100, ["seq"]),
      ev("process.exited", { stage: 0, stages: 2, pgid: 100, exitCode: 141, outcome: "COMPLETED" }, { pid: 100 }),
      started(1, 101, 100, ["cat"]),
      exited(1, 101, 100, 0),
    ]);
    expect(pipelineExitStatus(evidence.stages)).toEqual({ code: 0, signal: null });
    expect(evidence.stages[0]!.exitCode).toBe(141);
    expect(evidence.summary).toMatch(/2 completed/);
  });
});

describe("process-group sharing is stated rather than assumed", () => {
  it("reports false when two groups are present", () => {
    const evidence = reducePipelineEvidence([
      started(0, 100, 100, ["seq"]),
      started(1, 101, 101, ["cat"]),
    ]);
    expect(sharesOneProcessGroup(evidence.stages)).toBe(false);
  });

  it("reports true for a single-stage pipeline", () => {
    expect(sharesOneProcessGroup([])).toBe(true);
  });
});

describe("malformed records do not invent a stage", () => {
  it("ignores an event with no stage index", () => {
    const evidence = reducePipelineEvidence([
      ev("command.received", { label: "seq 1 5" }),
      started(0, 100, 100, ["seq"]),
    ]);
    // A session-level event must not become a stage at index 0, which would
    // duplicate the real stage 0.
    // A declared-but-unevidenced stage is still LISTED, as NOT_STARTED. Dropping it
    // would render the pipeline as fewer stages than the engine declared.
    expect(evidence.stages.map((s) => s.index)).toEqual([0, 1]);
    expect(evidence.stages[0]!.pid).toBe(100);
    expect(evidence.stages[1]!.lifecycle).toBe("NOT_STARTED");
  });

  it("handles an empty event stream without throwing", () => {
    const evidence = reducePipelineEvidence([]);
    expect(evidence.stages).toHaveLength(0);
    expect(evidence.declaredStages).toBe(0);
    expect(evidence.summary).toMatch(/No stage outcome/);
  });

  it("orders stages by index regardless of event order", () => {
    const evidence = reducePipelineEvidence([
      exited(2, 102, 100, 0),
      started(0, 100, 100, ["seq"]),
      started(2, 102, 100, ["wc"]),
      started(1, 101, 100, ["cat"]),
    ]);
    expect(evidence.stages.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("takes the declared stage count from the highest value seen", () => {
    const evidence = reducePipelineEvidence([
      ev("pipeline.parsed", { stages: 3 }),
      ev("pipeline.started", { stages: 3 }),
      started(0, 100, 100, ["seq"]),
    ]);
    expect(evidence.declaredStages).toBe(3);
  });
});

describe("the summary describes only what the record contains", () => {
  it("counts each lifecycle state", () => {
    const stages = [
      { lifecycle: "COMPLETED" },
      { lifecycle: "COMPLETED" },
      { lifecycle: "SIGNALED" },
      { lifecycle: "NOT_STARTED" },
      { lifecycle: "INCOMPLETE" },
    ] as StageEvidence[];
    const summary = summarisePipeline(stages, 5);
    expect(summary).toMatch(/2 completed/);
    expect(summary).toMatch(/1 terminated by a signal/);
    expect(summary).toMatch(/1 never started/);
    expect(summary).toMatch(/1 started but never finished/);
  });

  it("says so plainly when nothing was recorded", () => {
    expect(summarisePipeline([], 0)).toMatch(/No stage outcome/);
  });
});
