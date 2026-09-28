import { describe, expect, it } from "vitest";

import type { CanonicalEvent, TelemetryMetric } from "../types/observability";
import {
  RADIUS_MAX,
  RADIUS_MIN,
  buildProcessSpace,
  buildRuler,
  nodePosition,
  nodeRadius,
  nodeStateAt,
  radiusForMode,
  rulerStep,
  spaceAt,
  timeScale,
  type SpaceNode,
} from "./processSpace";
import { collectSamples } from "./telemetry";

const START = Date.parse("2026-01-01T10:00:00.000Z");
const ENGINE_PID = 4000;
const CHILD_PID = 4001;

const obs = <T,>(value: T): TelemetryMetric<T> => ({ value, provenance: "OBSERVED", source: "/proc" });
const der = <T,>(value: T): TelemetryMetric<T> => ({ value, provenance: "DERIVED", source: "delta" });
const none = (): TelemetryMetric<number> => ({ value: null, provenance: "UNAVAILABLE", source: "/proc", reason: "First sample for this process: a rate needs two valid samples separated by a measured interval" });

function event(partial: Partial<CanonicalEvent> & Pick<CanonicalEvent, "type" | "sequence">): CanonicalEvent {
  return {
    id: `e${partial.sequence}`,
    sessionId: "exec_test",
    source: "gateway",
    timestamp: new Date(START + (partial.sequence ?? 0) * 500).toISOString(),
    monotonicMs: (partial.sequence ?? 0) * 500,
    pid: null,
    payload: {},
    ...partial,
  } as CanonicalEvent;
}

/** Snapshot 2 is the first sample, so its rates are UNAVAILABLE by design. */
function snapshot(sequence: number, overrides: Record<string, unknown> = {}): CanonicalEvent {
  const first = sequence === 2;
  return event({
    type: "process.snapshot",
    sequence,
    pid: CHILD_PID,
    payload: {
      pid: obs(CHILD_PID),
      capsEnginePid: obs(ENGINE_PID),
      ppid: obs(ENGINE_PID),
      command: obs("caps_cpu_burn"),
      state: obs("R"),
      rssBytes: obs(8 * 1024 * 1024),
      cpuPercent: first ? none() : der(50),
      threadCount: obs(1),
      cpuTimeMs: obs(sequence * 100),
      minorFaults: obs(100 * sequence),
      majorFaults: obs(0),
      wcharBytesPerSec: first ? none() : der(1024),
      rcharBytesPerSec: none(),
      ...overrides,
    },
  });
}

/** A complete, honest cpu_burn-shaped record. */
function cpuBurnEvents(): CanonicalEvent[] {
  return [
    event({ type: "execution.started", sequence: 0, timestamp: new Date(START).toISOString() }),
    event({ type: "process.started", sequence: 1, pid: CHILD_PID, timestamp: new Date(START + 200).toISOString(), payload: { label: "CAPS child" } }),
    snapshot(2),
    snapshot(3),
    snapshot(4),
    event({ type: "process.exited", sequence: 5, timestamp: new Date(START + 2200).toISOString(), pid: CHILD_PID, payload: { exitCode: 0, durationMs: 2000 } }),
    event({ type: "execution.completed", sequence: 6, timestamp: new Date(START + 2400).toISOString(), payload: { exitCode: 0 } }),
  ];
}

