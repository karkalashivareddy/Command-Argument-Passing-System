import { describe, expect, it } from "vitest";

import type { CanonicalEvent, ProcessSnapshot, TelemetryMetric } from "../types/observability";
import {
  buildEvidenceIndex,
  cursorMsForIdentity,
  describeSelection,
  eventCursorMs,
  eventIdentity,
  execTransitionForIdentity,
  identityMatchesSample,
  isExecEvent,
  matchConfidence,
  nearestEventForIdentity,
  nodeKeyFor,
  resolveSelection,
  sameProcess,
  sampleRangeForIdentity,
  type ProcessIdentity,
} from "./evidenceCorrelation";

/**
 * The correlation rules, asserted without a browser, a GPU, or a network.
 *
 * These are the guarantees every surface depends on: a PID alone never matches,
 * a reused PID never matches, an event resolves to a verified process or to
 * nothing, and no cursor value is ever invented.
 */

const SESSION = "exec_corr";
const ENGINE_PID = 900;
const CHILD_PID = 901;
const START_ISO = "2026-03-01T12:00:00.000Z";
const START_MS = Date.parse(START_ISO);
const CHILD_START = "2026-03-01T12:00:00.500000Z";

const obs = <T,>(value: T): TelemetryMetric<T> => ({ value, provenance: "OBSERVED", source: "/proc" });
const der = <T,>(value: T): TelemetryMetric<T> => ({ value, provenance: "DERIVED", source: "delta" });
const unavail = <T,>(reason: string): TelemetryMetric<T> => ({ value: null, provenance: "UNAVAILABLE", source: "/proc", reason });

function event(partial: Partial<CanonicalEvent> & Pick<CanonicalEvent, "type" | "sequence">): CanonicalEvent {
  return {
    id: `e${partial.sequence}`,
    sessionId: SESSION,
    source: "gateway",
    timestamp: new Date(START_MS + (partial.sequence ?? 0) * 250).toISOString(),
    monotonicMs: (partial.sequence ?? 0) * 250,
    pid: null,
    payload: {},
    ...partial,
  } as CanonicalEvent;
}

function snapshot(sequence: number, startTime: string | null = CHILD_START): CanonicalEvent {
  return event({
    type: "process.snapshot",
    sequence,
    pid: CHILD_PID,
    payload: {
      pid: obs(CHILD_PID),
      capsEnginePid: obs(ENGINE_PID),
      ppid: obs(ENGINE_PID),
      command: obs("caps_cpu_burn"),
      startTime: startTime === null ? unavail("field not readable on this kernel") : obs(startTime),
      cpuPercent: sequence < 3 ? unavail("first sample: a rate needs two samples") : der(12.5),
      rssBytes: obs(4 * 1024 * 1024),
      minorFaults: obs(10 * sequence),
      majorFaults: obs(0),
      minorFaultsPerSec: sequence < 3 ? unavail("first sample") : der(3),
      majorFaultsPerSec: sequence < 3 ? unavail("first sample") : der(0),
    },
  });
}

const events: CanonicalEvent[] = [
  event({ type: "execution.started", sequence: 0 }),
  event({ type: "process.started", sequence: 1, pid: CHILD_PID, payload: { label: "CAPS child" } }),
  snapshot(2),
  snapshot(3),
  snapshot(4),
  event({ type: "process.exited", sequence: 5, pid: CHILD_PID, payload: { exitCode: 0 } }),
  event({ type: "execution.completed", sequence: 6, payload: { exitCode: 0 } }),
];

const childIdentity: ProcessIdentity = { sessionId: SESSION, pid: CHILD_PID, processStartTime: CHILD_START, role: "child" };
const engineIdentity: ProcessIdentity = { sessionId: SESSION, pid: ENGINE_PID, processStartTime: null, role: "caps-engine" };

function selection(overrides: Partial<Parameters<typeof resolveSelection>[0]> = {}): Parameters<typeof resolveSelection>[0] {
  return { sessionId: SESSION, cursorMs: null, identity: null, eventSeq: null, ...overrides };
}

