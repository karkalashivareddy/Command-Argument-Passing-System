import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { markUnavailable, parseKilobytes, parseProcIo, parseProcStat, parseProcStatus, ProcParseError, readProcessSnapshot } from "./collector.js";
import { SNAPSHOT_METRIC_KEYS } from "./types.js";

const roots: string[] = [];

function statLine(pid = 41, comm = "weird ) process name"): string {
  const fields = Array(22).fill("0") as string[];
  fields[0] = "S"; // field 3, state
  fields[1] = "7"; // ppid
  fields[2] = "8"; // pgrp
  fields[3] = "9"; // session
  fields[7] = "1234"; // minflt
  fields[9] = "6"; // majflt
  fields[11] = "10"; // utime
  fields[12] = "5"; // stime
  fields[17] = "2"; // num_threads
  fields[19] = "500"; // starttime
  return `${pid} (${comm}) ${fields.join(" ")}`;
}

const IO_FIXTURE = [
  "rchar: 3276879", "wchar: 3282724", "syscr: 412", "syscw: 402",
  "read_bytes: 1068", "write_bytes: 0", "cancelled_write_bytes: 0", "",
].join("\n");

function fixtureRoot(pid = 41, status = true, io = true): string {
  const root = mkdtempSync(join(tmpdir(), "caps-procfs-"));
  roots.push(root);
  mkdirSync(join(root, String(pid)));
  writeFileSync(join(root, "uptime"), "10.00 2.00\n");
  writeFileSync(join(root, String(pid), "stat"), statLine(pid));
  if (status) {
    writeFileSync(join(root, String(pid), "status"), [
      "Name:\tprocess name", "State:\tS (sleeping)", "Pid:\t41", "PPid:\t7", "VmSize:\t1200 kB", "VmRSS:\t300 kB", "Threads:\t2", "voluntary_ctxt_switches:\t12", "nonvoluntary_ctxt_switches:\t3", "",
    ].join("\n"));
  }
  if (io) writeFileSync(join(root, String(pid), "io"), IO_FIXTURE);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("procfs parsing and normalization", () => {
  it("parses comm values with spaces and closing parentheses using the last delimiter", () => {
    const stat = parseProcStat(statLine());
    expect(stat).toMatchObject({ pid: 41, command: "weird ) process name", state: "S", ppid: 7, processGroupId: 8, sessionId: 9, userTicks: 10, systemTicks: 5, threadCount: 2, startTicks: 500 });
  });

  it("rejects malformed or too-short stat records", () => {
    expect(() => parseProcStat("not stat")).toThrow(ProcParseError);
    expect(() => parseProcStat("41 (x) S 1 2")).toThrow(ProcParseError);
  });

  it("parses status keys and kB values without turning missing data into zero", () => {
    const status = parseProcStatus("VmRSS:\t300 kB\nThreads:\t2\n");
    expect(parseKilobytes(status.get("VmRSS"))).toBe(307200);
    expect(parseKilobytes(status.get("VmPeak"))).toBeNull();
    expect(parseKilobytes("not available")).toBeNull();
  });

  it("normalizes an observed proc snapshot and derives elapsed and CPU time with supplied clock ticks", () => {
    const root = fixtureRoot();
    const snapshot = readProcessSnapshot(41, { procRoot: root, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    expect(snapshot.pid).toMatchObject({ value: 41, provenance: "OBSERVED" });
    expect(snapshot.ppid).toMatchObject({ value: 7, provenance: "OBSERVED" });
    expect(snapshot.processGroupId.value).toBe(8);
    expect(snapshot.sessionId.value).toBe(9);
    expect(snapshot.elapsedMs).toMatchObject({ value: 5000, provenance: "DERIVED" });
    expect(snapshot.cpuUserMs).toMatchObject({ value: 100, provenance: "DERIVED" });
    expect(snapshot.cpuSystemMs.value).toBe(50);
    // Total CPU time is the sum of the same sample, never a separate read.
    expect(snapshot.cpuTimeMs).toMatchObject({ value: 150, provenance: "DERIVED" });
    expect(snapshot.cpuTimeMs.source).toMatch(/utime \+ stime/);
    expect(snapshot.rssBytes).toMatchObject({ value: 307200, provenance: "OBSERVED" });
    expect(snapshot.virtualMemoryBytes.value).toBe(1_228_800);
    expect(snapshot.threadCount.value).toBe(2);
    expect(snapshot.voluntaryContextSwitches.value).toBe(12);
    expect(snapshot.identityStartTicks).toBe(500);
  });

  it("reports a vanished PID and missing status fields as unavailable instead of zero", () => {
    const root = fixtureRoot();
    const missing = readProcessSnapshot(99, { procRoot: root, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    expect(missing.pid).toMatchObject({ value: 99, provenance: "OBSERVED" });
    expect(missing.state).toMatchObject({ value: null, provenance: "UNAVAILABLE" });
    expect(missing.state.reason).toMatch(/exited|disappeared/i);

    const statusRoot = fixtureRoot(42, false);
    const noStatus = readProcessSnapshot(42, { procRoot: statusRoot, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    expect(noStatus.rssBytes).toMatchObject({ value: null, provenance: "UNAVAILABLE" });
    expect(noStatus.threadCount.value).toBe(2); // stat still independently observes it.
  });

  it("rejects a proc record whose reported PID differs from the CAPS-owned PID", () => {
    const root = fixtureRoot(41);
    writeFileSync(join(root, "41", "stat"), statLine(99));
    const snapshot = readProcessSnapshot(41, { procRoot: root, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    expect(snapshot.state).toMatchObject({ value: null, provenance: "UNAVAILABLE" });
    expect(snapshot.state.reason).toMatch(/did not match/i);
  });
});

describe("/proc/<pid>/io and fault counters", () => {
  it("parses only the counters it understands and ignores the rest", () => {
    const io = parseProcIo(IO_FIXTURE);
    expect(io).toEqual({
      rchar: 3276879,
      wchar: 3282724,
      syscr: 412,
      syscw: 402,
      readBytes: 1068,
      writeBytes: 0,
    });
    // cancelled_write_bytes is deliberately not surfaced.
    expect(Object.keys(io)).not.toContain("cancelled_write_bytes");
  });

  it("omits absent counters instead of defaulting them to zero", () => {
    expect(parseProcIo("rchar: 10\n")).toEqual({ rchar: 10 });
    expect(parseProcIo("")).toEqual({});
    expect(parseProcIo("syscr: not-a-number\n")).toEqual({});
  });

  it("reports syscall-layer character counters and block counters as OBSERVED with the procfs path", () => {
    const root = fixtureRoot();
    const snapshot = readProcessSnapshot(41, { procRoot: root, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    expect(snapshot.rcharBytes).toEqual({ value: 3276879, provenance: "OBSERVED", source: "/proc/41/io" });
    expect(snapshot.wcharBytes).toEqual({ value: 3282724, provenance: "OBSERVED", source: "/proc/41/io" });
    // A page-cache-absorbed write is legitimately zero and must stay zero.
    expect(snapshot.writeBytes).toEqual({ value: 0, provenance: "OBSERVED", source: "/proc/41/io" });
    expect(snapshot.readBytes.value).toBe(1068);
  });

  it("reports page-fault counters from the stat record", () => {
    const root = fixtureRoot();
    const snapshot = readProcessSnapshot(41, { procRoot: root, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    expect(snapshot.minorFaults).toEqual({ value: 1234, provenance: "OBSERVED", source: "/proc/41/stat field minflt" });
    expect(snapshot.majorFaults).toEqual({ value: 6, provenance: "OBSERVED", source: "/proc/41/stat field majflt" });
  });

  it("derives one stable start time for the same process across samples", () => {
    // The start time is an identity value: the frontend compares it across
    // samples to refuse a recycled PID. Deriving it from the wall clock made it
    // drift by a millisecond between samples of one process, so the guard
    // rejected the process's own samples. It must be a pure function of the
    // kernel's btime and start ticks, whatever the wall clock says.
    const root = fixtureRoot();
    writeFileSync(join(root, "stat"), ["cpu  1 2 3", "btime 1700000000", "processes 42", ""].join("\n"));
    const first = readProcessSnapshot(41, { procRoot: root, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    // A later sample: uptime and the wall clock have both moved on.
    writeFileSync(join(root, "uptime"), "10.53 2.00\n");
    const second = readProcessSnapshot(41, { procRoot: root, clockTicksPerSecond: 100, nowMs: 1_000_537 });

    expect(first.startTime.value).toBe("2023-11-14T22:13:25.000Z");
    expect(second.startTime.value).toBe(first.startTime.value);
    // The stable path is a pure function of kernel values, not of "now".
    expect(first.startTime.source).toContain("btime");
    // Elapsed is a duration, so it is still expected to grow between samples.
    expect(second.elapsedMs.value).toBeGreaterThan(first.elapsedMs.value as number);
  });

  it("keeps the wall-clock fallback when the kernel does not publish btime", () => {
    const root = fixtureRoot();
    const snapshot = readProcessSnapshot(41, { procRoot: root, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    expect(snapshot.startTime.value).toBe(new Date(1_000_000 - ((10 - 500 / 100) * 1000)).toISOString());
    expect(snapshot.startTime.provenance).toBe("DERIVED");
  });

  it("marks io counters UNAVAILABLE when procfs denies or omits the file", () => {
    const noIo = fixtureRoot(41, true, false);
    const snapshot = readProcessSnapshot(41, { procRoot: noIo, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    expect(snapshot.rcharBytes).toMatchObject({ value: null, provenance: "UNAVAILABLE" });
    expect(snapshot.rcharBytes.reason).toBeTruthy();
    // The rest of the snapshot is unaffected.
    expect(snapshot.rssBytes.value).toBe(300 * 1024);
  });

  it("leaves every rate UNAVAILABLE on a freshly collected sample", () => {
    const root = fixtureRoot();
    const snapshot = readProcessSnapshot(41, { procRoot: root, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    for (const key of ["cpuPercent", "minorFaultsPerSec", "majorFaultsPerSec", "rcharBytesPerSec", "wcharBytesPerSec", "readBytesPerSec", "writeBytesPerSec"] as const) {
      expect(snapshot[key], `${key} must not be invented on the first sample`).toMatchObject({ value: null, provenance: "UNAVAILABLE" });
      expect(snapshot[key].reason).toMatch(/two valid samples/i);
    }
  });

  it("keeps the metric key list, the snapshot, and the unavailable pass in agreement", () => {
    const root = fixtureRoot();
    const observed = readProcessSnapshot(41, { procRoot: root, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    const payloadKeys = Object.keys(observed).filter((key) => key !== "timestamp" && key !== "identityStartTicks").sort();
    expect(payloadKeys).toEqual([...SNAPSHOT_METRIC_KEYS].sort());

    const blank = readProcessSnapshot(99, { procRoot: root, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    expect(Object.keys(blank).filter((key) => key !== "timestamp" && key !== "identityStartTicks").sort()).toEqual([...SNAPSHOT_METRIC_KEYS].sort());

    // markUnavailable is driven by the same list, so a new metric can never
    // keep claiming to be observed after a rejected identity.
    const rejected = markUnavailable(observed, "identity rejected");
    for (const key of SNAPSHOT_METRIC_KEYS) {
      expect(rejected[key], `${key} survived the unavailable pass`).toMatchObject({ value: null, provenance: "UNAVAILABLE", reason: "identity rejected" });
    }
  });

  it("advertises exactly the metrics a snapshot carries", () => {
    const root = fixtureRoot();
    const snapshot = readProcessSnapshot(41, { procRoot: root, clockTicksPerSecond: 100, nowMs: 1_000_000 });
    for (const key of SNAPSHOT_METRIC_KEYS) {
      const metric = snapshot[key];
      expect(metric, `capabilities must not advertise missing metric ${key}`).toBeDefined();
      // The collector must really fill every advertised key, and an
      // unavailable value must always carry a reason. cpuPercent is the
      // canonical example: legitimately UNAVAILABLE on a first sample.
      expect(["OBSERVED", "DERIVED", "UNAVAILABLE"], `metric ${key} has no provenance`).toContain(metric.provenance);
      expect(typeof metric.source).toBe("string");
      if (metric.provenance === "UNAVAILABLE") {
        expect(metric.reason, `metric ${key} is unavailable without a reason`).toBeTruthy();
        expect(metric.value).toBeNull();
      }
    }
    // The internal identity token is never advertised.
    expect(SNAPSHOT_METRIC_KEYS as readonly string[]).not.toContain("identityStartTicks");
  });
});
