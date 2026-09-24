import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseKilobytes, parseProcStat, parseProcStatus, ProcParseError, readProcessSnapshot } from "./procfs.js";

const roots: string[] = [];

function statLine(pid = 41, comm = "weird ) process name"): string {
  const fields = Array(22).fill("0") as string[];
  fields[0] = "S"; // field 3, state
  fields[1] = "7"; // ppid
  fields[2] = "8"; // pgrp
  fields[3] = "9"; // session
  fields[11] = "10"; // utime
  fields[12] = "5"; // stime
  fields[17] = "2"; // num_threads
  fields[19] = "500"; // starttime
  return `${pid} (${comm}) ${fields.join(" ")}`;
}

function fixtureRoot(pid = 41, status = true): string {
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
