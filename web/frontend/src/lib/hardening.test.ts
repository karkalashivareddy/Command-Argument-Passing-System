import { describe, expect, it } from "vitest";

import {
  buildEvidenceIndex,
  cursorMsForIdentity,
  eventIdentity,
  matchConfidence,
  nearestEventForIdentity,
  nodeKeyFor,
  recordFor,
  resolveSelection,
  sameProcess,
  type EvidenceIndex,
  type ProcessIdentity,
} from "./evidenceCorrelation";
import { buildProcessSpace, nodeStateAt, buildProcessSpace as buildSpace } from "./processSpace";
import type { CanonicalEvent, TelemetryMetric } from "../types/observability";

/**
 * The failure modes that a single-process record cannot reach.
 *
 * The existing suites cover the happy path of one child and one engine. These
 * cover the three ways a real recorder misleads a reader:
 *
 *   1. a PID the kernel recycled, seen twice with two start times;
 *   2. a signal somewhere in the record being applied to every process in it;
 *   3. the 2D and 3D views reaching different conclusions from one record.
 */

const SESSION = "exec_hard";
const ENGINE_PID = 900;
const CHILD_PID = 901;
const SECOND_PID = 902;
const BASE = Date.parse("2026-03-01T12:00:00.000Z");
const START_A = "2026-03-01T12:00:00.500000Z";
const START_B = "2026-03-01T12:00:03.500000Z";

const obs = <T,>(value: T): TelemetryMetric<T> => ({ value, provenance: "OBSERVED", source: "/proc" });

function ev(partial: Partial<CanonicalEvent> & Pick<CanonicalEvent, "type" | "sequence">): CanonicalEvent {
  return {
    id: `e${partial.sequence}`,
    sessionId: SESSION,
    source: "gateway",
    timestamp: new Date(BASE + (partial.sequence ?? 0) * 250).toISOString(),
    monotonicMs: (partial.sequence ?? 0) * 250,
    pid: null,
    payload: {},
    ...partial,
  } as CanonicalEvent;
}

function snap(sequence: number, pid: number, startTime: string): CanonicalEvent {
  return ev({
    type: "process.snapshot",
    sequence,
    pid,
    payload: {
      pid: obs(pid),
      capsEnginePid: obs(ENGINE_PID),
      ppid: obs(ENGINE_PID),
      command: obs("caps_fork_tree"),
      startTime: obs(startTime),
      rssBytes: obs(1024 * pid),
    },
  });
}

/** One engine, two children, only the second of which was signalled. */
const multiProcessRecord: CanonicalEvent[] = [
  ev({ type: "execution.created", sequence: 0 }),
  ev({ type: "execution.started", sequence: 1 }),
  ev({ type: "process.started", sequence: 2, pid: CHILD_PID, payload: { label: "child-a" } }),
  snap(3, CHILD_PID, START_A),
  ev({ type: "process.exited", sequence: 4, pid: CHILD_PID, payload: { exitCode: 0, outcome: "COMPLETED" } }),
  ev({ type: "process.started", sequence: 5, pid: SECOND_PID, payload: { label: "child-b" } }),
  snap(6, SECOND_PID, START_B),
  ev({ type: "signal.received", sequence: 7, pid: SECOND_PID, payload: { signal: 15, outcome: "SIGNALED" } }),
  ev({ type: "process.exited", sequence: 8, pid: SECOND_PID, payload: { exitCode: 143, outcome: "SIGNALED" } }),
  ev({ type: "execution.failed", sequence: 9, payload: { reason: "terminated by signal 15" } }),
];

