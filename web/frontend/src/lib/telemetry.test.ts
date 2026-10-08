import { describe, expect, it } from "vitest";

import type { CanonicalEvent, TelemetryMetric } from "../types/observability";
import {
  buildAnnotations,
  buildInspector,
  buildResourceTracks,
  buildVisualStates,
  collectSamples,
  deriveRuntimePeaks,
  metricValue,
  sampleAt,
  sequenceIntegrity,
  thinIndices,
} from "./telemetry";

/** Overrides applied on top of a complete, provenance-carrying snapshot. */
type Fields = Record<string, TelemetryMetric<number | string>>;

function observed<T>(value: T): TelemetryMetric<T> {
  return { value, provenance: "OBSERVED", source: "/proc/100/stat" };
}
function derived<T>(value: T): TelemetryMetric<T> {
  return { value, provenance: "DERIVED", source: "sample delta" };
}
function missing(reason: string): TelemetryMetric<number> {
  return { value: null, provenance: "UNAVAILABLE", source: "/proc/100/stat", reason };
}

const FIRST_SAMPLE_REASON = "First sample for this process: a rate needs two valid samples separated by a measured interval";

function snapshot(fields: Fields): Fields {
  return {
    pid: observed(100),
    capsEnginePid: observed(40),
    ppid: observed(40),
    processGroupId: observed(400),
    sessionId: observed(4),
    state: observed("R"),
    command: observed("caps_cpu_burn"),
    startTime: observed("2026-01-01T10:00:00.000Z"),
    elapsedMs: derived(0),
    cpuUserMs: observed(0),
    cpuSystemMs: observed(0),
    cpuTimeMs: observed(0),
    cpuPercent: missing(FIRST_SAMPLE_REASON),
    rssBytes: observed(4 * 1024 * 1024),
    virtualMemoryBytes: observed(8 * 1024 * 1024),
    threadCount: observed(1),
    voluntaryContextSwitches: observed(10),
    nonVoluntaryContextSwitches: observed(1),
    minorFaults: observed(100),
    majorFaults: observed(0),
    minorFaultsPerSec: missing(FIRST_SAMPLE_REASON),
    majorFaultsPerSec: missing(FIRST_SAMPLE_REASON),
    readBytes: observed(0),
    writeBytes: observed(0),
    rcharBytes: observed(0),
    wcharBytes: observed(0),
    readBytesPerSec: missing(FIRST_SAMPLE_REASON),
    writeBytesPerSec: missing(FIRST_SAMPLE_REASON),
    rcharBytesPerSec: missing(FIRST_SAMPLE_REASON),
    wcharBytesPerSec: missing(FIRST_SAMPLE_REASON),
    ...fields,
  };
}

const START = Date.parse("2026-01-01T10:00:00.000Z");

let sequence = 0;
function events(...samples: Fields[]): CanonicalEvent[] {
  const list: CanonicalEvent[] = [
    {
      id: "e0",
      sessionId: "session-1",
      sequence: 0,
      type: "process.started",
      source: "gateway",
      timestamp: new Date(START).toISOString(),
      monotonicMs: null,
      pid: 100,
      payload: { pid: 100 },
    },
  ];
  samples.forEach((fields, index) => {
    const at = START + index * 500;
    list.push({
      id: `snap-${index}`,
      sessionId: "session-1",
      sequence: list.length,
      type: "process.snapshot",
      source: "gateway",
      timestamp: new Date(at).toISOString(),
      monotonicMs: index * 500,
      pid: 100,
      payload: snapshot({ ...fields, elapsedMs: derived(index * 500) }) as unknown as Record<string, unknown>,
    });
  });
  sequence = list.length;
  return list;
}

