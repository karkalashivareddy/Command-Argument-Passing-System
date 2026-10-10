import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readProcessSnapshot } from "./collector.js";
import { FIRST_SAMPLE_RATE_REASON } from "./derive.js";
import { TelemetrySampler, type TelemetrySample, type TelemetryTarget } from "./sampler.js";
import { SNAPSHOT_METRIC_KEYS, type ProcessSnapshot } from "./types.js";

/**
 * A scripted procfs tree plus a scripted clock, so the sampler lifecycle can
 * be tested without depending on a real long-running process.
 */
class FakeProcess {
  readonly root: string;
  constructor(readonly pid = 41) {
    this.root = mkdtempSync(join(tmpdir(), "caps-sampler-"));
    this.dir = join(this.root, String(this.pid));
    mkdirSync(this.dir);
    writeFileSync(join(this.root, "uptime"), "10.00 2.00\n");
  }
  readonly capsEnginePid = 900;
  utime = 10;
  stime = 5;
  minflt = 1000;
  majflt = 2;
  rchar = 1_000_000;
  wchar = 500_000;
  readBytes = 4096;
  writeBytes = 0;
  startTicks = 500;
  present = true;
  private readonly dir: string;

  /** The snapshot timestamp the fake procfs implies: 5s after process start. */
  get startTimeIso(): string {
    return new Date(1_000_000 - 5_000).toISOString();
  }

  write(): void {
    if (!this.present) {
      rmSync(this.dir, { recursive: true, force: true });
      return;
    }
    const fields = Array(22).fill("0") as string[];
    fields[0] = "S";
    fields[1] = String(this.capsEnginePid);
    fields[2] = "8";
    fields[3] = "9";
    fields[7] = String(this.minflt);
    fields[9] = String(this.majflt);
    fields[11] = String(this.utime);
    fields[12] = String(this.stime);
    fields[17] = "1";
    fields[19] = String(this.startTicks);
    writeFileSync(join(this.dir, "stat"), `${this.pid} (workload) ${fields.join(" ")}`);
    writeFileSync(join(this.dir, "status"), [
      "Name:\tworkload", "State:\tS (sleeping)", `Pid:\t${this.pid}`, `PPid:\t${this.capsEnginePid}`,
      "VmSize:\t2048 kB", "VmRSS:\t1024 kB", "Threads:\t1",
      "voluntary_ctxt_switches:\t5", "nonvoluntary_ctxt_switches:\t1", "",
    ].join("\n"));
    writeFileSync(join(this.dir, "io"), [
      `rchar: ${this.rchar}`, `wchar: ${this.wchar}`, "syscr: 10", "syscw: 10",
      `read_bytes: ${this.readBytes}`, `write_bytes: ${this.writeBytes}`, "",
    ].join("\n"));
  }

  read(nowMs = 1_000_000): ProcessSnapshot {
    this.write();
    return readProcessSnapshot(this.pid, { procRoot: this.root, clockTicksPerSecond: 100, nowMs });
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

interface Harness {
  proc: FakeProcess;
  sampler: TelemetrySampler;
  emitted: TelemetrySample[];
  target: (overrides?: Partial<TelemetryTarget>) => TelemetryTarget;
  advanceMs: (ms: number) => void;
}

const harnesses: Harness[] = [];
const fixtures: FakeProcess[] = [];

function harness(): Harness {
  const proc = new FakeProcess();
  fixtures.push(proc);
  const emitted: TelemetrySample[] = [];
  const processes = new Map<number, FakeProcess>([[proc.pid, proc]]);
  let wall = 1_000_000;
  let monotonic = 10_000;
  const sampler = new TelemetrySampler({
    intervalMs: 500,
    emit: (sample) => emitted.push(sample),
    wallNow: () => wall,
    monotonicNow: () => monotonic,
    readSnapshot: (pid, nowMs) => {
      let process = processes.get(pid);
      if (!process) {
        process = new FakeProcess(pid);
        processes.set(pid, process);
        fixtures.push(process);
      }
      return process.read(nowMs);
    },
  });
  const built: Harness = {
    proc,
    sampler,
    emitted,
    target: (overrides = {}) => ({
      sessionId: "exec_test",
      pid: proc.pid,
      capsEnginePid: proc.capsEnginePid,
      processStartedAt: new Date(995_000).toISOString(),
      isFinalized: () => false,
      ...overrides,
    }),
    advanceMs: (ms: number) => {
      wall += ms;
      monotonic += ms;
    },
  };
  harnesses.push(built);
  return built;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const h of harnesses.splice(0)) h.sampler.close();
  for (const f of fixtures.splice(0)) f.dispose();
  vi.useRealTimers();
});