describe("process identity is never a bare PID", () => {
  it("accepts a full match and rejects a PID collision", () => {
    expect(matchConfidence(childIdentity, { ...childIdentity })).toBe("session+pid+start");
    // A recycled PID is a different process, and the guard says so.
    expect(matchConfidence(childIdentity, { ...childIdentity, processStartTime: "2026-03-01T12:00:09.000000Z" })).toBeNull();
    expect(sameProcess(childIdentity, { ...childIdentity, processStartTime: "2026-03-01T12:00:09.000000Z" })).toBe(false);
  });

  it("rejects a different session and a different PID outright", () => {
    expect(matchConfidence(childIdentity, { ...childIdentity, sessionId: "exec_other" })).toBeNull();
    expect(matchConfidence(childIdentity, { ...childIdentity, pid: 1234 })).toBeNull();
  });

  it("degrades to session+pid only when a start time is missing, and says so", () => {
    const withoutStart: ProcessIdentity = { ...childIdentity, processStartTime: null };
    expect(matchConfidence(withoutStart, { ...childIdentity })).toBe("session+pid");
    expect(matchConfidence(engineIdentity, { ...engineIdentity })).toBe("session+pid");
  });

  it("filters procfs samples by PID and start time together", () => {
    const snapshotValue = events[3]!.payload as unknown as ProcessSnapshot;
    expect(identityMatchesSample(childIdentity, snapshotValue)).toBe(true);
    expect(identityMatchesSample({ ...childIdentity, processStartTime: null }, snapshotValue)).toBe(true);
    expect(identityMatchesSample({ ...childIdentity, processStartTime: "2026-03-01T12:00:09.000000Z" }, snapshotValue)).toBe(false);
    expect(identityMatchesSample(engineIdentity, snapshotValue)).toBe(false);
  });

  it("refuses a sample range that the start-time guard rejects", () => {
    const index = buildEvidenceIndex(events);
    expect(sampleRangeForIdentity(childIdentity, index)?.first).toBeDefined();
    // Same PID, different process: the range is not handed over.
    expect(sampleRangeForIdentity({ ...childIdentity, processStartTime: "2026-03-01T12:00:09.000000Z" }, index)).toBeNull();
    // The engine is never sampled, so it has no range at all.
    expect(sampleRangeForIdentity(engineIdentity, index)).toBeNull();
  });
});

describe("the record index only contains observed processes", () => {
  const index = buildEvidenceIndex(events);

  it("lists the CAPS engine and the observed child, and nothing else", () => {
    expect(index.processes.map((record) => `${record.identity.role}:${record.identity.pid}`).sort()).toEqual([
      `caps-engine:${ENGINE_PID}`,
      `child:${CHILD_PID}`,
    ]);
  });

  it("reports a PID observed with two start times instead of merging them", () => {
    const collision = buildEvidenceIndex([...events, snapshot(7, "2026-03-01T12:00:09.000000Z")]);
    expect(collision.pidCollisions.length).toBe(1);
    expect(collision.pidCollisions[0]!.pid).toBe(CHILD_PID);
    expect(collision.pidCollisions[0]!.startTimes).toHaveLength(2);
    expect(collision.limitations.join(" ")).toMatch(/cannot be resolved to one process identity/);
  });

  it("records the verified parent only when the observed PPID matches", () => {
    const child = index.byNodeKey.get(nodeKeyFor(childIdentity)!)!;
    expect(child.observedPpid).toBe(ENGINE_PID);

    const unmatched = buildEvidenceIndex(
      events.map((ev) =>
        ev.type === "process.snapshot"
          ? ({ ...ev, payload: { ...(ev.payload as object), ppid: obs(999) } } as CanonicalEvent)
          : ev,
      ),
    );
    const orphan = unmatched.byNodeKey.get(nodeKeyFor(childIdentity)!)!;
    expect(orphan.observedPpid).toBe(999);
    const resolution = resolveSelection(selection({ identity: childIdentity }), unmatched);
    // An observed PPID that is not an observed process is not an edge.
    expect(resolution.parentNodeKey).toBeNull();
    expect(resolution.relatedNodeKeys).toEqual([]);
  });

  it("keeps the execvp() transition on the same PID", () => {
    const child = index.byNodeKey.get(nodeKeyFor(childIdentity)!)!;
    expect(child.imageBefore).toBe("CAPS child");
    expect(child.command).toBe("caps_cpu_burn");
    expect(child.execSequence).toBe(2);
    expect(execTransitionForIdentity(childIdentity, index)).toEqual({ sequence: 2, atMs: 500 });
    expect(isExecEvent(index, 2)).toBe(true);
    expect(isExecEvent(index, 5)).toBe(false);
  });
});