describe("a recycled PID is two processes, not one", () => {
  it("keys the index by start time, not by PID alone", () => {
    const index = buildEvidenceIndex(multiProcessRecord);
    const childA: ProcessIdentity = { sessionId: SESSION, pid: CHILD_PID, processStartTime: START_A, role: "child" };
    const childB: ProcessIdentity = { sessionId: SESSION, pid: SECOND_PID, processStartTime: START_B, role: "child" };

    // The two keys differ even when the pid is the same, which is the whole
    // point: `role:pid` cannot distinguish them.
    const recycled: ProcessIdentity = { ...childA, processStartTime: START_B };
    expect(nodeKeyFor(childA)).not.toBe(nodeKeyFor(recycled));
    expect(sameProcess(childA, recycled)).toBe(false);
    expect(matchConfidence(childA, recycled)).toBeNull();

    // Each key resolves to its own record, with its own numbers.
    expect(recordFor(childA, index)?.identity.processStartTime).toBe(START_A);
    // The recycled identity is a real record entry for a different process.
    expect(recordFor({ ...childB }, index)?.identity.processStartTime).toBe(START_B);
    expect(recordFor(childA, index)?.command).toBe("caps_fork_tree");
  });

  it("registers a second process behind a recycled PID instead of merging it", () => {
    // PID 901 seen again, with a start time no existing record carries.
    const recycled = snap(10, CHILD_PID, START_B);
    const index = buildEvidenceIndex([...multiProcessRecord, recycled]);
    const original: ProcessIdentity = { sessionId: SESSION, pid: CHILD_PID, processStartTime: START_A, role: "child" };
    const newcomer: ProcessIdentity = { sessionId: SESSION, pid: CHILD_PID, processStartTime: START_B, role: "child" };

    // Two distinct entries; the first was not overwritten by the second.
    expect(recordFor(original, index)).not.toBeNull();
    expect(recordFor(newcomer, index)).not.toBeNull();
    expect(recordFor(original, index)).not.toBe(recordFor(newcomer, index));
    expect(index.pidCollisions.some((c) => c.pid === CHILD_PID)).toBe(true);
    expect(index.limitations.join(" ")).toMatch(/cannot be resolved to one process identity/);
  });

  it("refuses to resolve an ambiguous identity that carries no start time", () => {
    const recycled = snap(10, CHILD_PID, START_B);
    const index = buildEvidenceIndex([...multiProcessRecord, recycled]);
    // Two processes, one pid, no start time: the record genuinely cannot say
    // which one was meant, and picking the first would be a guess.
    expect(recordFor({ sessionId: SESSION, pid: CHILD_PID, processStartTime: null, role: "child" }, index)).toBeNull();
  });

  it("still resolves an unambiguous identity that carries no start time", () => {
    const index = buildEvidenceIndex(multiProcessRecord);
    expect(recordFor({ sessionId: SESSION, pid: CHILD_PID, processStartTime: null, role: "child" }, index)).not.toBeNull();
  });
});

describe("a signal belongs to one process, not to the record", () => {
  const index = buildEvidenceIndex(multiProcessRecord);

  it("attributes the signal only to the process the event names", () => {
    const childA = index.processes.find((p) => p.identity.pid === CHILD_PID)!;
    const childB = index.processes.find((p) => p.identity.pid === SECOND_PID)!;
    expect(childB.signalNumber).toBe(15);
    expect(childB.signalSequence).toBe(7);
    // The sibling that exited 0 must not inherit the other process's signal.
    expect(childA.signalNumber).toBeNull();
    expect(childA.signalSequence).toBeNull();
  });

  it("does not mark every ended process SIGNALED in the space view", () => {
    const space = buildProcessSpace(multiProcessRecord);
    const a = space.nodes.find((n) => n.pid === CHILD_PID)!;
    const b = space.nodes.find((n) => n.pid === SECOND_PID)!;

    const stateA = nodeStateAt(space, space.spanMs, a);
    const stateB = nodeStateAt(space, space.spanMs, b);
    // This is the regression: with a record-wide `hasSignalMarker` boolean,
    // child A -- which exited 0 -- was also rendered SIGNALED.
    expect(stateA.state).not.toBe("SIGNALED");
    expect(stateB.state).toBe("SIGNALED");
  });

  it("carries the signal only on the node whose event named it", () => {
    const space = buildProcessSpace(multiProcessRecord);
    const keyed = new Set([...space.signalByKey.keys()]);
    const b = space.nodes.find((n) => n.pid === SECOND_PID)!;
    const a = space.nodes.find((n) => n.pid === CHILD_PID)!;
    expect(keyed.has(b.key)).toBe(true);
    expect(keyed.has(a.key)).toBe(false);
    expect(space.signalByKey.get(b.key)?.signal).toBe(15);
  });
});