describe("TelemetrySampler cadence", () => {
  it("takes one immediate first sample and then one sample per interval", () => {
    const h = harness();
    h.sampler.start(h.target());

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]!.sessionId).toBe("exec_test");
    expect(h.emitted[0]!.pid).toBe(41);
    expect(h.sampler.isSampling("exec_test")).toBe(true);

    h.advanceMs(500);
    vi.advanceTimersByTime(500);
    h.advanceMs(500);
    vi.advanceTimersByTime(500);
    expect(h.emitted).toHaveLength(3);
  });

  it("reports every rate as UNAVAILABLE on the first sample and derives them on the second", () => {
    const h = harness();
    h.sampler.start(h.target());

    const first = h.emitted[0]!.snapshot;
    expect(first.cpuPercent).toMatchObject({ value: null, provenance: "UNAVAILABLE", reason: FIRST_SAMPLE_RATE_REASON });
    expect(first.rcharBytesPerSec.reason).toBe(FIRST_SAMPLE_RATE_REASON);
    // Absolute values are still real on the first sample.
    expect(first.rssBytes.value).toBe(1024 * 1024);
    expect(first.cpuTimeMs).toMatchObject({ value: 150, provenance: "DERIVED" });

    // 50 extra utime ticks at 100 Hz = 500 ms of CPU over a 1000 ms interval.
    h.proc.utime += 50;
    h.proc.rchar += 2048;
    h.proc.minflt += 400;
    h.advanceMs(1_000);
    vi.advanceTimersByTime(500);

    const second = h.emitted[1]!.snapshot;
    expect(second.cpuPercent).toMatchObject({ value: 50, provenance: "DERIVED" });
    expect(second.cpuPercent.source).toMatch(/one core/);
    expect(second.rcharBytesPerSec).toMatchObject({ value: 2048, provenance: "DERIVED" });
    expect(second.minorFaultsPerSec).toMatchObject({ value: 400, provenance: "DERIVED" });
    expect(second.majorFaultsPerSec).toMatchObject({ value: 0, provenance: "DERIVED" });
    // One tick, one combined snapshot: the same sample carries every metric.
    expect(Object.keys(second).filter((k) => k !== "identityStartTicks")).toHaveLength(SNAPSHOT_METRIC_KEYS.length + 1);
  });

  it("keeps one independent loop per active execution", () => {
    const h = harness();
    h.sampler.start(h.target({ sessionId: "exec_a" }));
    h.sampler.start(h.target({ sessionId: "exec_b" }));
    expect(h.sampler.activeSessionIds.sort()).toEqual(["exec_a", "exec_b"]);

    h.advanceMs(500);
    vi.advanceTimersByTime(500);
    expect(h.emitted.filter((s) => s.sessionId === "exec_a")).toHaveLength(2);
    expect(h.emitted.filter((s) => s.sessionId === "exec_b")).toHaveLength(2);

    h.sampler.stop("exec_a");
    h.advanceMs(500);
    vi.advanceTimersByTime(500);
    expect(h.emitted.filter((s) => s.sessionId === "exec_a")).toHaveLength(2);
    expect(h.emitted.filter((s) => s.sessionId === "exec_b")).toHaveLength(3);
    expect(h.sampler.activeSessionIds).toEqual(["exec_b"]);
  });

  it("keeps independent loops for every process in one pipeline execution", () => {
    const h = harness();
    h.sampler.start(h.target());
    h.sampler.start(h.target({ pid: 42 }));

    expect(h.emitted.map((sample) => sample.pid)).toEqual([41, 42]);
    expect(h.sampler.isSampling("exec_test", 41)).toBe(true);
    expect(h.sampler.isSampling("exec_test", 42)).toBe(true);
    expect(h.sampler.activeSessionIds).toEqual(["exec_test"]);

    h.advanceMs(500);
    vi.advanceTimersByTime(500);
    h.sampler.stop("exec_test", 41);
    h.advanceMs(500);
    vi.advanceTimersByTime(500);

    expect(h.emitted.filter((sample) => sample.pid === 41)).toHaveLength(2);
    expect(h.emitted.filter((sample) => sample.pid === 42)).toHaveLength(3);
    expect(h.sampler.isSampling("exec_test", 41)).toBe(false);
    expect(h.sampler.isSampling("exec_test", 42)).toBe(true);

    h.sampler.stop("exec_test");
    expect(h.sampler.activeSessionIds).toEqual([]);
  });

  it("ignores a repeated start for the same session", () => {
    const h = harness();
    h.sampler.start(h.target());
    h.sampler.start(h.target());
    h.advanceMs(500);
    vi.advanceTimersByTime(500);
    expect(h.emitted).toHaveLength(2);
  });
});