describe("event to process correlation", () => {
  const index = buildEvidenceIndex(events);

  it("resolves a process event to the child it observed", () => {
    const start = eventIdentity(index.bySequence.get(1)!, index);
    expect(start?.pid).toBe(CHILD_PID);
    expect(start?.role).toBe("child");
  });

  it("resolves a snapshot to the sampled process, not to the engine", () => {
    expect(eventIdentity(index.bySequence.get(3)!, index)?.pid).toBe(CHILD_PID);
  });

  it("refuses to invent a process for an execution-scoped event", () => {
    expect(eventIdentity(index.bySequence.get(0)!, index)).toBeNull();
    expect(eventIdentity(index.bySequence.get(6)!, index)).toBeNull();
  });

  it("states the degraded identity when a selected event has no start time", () => {
    const engineSnapshot = event({
      type: "process.snapshot",
      sequence: 8,
      payload: { pid: obs(ENGINE_PID), capsEnginePid: obs(ENGINE_PID) },
    });
    const withEngine = buildEvidenceIndex([...events, engineSnapshot]);
    const resolution = resolveSelection(selection({ eventSeq: 8 }), withEngine);
    expect(resolution.identity?.pid).toBe(ENGINE_PID);
    // The engine is never sampled, so no start time exists for it and the UI is
    // told the match is weaker instead of implying a full one.
    expect(resolution.identityConfidence).toBe("session+pid");
  });

  it("refuses to overwrite a reader's process with a different process's event", () => {
    // Two children observed in one record, each with its own identity.
    const otherStart = event({ type: "process.started", sequence: 7, pid: 777, payload: { label: "second child" } });
    const otherSnapshot = event({
      type: "process.snapshot",
      sequence: 8,
      pid: 777,
      payload: {
        pid: obs(777),
        capsEnginePid: obs(ENGINE_PID),
        ppid: obs(ENGINE_PID),
        command: obs("caps_fork_tree"),
        startTime: obs("2026-03-01T12:00:07.000000Z"),
      },
    });
    const both = buildEvidenceIndex([...events, otherStart, otherSnapshot]);
    const otherIdentity: ProcessIdentity = { sessionId: SESSION, pid: 777, processStartTime: "2026-03-01T12:00:07.000000Z", role: "child" };

    const resolution = resolveSelection(selection({ identity: otherIdentity, eventSeq: 1 }), both);
    expect(resolution.identity?.pid).toBe(777);
    expect(resolution.unresolved.join(" ")).toMatch(/belongs to PID 901, not the selected PID 777/);
  });
});

describe("cursor placement is a recorded moment or nothing", () => {
  const index = buildEvidenceIndex(events);

  it("uses the event's own timestamp when an event is selected", () => {
    const resolution = resolveSelection(selection({ eventSeq: 4 }), index);
    expect(resolution.cursorMs).toBe(eventCursorMs(index.bySequence.get(4)!, index));
    expect(resolution.cursorMs).toBe(1000);
  });

  it("uses the first recorded sample when only a process is selected", () => {
    const resolution = resolveSelection(selection({ identity: childIdentity }), index);
    expect(resolution.cursorMs).toBe(500);
    expect(cursorMsForIdentity(childIdentity, index)).toBe(500);
  });

  it("uses the establishing event for a process that is never sampled", () => {
    const resolution = resolveSelection(selection({ identity: engineIdentity }), index);
    // The engine is first seen in the snapshot that reports its PID.
    expect(resolution.cursorMs).toBe(500);
  });

  it("keeps the reader's cursor when the selection points at nothing", () => {
    const resolution = resolveSelection(selection({ cursorMs: 1234 }), index);
    expect(resolution.cursorMs).toBe(1234);
  });

  it("reports an unknown event instead of moving to a guess", () => {
    const resolution = resolveSelection(selection({ eventSeq: 999 }), index);
    expect(resolution.event).toBeNull();
    expect(resolution.unresolved.join(" ")).toMatch(/Event #999 is not present in this record/);
  });

  it("finds the newest event for a process at or before a moment", () => {
    expect(nearestEventForIdentity(childIdentity, index, 400)?.sequence).toBe(1);
    expect(nearestEventForIdentity(childIdentity, index, 5000)?.sequence).toBe(5);
  });
});

describe("stale selections resolve to nothing", () => {
  it("says a process from another session cannot be selected here", () => {
    const index = buildEvidenceIndex(events);
    const foreign: ProcessIdentity = { sessionId: "exec_elsewhere", pid: CHILD_PID, processStartTime: CHILD_START, role: "child" };
    const resolution = resolveSelection(selection({ identity: foreign }), index);
    expect(resolution.identity).toBeNull();
    expect(resolution.identityResolved).toBe(false);
    expect(resolution.unresolved.join(" ")).toMatch(/belongs to exec_elsewhere, not to exec_corr/);
  });

  it("says an unknown PID cannot be selected", () => {
    const index = buildEvidenceIndex(events);
    const missing: ProcessIdentity = { sessionId: SESSION, pid: 424242, processStartTime: null, role: "child" };
    const resolution = resolveSelection(selection({ identity: missing }), index);
    expect(resolution.identityResolved).toBe(false);
    expect(resolution.unresolved.join(" ")).toMatch(/PID 424242 is not an observed process/);
  });
});

describe("the evidence descriptor reports provenance", () => {
  const index = buildEvidenceIndex(events);

  it("labels observed, derived and unavailable values", () => {
    const descriptor = describeSelection(selection({ identity: childIdentity }), index);
    const byLabel = new Map(descriptor.values.map((value) => [value.label, value]));
    expect(byLabel.get("CAPS execution id")?.provenance).toBe("OBSERVED");
    expect(byLabel.get("Process start")?.provenance).toBe("DERIVED");
    expect(byLabel.get("Identity match")?.display).toBe("session+pid+start");
  });

  it("keeps the CAPS engine's missing telemetry visible as UNAVAILABLE", () => {
    const descriptor = describeSelection(selection({ identity: engineIdentity }), index);
    const samples = descriptor.values.find((value) => value.label === "procfs samples");
    expect(samples?.display).toBe("UNAVAILABLE");
    expect(samples?.reason).toMatch(/follows the CAPS-reported child only/);
  });
});