const RAMPS_UP: Fields[] = [
  { cpuTimeMs: observed(0), cpuPercent: missing(FIRST_SAMPLE_REASON), rssBytes: observed(4 * 1024 * 1024), wcharBytes: observed(0), minorFaults: observed(100), majorFaults: observed(0) },
  { cpuTimeMs: observed(500), cpuPercent: derived(100), rssBytes: observed(8 * 1024 * 1024), wcharBytes: observed(64 * 1024), wcharBytesPerSec: derived(128 * 1024), minorFaults: observed(200), majorFaults: observed(2), minorFaultsPerSec: derived(200), majorFaultsPerSec: derived(4) },
  { cpuTimeMs: observed(1_500), cpuPercent: derived(200), rssBytes: observed(16 * 1024 * 1024), wcharBytes: observed(64 * 1024), wcharBytesPerSec: derived(0), minorFaults: observed(210), majorFaults: observed(2), minorFaultsPerSec: derived(20), majorFaultsPerSec: derived(0) },
  { cpuTimeMs: observed(1_600), cpuPercent: derived(20), rssBytes: observed(16 * 1024 * 1024), wcharBytes: observed(64 * 1024), wcharBytesPerSec: derived(0), minorFaults: observed(210), majorFaults: observed(2), minorFaultsPerSec: derived(0), majorFaultsPerSec: derived(0) },
];

describe("metricValue", () => {
  it("refuses to read a value the backend marked unavailable", () => {
    expect(metricValue({ value: 42, provenance: "OBSERVED" })).toBe(42);
    expect(metricValue({ value: 42, provenance: "DERIVED" })).toBe(42);
    expect(metricValue({ value: 99, provenance: "UNAVAILABLE", reason: "gone" })).toBeNull();
    expect(metricValue({ value: null, provenance: "OBSERVED" })).toBeNull();
    expect(metricValue(undefined)).toBeNull();
    expect(metricValue("7")).toBeNull();
  });
});

describe("collectSamples", () => {
  it("keeps only real snapshot payloads and shares one time origin", () => {
    const all = events(...RAMPS_UP);
    const samples = collectSamples(all);
    expect(samples).toHaveLength(4);
    expect(samples.map((s) => s.atMs)).toEqual([0, 500, 1000, 1500]);
    expect(samples[0]!.index).toBe(0);
    expect(samples.at(-1)!.atSec).toBe(1.5);
  });

  it("ignores a snapshot event with no payload rather than throwing", () => {
    const broken: CanonicalEvent = {
      id: "bad", sessionId: "s", sequence: 1, type: "process.snapshot", source: "gateway",
      timestamp: new Date(START).toISOString(), monotonicMs: null, pid: null, payload: null as unknown as Record<string, unknown>,
    };
    expect(collectSamples([broken])).toHaveLength(0);
  });
});

describe("sampleAt", () => {
  const samples = collectSamples(events(...RAMPS_UP));

  it("returns the nearest sample to the cursor", () => {
    expect(sampleAt(samples, 0)!.atMs).toBe(0);
    expect(sampleAt(samples, 240)!.atMs).toBe(0);
    expect(sampleAt(samples, 300)!.atMs).toBe(500);
    expect(sampleAt(samples, 1_400)!.atMs).toBe(1500);
  });

  it("follows the newest sample when there is no cursor, and stays null when empty", () => {
    expect(sampleAt(samples, null)!.atMs).toBe(1500);
    expect(sampleAt([], 0)).toBeNull();
  });
});