describe("TelemetrySampler identity and lifecycle", () => {
  it("rejects a PID whose PPID is not the gateway-spawned CAPS process and then stops", () => {
    const h = harness();
    h.sampler.start(h.target({ capsEnginePid: 4242 }));
    expect(h.emitted).toHaveLength(1);

    const snapshot = h.emitted[0]!.snapshot;
    for (const key of SNAPSHOT_METRIC_KEYS) {
      expect(snapshot[key], `${key} must not survive a rejected identity`).toMatchObject({ provenance: "UNAVAILABLE" });
      expect(snapshot[key].reason).toMatch(/PPID does not match/);
    }
    expect(h.sampler.isSampling("exec_test")).toBe(false);

    h.advanceMs(1_000);
    vi.advanceTimersByTime(1_000);
    expect(h.emitted).toHaveLength(1);
  });

  it("rejects a recycled PID whose start time does not match the CAPS event", () => {
    const h = harness();
    h.sampler.start(h.target({ processStartedAt: new Date(0).toISOString() }));
    expect(h.emitted[0]!.snapshot.rssBytes).toMatchObject({ provenance: "UNAVAILABLE" });
    expect(h.emitted[0]!.snapshot.rssBytes.reason).toMatch(/PID reuse|start time does not match/i);
    expect(h.sampler.isSampling("exec_test")).toBe(false);
  });

  it("stops when the tracked identity changes mid-execution", () => {
    const h = harness();
    h.sampler.start(h.target());
    expect(h.sampler.isSampling("exec_test")).toBe(true);

    // Same PID number, different process: start ticks moved.
    h.proc.startTicks = 4_242;
    h.advanceMs(500);
    vi.advanceTimersByTime(500);

    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1]!.snapshot.minorFaults).toMatchObject({ provenance: "UNAVAILABLE" });
    expect(h.emitted[1]!.snapshot.minorFaults.reason).toMatch(/identity changed/);
    expect(h.sampler.isSampling("exec_test")).toBe(false);

    h.advanceMs(1_000);
    vi.advanceTimersByTime(1_000);
    expect(h.emitted).toHaveLength(2);
  });

  it("reports a process that exits mid-sample once, then stops", () => {
    const h = harness();
    h.sampler.start(h.target());
    h.proc.present = false;
    h.advanceMs(500);
    vi.advanceTimersByTime(500);

    expect(h.emitted).toHaveLength(2);
    const vanished = h.emitted[1]!.snapshot;
    expect(vanished.rssBytes).toMatchObject({ value: null, provenance: "UNAVAILABLE" });
    expect(vanished.rssBytes.reason).toMatch(/exited|disappeared/i);
    // The PID itself came from the CAPS event, not from procfs.
    expect(vanished.pid).toMatchObject({ value: 41, provenance: "OBSERVED" });
    expect(h.sampler.isSampling("exec_test")).toBe(false);

    h.advanceMs(1_000);
    vi.advanceTimersByTime(1_000);
    expect(h.emitted).toHaveLength(2);
  });

  it("emits nothing after the execution is finalized, even if a tick was already due", () => {
    const h = harness();
    let finalized = false;
    h.sampler.start(h.target({ isFinalized: () => finalized }));
    expect(h.emitted).toHaveLength(1);

    finalized = true;
    h.advanceMs(500);
    vi.advanceTimersByTime(500);
    expect(h.emitted).toHaveLength(1);
    expect(h.sampler.isSampling("exec_test")).toBe(false);

    // Further ticks stay silent for good.
    h.advanceMs(5_000);
    vi.advanceTimersByTime(5_000);
    expect(h.emitted).toHaveLength(1);
  });

  it("close() stops every loop", () => {
    const h = harness();
    h.sampler.start(h.target({ sessionId: "exec_a" }));
    h.sampler.start(h.target({ sessionId: "exec_b" }));
    h.sampler.close();
    expect(h.sampler.activeSessionIds).toEqual([]);

    h.advanceMs(2_000);
    vi.advanceTimersByTime(2_000);
    expect(h.emitted).toHaveLength(2);
  });

  it("records the CAPS engine PID from the gateway child process as OBSERVED", () => {
    const h = harness();
    h.sampler.start(h.target());
    expect(h.emitted[0]!.snapshot.capsEnginePid).toEqual({
      value: 900,
      provenance: "OBSERVED",
      source: "gateway child_process.spawn",
    });
  });

  it("refuses to sample at all when the CAPS engine PID is unknown", () => {
    const h = harness();
    h.sampler.start(h.target({ capsEnginePid: null }));
    const snapshot = h.emitted[0]!.snapshot;
    expect(snapshot.rssBytes.reason).toMatch(/CAPS process PID is unknown/);
    expect(h.sampler.isSampling("exec_test")).toBe(false);
  });

  it("rejects a decreasing counter instead of reporting a negative rate", () => {
    const h = harness();
    h.sampler.start(h.target());
    h.proc.rchar = 10; // the process could not lose bytes
    h.advanceMs(500);
    vi.advanceTimersByTime(500);

    const second = h.emitted[1]!.snapshot;
    expect(second.rcharBytes.value).toBe(10); // the observed counter is still real
    expect(second.rcharBytesPerSec).toMatchObject({ value: null, provenance: "UNAVAILABLE" });
    expect(second.rcharBytesPerSec.reason).toMatch(/decreased between samples/);
    // An unrelated rate from the same tick is unaffected.
    expect(second.cpuPercent.provenance).toBe("DERIVED");
  });

  it("reads the real procfs shape once per tick", () => {
    const h = harness();
    h.sampler.start(h.target());
    const statPath = join(h.proc.root, String(h.proc.pid), "stat");
    expect(statSync(statPath).isFile()).toBe(true);
    expect(h.emitted[0]!.snapshot.command).toMatchObject({ value: "workload", provenance: "OBSERVED" });
  });
});
