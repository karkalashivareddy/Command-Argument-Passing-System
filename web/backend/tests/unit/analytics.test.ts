import { describe, expect, it } from "vitest";

import { computeAnalytics } from "../../src/analytics/service.js";
import { openDatabase, type Database } from "../../src/db/database.js";
import { EventRepository } from "../../src/db/repositories/events.js";
import { SessionRepository } from "../../src/db/repositories/sessions.js";

interface Deps {
  db: Database;
  repo: SessionRepository;
  events: EventRepository;
}

function makeDeps(): Deps {
  const db = openDatabase(":memory:") as unknown as Database;
  return { db, repo: new SessionRepository(db), events: new EventRepository(db) };
}

describe("computeAnalytics", () => {
  it("is empty-neutered (nulls), never fabricated, with no data", () => {
    const { repo, events } = makeDeps();
    const out = computeAnalytics(repo, events);
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
    const { repo, events } = makeDeps();
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

    const out = computeAnalytics(repo, events);
    expect(out.totalExecutions).toBe(5);
    expect(out.successful).toBe(2);
    expect(out.failed).toBe(3);
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
    const { db, repo, events } = makeDeps();
    for (const id of ["telemetry-a", "telemetry-b"]) {
      repo.create({ id, command: "sleep", args: ["1"], redirections: {}, timeoutMs: 30000, startedAt: "2026-01-01T10:00:00.000Z" });
      repo.finalize(id, { status: "COMPLETED", exitCode: 0, signal: null, isSuccess: true, durationMs: 1000, pid: 100, error: null });
    }
    const insert = (db as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(
      "INSERT INTO events (id, session_id, sequence, type, source, timestamp, monotonic_ms, pid, payload) VALUES (?, ?, ?, 'process.snapshot', 'gateway', ?, NULL, 100, ?)",
    );
    const makeSnapshot = (rss: number, user: number, system: number, cpu: number, minor: number, major: number, rcharRate: number, wcharRate: number) => JSON.stringify({
      rssBytes: { value: rss, provenance: "OBSERVED", source: "/proc/100/status" },
      cpuUserMs: { value: user, provenance: "DERIVED", source: "/proc/100/stat" },
      cpuSystemMs: { value: system, provenance: "DERIVED", source: "/proc/100/stat" },
      cpuPercent: { value: cpu, provenance: "DERIVED", source: "sample delta" },
      minorFaults: { value: minor, provenance: "OBSERVED", source: "/proc/100/stat" },
      majorFaults: { value: major, provenance: "OBSERVED", source: "/proc/100/stat" },
      rcharBytesPerSec: { value: rcharRate, provenance: "DERIVED", source: "sample delta" },
      wcharBytesPerSec: { value: wcharRate, provenance: "DERIVED", source: "sample delta" },
    });
    insert.run("snapshot-a1", "telemetry-a", 0, "2026-01-01T10:00:00.100Z", makeSnapshot(100, 10, 5, 1, 40, 0, 1_000, 500));
    insert.run("snapshot-a2", "telemetry-a", 1, "2026-01-01T10:00:00.600Z", makeSnapshot(200, 20, 10, 2, 90, 3, 3_000, 1_500));
    insert.run("snapshot-b1", "telemetry-b", 0, "2026-01-01T10:00:00.100Z", makeSnapshot(300, 30, 10, 3, 10, 1, 200, 100));
    insert.run("snapshot-b2", "telemetry-b", 1, "2026-01-01T10:00:00.600Z", makeSnapshot(400, 50, 15, 4, 20, 2, 400, 200));

    // The aggregates are computed in SQL rather than by parsing every snapshot
    // in JavaScript; the numbers must be identical either way.
    const out = computeAnalytics(repo, events);
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
      averageMinorFaults: 40,
      averageMajorFaults: 1.5,
      majorFaultSamples: 4,
      maxMajorFaults: 3,
      averageRcharBytesPerSec: 1_150,
      maxRcharBytesPerSec: 3_000,
      averageWcharBytesPerSec: 575,
      maxWcharBytesPerSec: 1_500,
      ioRateSamples: 4,
    });
  });

  it("refuses to report a mean over a single observation", () => {
    const { db, repo, events } = makeDeps();
    repo.create({ id: "one", command: "sleep", args: ["1"], redirections: {}, timeoutMs: 30000, startedAt: "2026-01-01T10:00:00.000Z" });
    repo.finalize("one", { status: "COMPLETED", exitCode: 0, signal: null, isSuccess: true, durationMs: 10, pid: 1, error: null });
    const insert = (db as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(
      "INSERT INTO events (id, session_id, sequence, type, source, timestamp, monotonic_ms, pid, payload) VALUES ('s1', 'one', 0, 'process.snapshot', 'gateway', ?, NULL, 1, ?)",
    );
    insert.run(
      "2026-01-01T10:00:00.100Z",
      JSON.stringify({ rssBytes: { value: 1024, provenance: "OBSERVED", source: "/proc/1/status" } }),
    );
    const out = computeAnalytics(repo, events);
    // The maximum is a real observation and is reported; the mean of one
    // sample is not a trend and stays UNAVAILABLE.
    expect(out.processTelemetry.maxRssBytes).toBe(1024);
    expect(out.processTelemetry.rssSamples).toBe(1);
    expect(out.processTelemetry.averageRssBytes).toBeNull();
  });
});
