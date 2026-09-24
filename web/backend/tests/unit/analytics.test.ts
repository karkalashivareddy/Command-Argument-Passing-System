import { describe, expect, it } from "vitest";

import { computeAnalytics } from "../../src/analytics/service.js";
import { openDatabase } from "../../src/db/database.js";
import { SessionRepository } from "../../src/db/repositories/sessions.js";

function makeRepo(): SessionRepository {
  const db = openDatabase(":memory:");
  return new SessionRepository(db);
}

describe("computeAnalytics", () => {
  it("is empty-neutered (nulls), never fabricated, with no data", () => {
    const out = computeAnalytics(makeRepo());
    expect(out.totalExecutions).toBe(0);
    expect(out.avgDurationMs).toBeNull();
    expect(out.p50Ms).toBeNull();
    expect(out.byExitCode).toEqual({});
    expect(out.byDay).toEqual([]);
    expect(out.processTelemetry.averageRssBytes).toBeNull();
    expect(out.processTelemetry.averageCpuPercent).toBeNull();
    expect(out.processTelemetry.sampleCount).toBe(0);
  });

  it("aggregates real terminal sessions", () => {
    const repo = makeRepo();
    const mk = (id: string, command: string, status: "COMPLETED" | "FAILED" | "TIMED_OUT", exitCode: number | null, signal: number | null, redir = false) => {
      repo.create({ id, command, args: [], redirections: {}, timeoutMs: 30000, startedAt: "2026-01-01T10:00:00.000Z" });
      if (redir) repo.recordRedirection(id, "out", "o.txt", "O_WRONLY");
      repo.finalize(id, { status, exitCode, signal, isSuccess: status === "COMPLETED" && exitCode === 0, durationMs: exitCode === 0 ? 100 : 200, pid: 1, error: null });
    };
    mk("a", "echo", "COMPLETED", 0, null, true);
    mk("b", "echo", "COMPLETED", 0, null);
    mk("c", "false", "FAILED", 1, null);
    mk("d", "sleep", "TIMED_OUT", null, 15);
    mk("e", "sleep", "FAILED", 130, 2);

    const out = computeAnalytics(repo);
    expect(out.totalExecutions).toBe(5);
    expect(out.successful).toBe(2);
    expect(out.failed).toBe(3); // status != COMPLETED or exit != 0
    expect(out.signalled).toBe(2);
    expect(out.byExitCode).toEqual({ "0": 2, "1": 1, "130": 1 });
    expect(out.bySignal).toEqual({ "2": 1, "15": 1 });
    expect(out.byCommand).toEqual({ sleep: 2, echo: 2, false: 1 });
    expect(out.redirectionUsage.out).toBe(1);
    expect(out.avgDurationMs).not.toBeNull();
    expect(out.p50Ms).not.toBeNull();
    expect(out.byDay[0]?.count).toBe(5);
    expect(out.byDay[0]?.success).toBe(2);
  });

  it("aggregates only persisted procfs snapshots with truthful sample counts", () => {
    const db = openDatabase(":memory:");
    const repo = new SessionRepository(db);
    for (const id of ["telemetry-a", "telemetry-b"]) {
      repo.create({ id, command: "sleep", args: ["1"], redirections: {}, timeoutMs: 30000, startedAt: "2026-01-01T10:00:00.000Z" });
      repo.finalize(id, { status: "COMPLETED", exitCode: 0, signal: null, isSuccess: true, durationMs: 1000, pid: 100, error: null });
    }
    const insert = db.prepare("INSERT INTO events (id, session_id, sequence, type, source, timestamp, monotonic_ms, pid, payload) VALUES (?, ?, ?, 'process.snapshot', 'gateway', ?, NULL, 100, ?)");
    const makeSnapshot = (rss: number, user: number, system: number, cpu: number) => JSON.stringify({
      rssBytes: { value: rss, provenance: "OBSERVED", source: "/proc/100/status" },
      cpuUserMs: { value: user, provenance: "DERIVED", source: "/proc/100/stat" },
      cpuSystemMs: { value: system, provenance: "DERIVED", source: "/proc/100/stat" },
      cpuPercent: { value: cpu, provenance: "DERIVED", source: "sample delta" },
    });
    insert.run("snapshot-a1", "telemetry-a", 0, "2026-01-01T10:00:00.100Z", makeSnapshot(100, 10, 5, 1));
    insert.run("snapshot-a2", "telemetry-a", 1, "2026-01-01T10:00:00.600Z", makeSnapshot(200, 20, 10, 2));
    insert.run("snapshot-b1", "telemetry-b", 0, "2026-01-01T10:00:00.100Z", makeSnapshot(300, 30, 10, 3));
    insert.run("snapshot-b2", "telemetry-b", 1, "2026-01-01T10:00:00.600Z", makeSnapshot(400, 50, 15, 4));

    const out = computeAnalytics(repo);
    expect(out.processTelemetry).toMatchObject({
      sampleCount: 4,
      executionsSampled: 2,
      averageRssBytes: 250,
      maxRssBytes: 400,
      rssSamples: 4,
      averageCpuTimeMs: 47.5,
      cpuTimeExecutions: 2,
      averageCpuPercent: 2.5,
      cpuPercentSamples: 4,
    });
    db.close();
  });
});