describe("2D and 3D reach the same conclusion from one record", () => {
  const index: EvidenceIndex = buildEvidenceIndex(multiProcessRecord);

  /** The 3D scene's view-model: buildProcessSpace, given the same record. */
  const spaceFor = (): ReturnType<typeof buildSpace> => buildProcessSpace(multiProcessRecord);

  it("resolves the same selected event in both surfaces", () => {
    const space = spaceFor();
    const selection = { sessionId: SESSION, cursorMs: null, identity: null, eventSeq: 7 };
    const resolution = resolveSelection(selection, index);

    // The correlation layer (shared by every surface) resolves the event to
    // the child it actually names.
    expect(resolution.event?.sequence).toBe(7);
    expect(resolution.identity?.pid).toBe(SECOND_PID);

    // The space view-model's marker for that sequence must be the same event
    // and the same node, so a reader clicking the 3D marker and one clicking
    // the 2D row are looking at the same evidence.
    const marker = space.markersBySequence.get(7);
    expect(marker).toBeDefined();
    expect(marker!.type).toBe("signal.received");
    expect(marker!.nodeKey).toBe(resolution.nodeKey);
    expect(marker!.signal).toBe(15);
  });

  it("reports the same identity confidence in both surfaces", () => {
    const space = spaceFor();
    const childB: ProcessIdentity = { sessionId: SESSION, pid: SECOND_PID, processStartTime: START_B, role: "child" };
    const resolution = resolveSelection({ sessionId: SESSION, cursorMs: null, identity: childB, eventSeq: null }, index);
    expect(resolution.identityConfidence).toBe("session+pid+start");
    // The space view must contain exactly one node for that identity, and it
    // must be the node the correlation layer selected.
    const matching = space.nodes.filter((n) => n.pid === SECOND_PID);
    expect(matching).toHaveLength(1);
    expect(matching[0]!.key).toBe(resolution.nodeKey);
  });

  it("places the cursor at the same recorded moment in both surfaces", () => {
    const space = spaceFor();
    const childA: ProcessIdentity = { sessionId: SESSION, pid: CHILD_PID, processStartTime: START_A, role: "child" };
    const correlation = cursorMsForIdentity(childA, index);
    const firstSnapshot = multiProcessRecord.find((e) => e.type === "process.snapshot" && e.pid === CHILD_PID)!;
    const spaceAtMs = Math.max(0, new Date(firstSnapshot.timestamp).getTime() - Date.parse(space.originTimestamp!));
    expect(correlation).toBe(spaceAtMs);
  });

  it("selects the same nearest event in both surfaces", () => {
    const childB: ProcessIdentity = { sessionId: SESSION, pid: SECOND_PID, processStartTime: START_B, role: "child" };
    const nearest = nearestEventForIdentity(childB, index, 2000);
    // Sequence 8 (the signalled exit) is at 2000ms, exactly on the cursor.
    expect(nearest?.sequence).toBe(8);
    // And the space exposes the same sequence as a marker on the same node.
    const space = spaceFor();
    const marker = space.markersBySequence.get(8);
    expect(marker?.type).toBe("process.exited");
    // Both surfaces key the node the same way, so the marker and the correlation
    // layer name the same process.
    expect(marker?.nodeKey).toBe(nodeKeyFor({ pid: SECOND_PID, role: "child", processStartTime: START_B }));
  });

  it("agrees that an execution-scoped event has no process identity", () => {
    // Both surfaces must refuse to invent a process for it.
    const created = multiProcessRecord[0]!;
    expect(eventIdentity(created, index)).toBeNull();
    const space = spaceFor();
    expect(space.markersBySequence.get(0)?.nodeKey ?? null).toBeNull();
  });
});
