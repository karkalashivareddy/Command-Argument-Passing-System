import { describe, expect, it } from "vitest";

import { compareSessions, computeCommandProfiles, computeRuntimePeaks } from "../../src/analytics/service.js";
import { openDatabase } from "../../src/db/database.js";
import { SessionRepository } from "../../src/db/repositories/sessions.js";
import type { CanonicalEvent, SessionRecord } from "../../src/types/observability.js";

function snapshotEvent(sequence: number, timestamp: string, rss: number | null, cpu: number | null, user: number | null, system: number | null, elapsed: number | null): CanonicalEvent {
  const payload: Record<string, unknown> = {};
  const metric = (value: number | null, provenance: "OBSERVED" | "DERIVED" = "OBSERVED") => ({
    value,
    provenance: value === null ? "UNAVAILABLE" : provenance,
    source: "/proc/100/stat",
    reason: value === null ? "no data" : undefined,
  });
  payload.rssBytes = metric(rss);
  payload.cpuPercent = metric(cpu, "DERIVED");
  payload.cpuUserMs = metric(user, "DERIVED");
  payload.cpuSystemMs = metric(system, "DERIVED");
  payload.elapsedMs = metric(elapsed, "DERIVED");
  return { id: `ev-${sequence}`, sessionId: "s", sequence, type: "process.snapshot", source: "gateway", timestamp, monotonicMs: null, pid: 100, payload };
}

/** A snapshot carrying the fault and I/O counters that are now first class. */
function telemetrySnapshot(sequence: number, timestamp: string, fields: Record<string, number | null>): CanonicalEvent {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    payload[key] = {
      value,
      provenance: value === null ? "UNAVAILABLE" : key.endsWith("PerSec") ? "DERIVED" : "OBSERVED",
      source: key.startsWith("minor") || key.startsWith("major") ? "/proc/100/stat" : "/proc/100/io",
      reason: value === null ? "no data" : undefined,
    };
  }
  return { id: `io-${sequence}`, sessionId: "s", sequence, type: "process.snapshot", source: "gateway", timestamp, monotonicMs: null, pid: 100, payload };
}

const mkSession = (id: string, command: string, status: SessionRecord["status"], exitCode: number | null, signal: number | null, durationMs: number, args: string[] = []): SessionRecord => ({  id,  id,
  command,
  args,
  argv: [command, ...args],
  redirections: {},
  status,
  startedAt: "2026-01-01T10:00:00.000Z",
  endedAt: "2026-01-01T10:00:05.000Z",
  durationMs,
  exitCode,
  signal,
  isSuccess: exitCode === 0,
  pid: 100,
  stdout: "",
  stderr: "",
  error: null,
  timeoutMs: 30000,
  eventCount: 0,
});

describe("computeRuntimePeaks", () => {
  it("is neutered on an empty event list", () => {
    const peaks = computeRuntimePeaks([]);
    expect(peaks).toMatchObject({ sampleCount: 0, firstSampleAt: null, lastSampleAt: null, peakRssBytes: null, medianRssBytes: null, peakCpuPercent: null, cpuTimeMs: null });
  });

  it("derives peaks only from valid persisted samples", () => {
    const events: CanonicalEvent[] = [
      { id: "t0", sessionId: "s", sequence: 0, type: "process.started", source: "caps", timestamp: "2026-01-01T10:00:00.000Z", monotonicMs: 0, pid: 100, payload: {} },
      snapshotEvent(1, "2026-01-01T10:00:00.100Z", 100, 1.0, 10, 5, 100),
      snapshotEvent(2, "2026-01-01T10:00:00.600Z", 400, 4.0, 20, 10, 600),
      snapshotEvent(3, "2026-01-01T10:00:01.100Z", 300, 3.0, 30, 15, 1100),
      snapshotEvent(4, "2026-01-01T10:00:01.600Z", null, null, null, null, null),
    ];
    const peaks = computeRuntimePeaks(events);
    expect(peaks.sampleCount).toBe(4);
    expect(peaks.firstSampleAt).toBe("2026-01-01T10:00:00.100Z");
    expect(peaks.lastSampleAt).toBe("2026-01-01T10:00:01.600Z");
    expect(peaks.peakRssBytes).toMatchObject({ value: 400, atTimeMs: 600 });
    expect(peaks.medianRssBytes).toBe(300);
    expect(peaks.peakCpuPercent).toMatchObject({ value: 4, atTimeMs: 600 });
    // cpu time comes from the final sample that has valid user+system ticks.
    expect(peaks.cpuTimeMs).toBe(45);
    expect(peaks.minElapsedMs).toBe(100);
    expect(peaks.maxElapsedMs).toBe(1100);
  });

  it("requires at least two valid RSS samples for a median", () => {
    const peaks = computeRuntimePeaks([snapshotEvent(1, "2026-01-01T10:00:00.100Z", 120, null, null, null, null)]);
    expect(peaks.peakRssBytes?.value).toBe(120);
    expect(peaks.medianRssBytes).toBeNull();
  });
});