describe("process space construction", () => {
  it("creates a node only for observed PIDs", () => {
    const space = buildProcessSpace(cpuBurnEvents());
    expect(space.nodes.map((node) => node.pid)).toEqual([ENGINE_PID, CHILD_PID]);
    expect(space.counts.nodes).toBe(2);
  });

  it("creates no node at all when the record observed nothing", () => {
    const space = buildProcessSpace([]);
    expect(space.nodes).toEqual([]);
    expect(space.edges).toEqual([]);
    expect(space.counts.markers).toBe(0);
  });

  it("draws an edge only for a verified PPID match", () => {
    const verified = buildProcessSpace(cpuBurnEvents());
    expect(verified.edges).toHaveLength(1);
    expect(verified.edges[0]!.fromPid).toBe(ENGINE_PID);
    expect(verified.edges[0]!.toPid).toBe(CHILD_PID);
    expect(verified.edges[0]!.provenance).toBe("OBSERVED · PPID match");

    const mismatch = buildProcessSpace(
      cpuBurnEvents().map((ev) => (ev.type === "process.snapshot" ? snapshot(ev.sequence, { ppid: obs(9999) }) : ev)),
    );
    expect(mismatch.edges).toHaveLength(0);
    expect(mismatch.nodes.every((node) => node.parentVerified === false)).toBe(true);
  });

  it("never invents a second process for execvp()", () => {
    const space = buildProcessSpace(cpuBurnEvents());
    const child = space.nodes.find((node) => node.role === "child")!;
    // One PID, two images. execvp() replaces the image, it does not fork.
    expect(space.nodes.filter((node) => node.pid === CHILD_PID)).toHaveLength(1);
    expect(child.imageBefore).toBe("CAPS child");
    expect(child.imageAfter).toBe("caps_cpu_burn");
    expect(child.execAtMs).toBe(1000);
  });

  it("assigns depth and a deterministic lane", () => {
    const space = buildProcessSpace(cpuBurnEvents());
    expect(space.nodes.map((node) => [node.role, node.depth, node.slot])).toEqual([
      ["caps-engine", 0, 0],
      ["child", 1, 0],
    ]);
    // Same input, same layout, every time.
    const again = buildProcessSpace(cpuBurnEvents());
    expect(JSON.stringify(space.nodes)).toBe(JSON.stringify(again.nodes));
  });

  it("keeps siblings in creation-then-PID order", () => {
    const events = cpuBurnEvents();
    const second = event({ type: "process.started", sequence: 7, pid: 5002, timestamp: new Date(START + 400).toISOString(), payload: { label: "CAPS child" } });
    const space = buildProcessSpace([...events, second]);
    const children = space.nodes.filter((node) => node.role === "child");
    expect(children.map((node) => node.pid)).toEqual([CHILD_PID, 5002]);
    expect(children.map((node) => node.slot)).toEqual([0, 1]);
  });

  it("maps execution time onto Z and depth onto Y", () => {
    const space = buildProcessSpace(cpuBurnEvents());
    const scale = timeScale(space.spanMs);
    const child = space.nodes.find((node) => node.role === "child")!;
    const position = nodePosition(child, scale);
    expect(position.x).toBe(0);
    expect(position.y).toBeLessThan(0);
    expect(position.z).toBeCloseTo(200 * scale, 6);
  });

  it("removes a node when the record no longer contains its evidence", () => {
    const before = buildProcessSpace(cpuBurnEvents());
    expect(before.nodes).toHaveLength(2);
    // Only the execution-start event survives: no PID was observed, so no node.
    const after = buildProcessSpace([cpuBurnEvents()[0]!]);
    expect(after.nodes).toHaveLength(0);
    expect(after.edges).toHaveLength(0);
  });
});