describe("buildResourceTracks", () => {
  it("plots five honest tracks and never turns an unavailable rate into a zero", () => {
    const model = buildResourceTracks(collectSamples(events(...RAMPS_UP)));
    expect(model.tracks.map((t) => t.spec.id)).toEqual(["cpu", "memory", "ioChars", "ioBlocks", "faults"]);
    expect(model.rows).toHaveLength(4);
    // The first sample has no rate at all: the row must be null, not 0.
    expect(model.rows[0]!.cpuPercent).toBeNull();
    expect(model.rows[0]!.wcharKiBps).toBeNull();
    expect(model.rows[0]!.minorFaultsPerSec).toBeNull();
    expect(model.rows[1]!.cpuPercent).toBe(100);
    expect(model.rows[1]!.wcharKiBps).toBe(128);
    // A flat counter is a real measured zero rate.
    expect(model.rows[2]!.wcharKiBps).toBe(0);
    expect(model.rows[1]!.rssMiB).toBe(8);
    expect(model.spanSeconds).toBe(1.5);
  });

  it("finds each track's peak and keeps the CPU floor at one saturated core", () => {
    const model = buildResourceTracks(collectSamples(events(...RAMPS_UP)));
    const cpu = model.tracks.find((t) => t.spec.id === "cpu")!;
    const memory = model.tracks.find((t) => t.spec.id === "memory")!;
    const faults = model.tracks.find((t) => t.spec.id === "faults")!;
    expect(cpu.peak).toMatchObject({ key: "cpuPercent", value: 200, atSec: 1 });
    expect(cpu.domain[1]).toBeGreaterThanOrEqual(100);
    expect(memory.peak).toMatchObject({ value: 16, atSec: 1 });
    expect(faults.peak).toMatchObject({ key: "minorFaultsPerSec", value: 200, atSec: 0.5 });
    // Block I/O was never observed: it has no peak at all rather than a fake 0.
    const blocks = model.tracks.find((t) => t.spec.id === "ioBlocks")!;
    expect(blocks.peak).toBeNull();
  });

  it("flags a single-sample session so the UI can explain the missing rates", () => {
    const model = buildResourceTracks(collectSamples(events(RAMPS_UP[0]!)));
    expect(model.ratesUnavailable).toBe(true);
    expect(model.rows).toHaveLength(1);
  });

  it("thins long sessions for drawing while keeping every peak and both ends", () => {
    const many: Fields[] = [];
    for (let i = 0; i < 100; i++) {
      many.push({ rssBytes: observed((i === 73 ? 64 : 1) * 1024 * 1024), cpuPercent: derived(i === 50 ? 900 : 10) });
    }
    const model = buildResourceTracks(collectSamples(events(...many)), { maxPoints: 20 });
    expect(model.rawSampleCount).toBe(100);
    expect(model.thinned).toBe(true);
    expect(model.rows.length).toBeLessThanOrEqual(22);
    expect(model.rows[0]!.rssMiB).toBe(1);
    expect(model.rows.at(-1)!.rssMiB).toBe(1);
    // Both spike samples survived the thinning.
    expect(model.rows.some((row) => row.rssMiB === 64)).toBe(true);
    expect(model.rows.some((row) => row.cpuPercent === 900)).toBe(true);
    // Rows stay sorted and aligned for the shared cursor.
    expect(model.rows.map((r) => r.t)).toEqual([...model.rows.map((r) => r.t)].sort((a, b) => a - b));
  });
});

describe("thinIndices", () => {
  it("returns every index when the series is short enough", () => {
    expect(thinIndices(3, 10)).toEqual([0, 1, 2]);
  });

  it("always keeps the first, the last, and the requested indices", () => {
    const keep = thinIndices(100, 10, [42, 7]);
    expect(keep[0]).toBe(0);
    expect(keep.at(-1)).toBe(99);
    expect(keep).toContain(42);
    expect(keep).toContain(7);
    expect([...keep].sort((a, b) => a - b)).toEqual(keep);
    expect(new Set(keep).size).toBe(keep.length);
  });
});