describe("runtime fault and I/O aggregates", () => {
  const events: CanonicalEvent[] = [
    telemetrySnapshot(1, "2026-01-01T10:00:00.100Z", { minorFaults: 100, majorFaults: 0, rcharBytes: 1_000, wcharBytes: 500, readBytes: 0, writeBytes: 0 }),
    telemetrySnapshot(2, "2026-01-01T10:00:00.600Z", {
      minorFaults: 900, majorFaults: 12, rcharBytes: 3_000, wcharBytes: 1_500, readBytes: 4_096, writeBytes: 8_192,
      minorFaultsPerSec: 1_600, majorFaultsPerSec: 24, rcharBytesPerSec: 4_000, wcharBytesPerSec: 2_000,
    }),
    telemetrySnapshot(3, "2026-01-01T10:00:01.100Z", {
      minorFaults: 950, majorFaults: 12, rcharBytes: 3_500, wcharBytes: 1_500, readBytes: 4_096, writeBytes: 8_192,
      minorFaultsPerSec: 100, majorFaultsPerSec: 0, rcharBytesPerSec: 1_000, wcharBytesPerSec: 0,
    }),
  ];

  it("peaks faults, peaks rates, and totals cumulative I/O counters", () => {
    const peaks = computeRuntimePeaks(events);
    expect(peaks.peakMinorFaults).toMatchObject({ value: 950, atTimeMs: 1_000 });
    expect(peaks.peakMajorFaults).toMatchObject({ value: 12, atTimeMs: 500 });
    expect(peaks.peakMinorFaultsPerSec).toMatchObject({ value: 1_600, atTimeMs: 500 });
    expect(peaks.peakRcharBytesPerSec).toMatchObject({ value: 4_000 });
    // A flat counter is a real measured rate of zero, not a missing value.
    expect(peaks.peakWcharBytesPerSec).toMatchObject({ value: 2_000 });
    // Cumulative counters: the last valid observation is the session total.
    expect(peaks.totalRcharBytes).toBe(3_500);
    expect(peaks.totalWcharBytes).toBe(1_500);
    expect(peaks.totalReadBytes).toBe(4_096);
    expect(peaks.totalWriteBytes).toBe(8_192);
  });

  it("keeps the last valid total when the final sample is unavailable", () => {
    const peaks = computeRuntimePeaks([
      ...events,
      telemetrySnapshot(4, "2026-01-01T10:00:01.600Z", { minorFaults: null, majorFaults: null, rcharBytes: null, wcharBytes: null, readBytes: null, writeBytes: null }),
    ]);
    expect(peaks.sampleCount).toBe(4);
    expect(peaks.totalRcharBytes).toBe(3_500);
    expect(peaks.totalWcharBytes).toBe(1_500);
    expect(peaks.peakMinorFaults?.value).toBe(950);
  });

  it("adds fault and I/O deltas to a session comparison", () => {
    const cmp = compareSessions(
      mkSession("a", "workload", "COMPLETED", 0, null, 1_200),
      mkSession("b", "workload", "COMPLETED", 0, null, 2_200),
      events,
      events,
    );
    expect(cmp.left.peakMajorFaults).toBe(12);
    expect(cmp.left.totalWcharBytes).toBe(1_500);
    expect(cmp.deltas.majorFaultsDelta).toBe(0);
    expect(cmp.deltas.wcharDeltaBytes).toBe(0);
    // Missing telemetry stays null instead of collapsing to a zero delta.
    const noTelemetry = compareSessions(
      mkSession("a", "workload", "COMPLETED", 0, null, 1_200),
      mkSession("b", "workload", "COMPLETED", 0, null, 2_200),
      [snapshotEvent(1, "2026-01-01T10:00:00.100Z", 10, null, null, null, 100)],
      events,
    );
    expect(noTelemetry.deltas.majorFaultsDelta).toBeNull();
    expect(noTelemetry.deltas.rcharDeltaBytes).toBeNull();
  });
});