describe("causal cursor state", () => {
  const space = buildProcessSpace(cpuBurnEvents());

  it("hides a process that has not started yet", () => {
    const child = space.nodes.find((node) => node.role === "child")!;
    expect(nodeStateAt(space, 0, child).present).toBe(false);
    expect(nodeStateAt(space, 0, child).state).toBe("PENDING");
  });

  it("shows a started process as running with the latest sample at or before the cursor", () => {
    const child = space.nodes.find((node) => node.role === "child")!;
    const state = nodeStateAt(space, 1400, child);
    expect(state.present).toBe(true);
    expect(state.state).toBe("RUNNING");
    expect(state.visual?.atMs).toBe(1000);
    expect(state.stateAgeMs).toBe(400);
  });

  it("never shows a future sample", () => {
    const child = space.nodes.find((node) => node.role === "child")!;
    const at1500 = nodeStateAt(space, 1500, child);
    expect(at1500.visual?.atMs).toBe(1500);
    // Before the first recorded sample there is no state to show at all.
    const at999 = nodeStateAt(space, 999, child);
    expect(at999.visual).toBeNull();
    expect(at999.stateAgeMs).toBeNull();
  });

  it("reports missing telemetry instead of a zero", () => {
    const child = space.nodes.find((node) => node.role === "child")!;
    // The first recorded sample cannot have a CPU rate: the backend says so.
    const state = nodeStateAt(space, 1000, child);
    expect(state.visual).not.toBeNull();
    expect(state.visual?.raw.cpuPercent).toBeNull();
    expect(state.visual?.unavailable.length).toBeGreaterThan(0);
  });

  it("keeps a reaped process in its terminal state", () => {
    const child = space.nodes.find((node) => node.role === "child")!;
    const after = nodeStateAt(space, space.spanMs, child);
    expect(after.state).toBe("COMPLETED");
    expect(after.terminal).toBe(true);
  });

  it("ends the engine node when the execution terminates, never leaving it running", () => {
    const engine = space.nodes.find((node) => node.role === "caps-engine")!;
    expect(nodeStateAt(space, space.spanMs, engine).state).toBe("COMPLETED");
    expect(nodeStateAt(space, space.spanMs, engine).terminal).toBe(true);
    // Before the terminal it is genuinely running, so the scene is not lying
    // in the other direction either.
    expect(nodeStateAt(space, 0, engine).state).toBe("RUNNING");
    expect(nodeStateAt(space, 0, engine).terminal).toBe(false);
  });

  it("leaves the engine running while the execution is still in flight", () => {
    const inFlight = buildProcessSpace(cpuBurnEvents().filter((ev) => ev.type !== "execution.completed"));
    const engine = inFlight.nodes.find((node) => node.role === "caps-engine")!;
    expect(nodeStateAt(inFlight, inFlight.spanMs, engine).state).toBe("RUNNING");
    expect(nodeStateAt(inFlight, inFlight.spanMs, engine).terminal).toBe(false);
  });

  it("a live cursor (null) means the newest evidence, so a finished execution is not still running", () => {
    const child = space.nodes.find((node) => node.role === "child")!;
    const engine = space.nodes.find((node) => node.role === "caps-engine")!;
    // Live view of a COMPLETED session must not claim anything is still running.
    expect(nodeStateAt(space, null, child).state).toBe("COMPLETED");
    expect(nodeStateAt(space, null, engine).state).toBe("COMPLETED");
    // And it must agree with the explicit end-of-record cursor.
    expect(spaceAt(space, null).map((s) => [s.key, s.state])).toEqual(spaceAt(space, space.spanMs).map((s) => [s.key, s.state]));
  });

  it("a live cursor reports the newest sample, not a null resource value", () => {
    const child = space.nodes.find((node) => node.role === "child")!;
    const live = nodeStateAt(space, null, child);
    expect(live.visual).not.toBeNull();
    expect(live.visual?.atMs).toBe(space.visualStates.get(CHILD_PID)?.at(-1)?.atMs);
  });

  it("reports a failed and a signalled terminal state from the record", () => {
    const failed = buildProcessSpace(
      cpuBurnEvents().map((ev) => (ev.type === "execution.completed" ? event({ type: "execution.failed", sequence: 6, timestamp: ev.timestamp, payload: { exitCode: 1 } }) : ev)),
    );
    const failedChild = failed.nodes.find((node) => node.role === "child")!;
    expect(nodeStateAt(failed, failed.spanMs, failedChild).state).toBe("FAILED");

    const signalled = buildProcessSpace([
      ...cpuBurnEvents().slice(0, 5),
      event({ type: "signal.received", sequence: 5, pid: CHILD_PID, timestamp: new Date(START + 2100).toISOString(), payload: { signal: 2 } }),
      event({ type: "process.exited", sequence: 6, pid: CHILD_PID, timestamp: new Date(START + 2200).toISOString(), payload: { exitCode: null } }),
      event({ type: "execution.failed", sequence: 7, timestamp: new Date(START + 2400).toISOString(), payload: { signal: 2 } }),
    ]);
    const signalledChild = signalled.nodes.find((node) => node.role === "child")!;
    const state = nodeStateAt(signalled, signalled.spanMs, signalledChild);
    expect(["SIGNALED", "FAILED"]).toContain(state.state);
  });

  it("is deterministic: the same telemetry yields the same 3D state", () => {
    const first = spaceAt(buildProcessSpace(cpuBurnEvents()), 1500);
    const second = spaceAt(buildProcessSpace(cpuBurnEvents()), 1500);
    expect(JSON.stringify(first.map((state) => [state.key, state.state, state.visual?.atMs]))).toBe(
      JSON.stringify(second.map((state) => [state.key, state.state, state.visual?.atMs])),
    );
  });

  it("follows the newest sample when the cursor is null", () => {
    const child = space.nodes.find((node) => node.role === "child")!;
    const state = nodeStateAt(space, null, child);
    expect(state.visual?.atMs).toBe(2000);
  });
});