describe("buildInspector", () => {
  const samples = collectSamples(events(...RAMPS_UP));

  it("shows exactly the sample under the cursor, with the backend's own reasons", () => {
    const first = buildInspector(samples, 0);
    expect(first.sample!.atMs).toBe(0);
    const rate = first.sections.find((s) => s.id === "cpu")!.items.find((i) => i.label === "CPU util")!;
    expect(rate.display).toBe("UNAVAILABLE");
    expect(rate.metric.reason).toBe(FIRST_SAMPLE_REASON);
    expect(first.unavailable.some((u) => u.reason === FIRST_SAMPLE_REASON)).toBe(true);

    const middle = buildInspector(samples, 1_000);
    const midRate = middle.sections.find((s) => s.id === "cpu")!.items.find((i) => i.label === "CPU util")!;
    expect(midRate.display).toBe("200.0%");
    expect(midRate.metric.provenance).toBe("DERIVED");
  });

  it("states what is not collected at all instead of implying coverage", () => {
    const inspector = buildInspector(samples, 0);
    const reasons = inspector.unavailable.map((u) => `${u.metric}: ${u.reason}`);
    expect(reasons.some((r) => r.startsWith("systemCpuPercent"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("networkBytes"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("diskLatency"))).toBe(true);
  });

  it("separates character I/O from block-device I/O", () => {
    const io = buildInspector(samples, 500).sections.find((s) => s.id === "io")!;
    const labels = io.items.map((i) => i.label);
    expect(labels).toContain("Read chars (total)");
    expect(labels).toContain("Write chars (total)");
    expect(labels).toContain("Block write (total)");
    const rate = io.items.find((i) => i.label === "Write rate")!;
    expect(rate.display).toBe("128.0 KiB/s");
  });

  it("returns an empty inspector when nothing was sampled", () => {
    expect(buildInspector([], 0)).toMatchObject({ sample: null, sections: [] });
  });
});

describe("deriveRuntimePeaks", () => {
  it("mirrors the gateway's peaks, rates, and cumulative totals", () => {
    const peaks = deriveRuntimePeaks(events(...RAMPS_UP));
    expect(peaks.sampleCount).toBe(4);
    expect(peaks.peakRssBytes).toMatchObject({ value: 16 * 1024 * 1024, atTimeMs: 1000 });
    // Upper-median convention, identical to the gateway's computeRuntimePeaks.
    expect(peaks.medianRssBytes).toBe(16 * 1024 * 1024);
    expect(peaks.peakCpuPercent).toMatchObject({ value: 200, atTimeMs: 1000 });
    expect(peaks.cpuTimeMs).toBe(1_600);
    expect(peaks.peakMinorFaults).toMatchObject({ value: 210 });
    expect(peaks.peakMajorFaultsPerSec).toMatchObject({ value: 4, atTimeMs: 500 });
    expect(peaks.peakWcharBytesPerSec).toMatchObject({ value: 128 * 1024 });
    // The last valid observation of a cumulative counter is the session total.
    expect(peaks.totalWcharBytes).toBe(64 * 1024);
    expect(peaks.totalRcharBytes).toBe(0);
  });

  it("keeps the last valid total when the final sample is unavailable", () => {
    const peaks = deriveRuntimePeaks(events(...RAMPS_UP, { rssBytes: missing("process vanished"), wcharBytes: missing("process vanished") }));
    expect(peaks.sampleCount).toBe(5);
    expect(peaks.totalWcharBytes).toBe(64 * 1024);
    expect(peaks.peakRssBytes?.value).toBe(16 * 1024 * 1024);
  });

  it("needs two samples before it reports a median", () => {
    const one = deriveRuntimePeaks(events(RAMPS_UP[0]!));
    expect(one.peakRssBytes?.value).toBe(4 * 1024 * 1024);
    expect(one.medianRssBytes).toBeNull();
    const two = deriveRuntimePeaks(events(RAMPS_UP[0]!, RAMPS_UP[1]!));
    expect(two.medianRssBytes).toBe(8 * 1024 * 1024);
  });
});

describe("buildVisualStates", () => {
  it("normalizes against the observed peak and keeps the raw values", () => {
    const states = buildVisualStates(collectSamples(events(...RAMPS_UP)));
    expect(states).toHaveLength(4);
    expect(states[1]!.cpu).toBe(0.5);
    expect(states[2]!.cpu).toBe(1);
    expect(states[2]!.memory).toBe(1);
    expect(states[0]!.memory).toBe(0.25);
    expect(states[0]!.cpu).toBeNull();
    // `raw` carries provenance, so the assertion is on `.value` and the class is
    // checked alongside it. Asserting only the value would pass whether the
    // metric was UNAVAILABLE or a genuine zero, which is the distinction this
    // whole boundary exists to keep.
    expect(states[0]!.raw.cpuPercent.value).toBeNull();
    expect(states[0]!.raw.cpuPercent.provenance).toBe("UNAVAILABLE");
    expect(states[0]!.raw.cpuPercent.reason).toBe(FIRST_SAMPLE_REASON);
    expect(states[0]!.unavailable.some((u) => u.reason === FIRST_SAMPLE_REASON)).toBe(true);
    expect(states[1]!.io).toBe(1);
    expect(states[1]!.raw.wcharBytesPerSec.value).toBe(128 * 1024);
    expect(states[1]!.pid).toBe(100);
    expect(states[1]!.capsEnginePid).toBe(40);
    expect(states[1]!.sequence).toBeGreaterThan(0);
  });

  /*
   * Provenance survives the boundary into the 3D view-model.
   *
   * These are the assertions that were impossible to write before `raw` stopped
   * being a bag of numbers. Previously there was no way to ask a visual state
   * whether a value was derived, so the scene, the HUD, the node table and the
   * tooltip all had to treat an OBSERVED gauge and nine DERIVED rates as the same
   * kind of thing.
   */
  it("keeps provenance attached to every recorded value", () => {
    const states = buildVisualStates(collectSamples(events(...RAMPS_UP)));
    const sampled = states[2]!;

    // RSS is read straight out of /proc/<pid>/status.
    expect(sampled.raw.rssBytes.provenance).toBe("OBSERVED");
    // CPU utilization is a delta of two samples, so it can never be observed.
    expect(sampled.raw.cpuPercent.provenance).toBe("DERIVED");
    expect(sampled.raw.minorFaultsPerSec.provenance).toBe("DERIVED");
    expect(sampled.raw.majorFaultsPerSec.provenance).toBe("DERIVED");
  });

  it("distinguishes the character counters from the storage counters", () => {
    const sampled = buildVisualStates(collectSamples(events(...RAMPS_UP)))[2]!;
    // Both are per-second rates, so both are DERIVED, but they count different
    // physical things. The io lens takes a max over all four, so without these
    // notes it would label a character count as bytes.
    expect(sampled.raw.rcharBytesPerSec.unitNote).toMatch(/characters/i);
    expect(sampled.raw.wcharBytesPerSec.unitNote).toMatch(/characters/i);
    expect(sampled.raw.readBytesPerSec.unitNote).toMatch(/storage device/i);
    expect(sampled.raw.writeBytesPerSec.unitNote).toMatch(/storage device/i);
  });

  it("reports every absent metric, not a hand-picked four", () => {
    // The unavailable list used to inspect cpuPercent, rssBytes, minorFaults and
    // threadCount only, so the panel meant to explain missing telemetry claimed
    // a process was fully measured while seven of its metrics were absent.
    const first = buildVisualStates(collectSamples(events(...RAMPS_UP)))[0]!;
    const reported = first.unavailable.map((u) => u.metric);
    for (const metric of [
      "cpuPercent",
      "rcharBytesPerSec",
      "wcharBytesPerSec",
      "readBytesPerSec",
      "writeBytesPerSec",
      "minorFaultsPerSec",
      "majorFaultsPerSec",
    ]) {
      expect(reported).toContain(metric);
    }
  });

  it("is a plain serializable object a 3D scene could consume directly", () => {
    const state = buildVisualStates(collectSamples(events(RAMPS_UP[1]!)))[0]!;
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state.cpu).toBeGreaterThanOrEqual(0);
    expect(state.cpu).toBeLessThanOrEqual(1);
  });
});

describe("lifecycle helpers", () => {
  it("marks lifecycle events, not samples, as annotations", () => {
    const all = events(RAMPS_UP[0]!);
    all.push({
      id: "exit", sessionId: "session-1", sequence: sequence++, type: "process.exited", source: "caps",
      timestamp: new Date(START + 600).toISOString(), monotonicMs: 600, pid: 100, payload: { exitCode: 0 },
    });
    const annotations = buildAnnotations(all);
    expect(annotations.map((a) => a.type)).toEqual(["process.started", "process.exited"]);
    expect(annotations[1]!.tone).toBe("end");
    expect(annotations[1]!.t).toBeCloseTo(0.6);
  });

  it("detects a gap in the event sequence", () => {
    const all = events(RAMPS_UP[0]!);
    expect(sequenceIntegrity(all)).toEqual({ contiguous: true, gaps: 0, missingSequences: 0 });
    all[1]!.sequence = 5;
    expect(sequenceIntegrity(all)).toEqual({ contiguous: false, gaps: 1, missingSequences: 4 });
  });
});