describe("computeCommandProfiles", () => {
  it("builds per-command duration and telemetry profiles from terminal sessions", () => {
    const db = openDatabase(":memory:");
    const repo = new SessionRepository(db);
    for (const id of ["p-a", "p-b"]) {
      repo.create({ id, command: "sleep", args: ["1"], redirections: {}, timeoutMs: 30000, startedAt: "2026-01-01T10:00:00.000Z" });
      repo.finalize(id, { status: "COMPLETED", exitCode: 0, signal: null, isSuccess: true, durationMs: id === "p-a" ? 1000 : 2000, pid: 100, error: null });
    }
    repo.create({ id: "p-c", command: "false", args: [], redirections: {}, timeoutMs: 30000, startedAt: "2026-01-01T10:00:00.000Z" });
    repo.finalize("p-c", { status: "FAILED", exitCode: 1, signal: null, isSuccess: false, durationMs: 50, pid: 100, error: null });

    const insert = db.prepare("INSERT INTO events (id, session_id, sequence, type, source, timestamp, monotonic_ms, pid, payload) VALUES (?, ?, ?, 'process.snapshot', 'gateway', ?, NULL, 100, ?)");
    insert.run("p-a-s1", "p-a", 0, "2026-01-01T10:00:00.100Z", JSON.stringify({ rssBytes: { value: 100, provenance: "OBSERVED", source: "x" } }));
    insert.run("p-a-s2", "p-a", 1, "2026-01-01T10:00:00.600Z", JSON.stringify({ rssBytes: { value: 300, provenance: "OBSERVED", source: "x" } }));
    insert.run("p-b-s1", "p-b", 0, "2026-01-01T10:00:00.100Z", JSON.stringify({ rssBytes: { value: 200, provenance: "OBSERVED", source: "x" } }));

    const profiles = computeCommandProfiles(repo);
    const sleep = profiles.find((p) => p.command === "sleep")!;
    const falseProfile = profiles.find((p) => p.command === "false")!;
    expect(sleep.runs).toBe(2);
    expect(sleep.successful).toBe(2);
    expect(sleep.successRate).toBe(100);
    expect(sleep.medianDurationMs).toBe(1000);
    expect(sleep.p95DurationMs).toBe(2000);
    expect(sleep.minDurationMs).toBe(1000);
    expect(sleep.maxDurationMs).toBe(2000);
    expect(sleep.medianRssBytes).toBe(200);
    expect(sleep.peakRssBytes).toBe(300);
    expect(sleep.rssSamples).toBe(3);
    expect(falseProfile.runs).toBe(1);
    expect(falseProfile.successRate).toBe(0);
    expect(falseProfile.rssSamples).toBe(0);
    expect(falseProfile.medianRssBytes).toBeNull();
    db.close();
  });
});

describe("compareSessions", () => {
  it("produces honest shared facts and deltas between two sessions", () => {
    const cleanA: CanonicalEvent[] = [
      { id: "a0", sessionId: "a", sequence: 0, type: "process.started", source: "caps", timestamp: "2026-01-01T10:00:00.000Z", monotonicMs: 0, pid: 100, payload: {} },
      snapshotEvent(1, "2026-01-01T10:00:00.500Z", 100, 1, 5, 5, 500),
      snapshotEvent(2, "2026-01-01T10:00:01.100Z", 200, 2, 10, 10, 1100),
      { id: "a3", sessionId: "a", sequence: 3, type: "process.exited", source: "caps", timestamp: "2026-01-01T10:00:01.200Z", monotonicMs: 1200, pid: 100, payload: { exitCode: 0 } },
    ];
    const cleanB: CanonicalEvent[] = [
      { id: "b0", sessionId: "b", sequence: 0, type: "process.started", source: "caps", timestamp: "2026-01-01T11:00:00.000Z", monotonicMs: 0, pid: 200, payload: {} },
      snapshotEvent(1, "2026-01-01T11:00:00.500Z", 300, 3, 20, 10, 500),
      snapshotEvent(2, "2026-01-01T11:00:02.000Z", 500, 5, 40, 20, 2000),
    ];
    const sessionA = mkSession("a", "sleep", "COMPLETED", 0, null, 1200);
    const sessionB = mkSession("b", "sleep", "COMPLETED", 0, null, 2200);

    const cmp = compareSessions(sessionA, sessionB, cleanA, cleanB);
    expect(cmp.shared.sameCommand).toBe(true);
    expect(cmp.shared.command).toBe("sleep");
    expect(cmp.left.eventCount).toBe(4);
    expect(cmp.right.eventCount).toBe(3);
    expect(cmp.left.snapshotCount).toBe(2);
    expect(cmp.right.peakRssBytes).toBe(500);
    expect(cmp.deltas.durationMs).toBe(1000);
    expect(cmp.deltas.eventDelta).toBe(-1);
    expect(cmp.deltas.peakRssDeltaBytes).toBe(300);
    expect(cmp.deltas.cpuTimeDeltaMs).toBe(40);
  });
});