describe("resource mapping", () => {
  it("bounds node size so a huge RSS cannot create a giant object", () => {
    expect(nodeRadius(64 * 1024)).toBeGreaterThanOrEqual(RADIUS_MIN);
    expect(nodeRadius(4 * 1024 * 1024 * 1024)).toBeLessThanOrEqual(RADIUS_MAX);
    expect(nodeRadius(null)).toBe(RADIUS_MIN);
    expect(nodeRadius(-1)).toBe(RADIUS_MIN);
    expect(nodeRadius(Number.NaN)).toBe(RADIUS_MIN);
  });

  it("scales monotonically with RSS", () => {
    expect(nodeRadius(1 * 1024 * 1024)).toBeLessThan(nodeRadius(64 * 1024 * 1024));
  });

  it("maps CPU to size in CPU mode and RSS in memory mode", () => {
    const space = buildProcessSpace(cpuBurnEvents());
    const child = space.nodes.find((node) => node.role === "child")!;
    const state = nodeStateAt(space, 2000, child);
    const cpuMode = radiusForMode(state, "cpu");
    const memoryMode = radiusForMode(state, "memory");
    expect(cpuMode).toBeGreaterThan(RADIUS_MIN);
    expect(memoryMode).toBeGreaterThan(RADIUS_MIN);

    const missing = nodeStateAt(space, 100, child);
    expect(radiusForMode(missing, "cpu")).toBe(RADIUS_MIN);
  });

  it("never grows the CAPS engine node, which has no samples", () => {
    const space = buildProcessSpace(cpuBurnEvents());
    const engine = space.nodes.find((node) => node.role === "caps-engine")!;
    expect(radiusForMode(nodeStateAt(space, 2000, engine), "memory")).toBe(RADIUS_MIN);
    expect(nodeStateAt(space, 2000, engine).visual).toBeNull();
  });
});

describe("ruler and time scale", () => {
  it("chooses a step that labels a real span", () => {
    expect(rulerStep(2400)).toBe(500);
    expect(rulerStep(20000)).toBe(5000);
    const ruler = buildRuler(20000);
    expect(ruler.ticksMs[0]).toBe(0);
    expect(ruler.ticksMs.at(-1)).toBeGreaterThanOrEqual(20000);
  });

  it("keeps the time axis readable for long and empty runs", () => {
    expect(timeScale(0)).toBeGreaterThan(0);
    expect(timeScale(600_000)).toBeGreaterThan(0);
    expect(timeScale(600_000) * 600_000).toBeLessThanOrEqual(26);
  });
});

describe("markers", () => {
  it("marks discrete lifecycle events, not every snapshot", () => {
    const space = buildProcessSpace(cpuBurnEvents());
    expect(space.markers.map((marker) => marker.type)).toEqual([
      "execution.started",
      "process.started",
      "process.exited",
      "execution.completed",
    ]);
  });

  it("ties a fork marker to the child node", () => {
    const space = buildProcessSpace(cpuBurnEvents());
    const fork = space.markers.find((marker) => marker.type === "process.started")!;
    expect(fork.nodeKey).toBe(`child:${CHILD_PID}`);
    expect(fork.label).toBe("fork()");
    expect(space.nodes.find((node) => node.key === fork.nodeKey)?.pid).toBe(CHILD_PID);
  });
});

describe("shared evidence", () => {
  it("reads the same samples the 2D view-model reads", () => {
    const events = cpuBurnEvents();
    const samples = collectSamples(events);
    const space = buildProcessSpace(events);
    const childStates = space.visualStates.get(CHILD_PID) ?? [];
    expect(childStates).toHaveLength(samples.length);
    expect(childStates.map((state) => state.atMs)).toEqual(samples.map((sample) => sample.atMs));
  });

  it("ignores an event stream with no snapshots", () => {
    const space = buildProcessSpace([
      event({ type: "execution.started", sequence: 0 }),
      event({ type: "process.started", sequence: 1, pid: CHILD_PID, payload: { label: "CAPS child" } }),
      event({ type: "process.exited", sequence: 2, pid: CHILD_PID, payload: { exitCode: 0 } }),
    ]);
    expect(space.counts.samples).toBe(0);
    const child = space.nodes.find((node) => node.role === "child") as SpaceNode;
    const state = nodeStateAt(space, 1000, child);
    expect(state.visual).toBeNull();
    expect(state.state).toBe("COMPLETED");
  });
});
