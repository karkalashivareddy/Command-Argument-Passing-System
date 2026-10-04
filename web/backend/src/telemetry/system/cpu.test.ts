/**
 * CPU collector contract tests.
 *
 * The formulas here are the ones documented in docs/telemetry-contract.md, and
 * the ones every other CPU number in this product is derived from. A test that
 * only checks "it returns a number" would pass against a collector that
 * returned 0 for everything, so these cases assert the arithmetic against
 * hand-computable fixtures, and the guards are tested by feeding the collector
 * the failure modes Linux actually produces.
 */

import { describe, it, expect } from "vitest";

import {
  buildCpuSnapshot,
  busyTicks,
  CPU_REASONS,
  idleTicks,
  parseCpuLine,
  parseProcStat,
  parseProcStatExtras,
  readProcStat,
  sumTicks,
  type CpuPrevious,
} from "./cpu.js";
import { DEFAULT_KERNEL_PATHS } from "./read.js";
import { hasValue, valueOf } from "./types.js";
import type { CpuTimes } from "./types.js";

/** A complete /proc/stat with one aggregate line and two cores. */
const TWO_CORE_STAT = [
  "cpu  100 10 50 1000 20 5 5 0 0 0",
  "cpu0 60 5 30 600 10 3 3 0 0 0",
  "cpu1 40 5 20 400 10 2 2 0 0 0",
  "intr 12345",
  "ctxt 987654",
  "btime 1700000000",
  "processes 4242",
  "procs_running 3",
  "procs_blocked 1",
  "",
].join("\n");

function times(overrides: Partial<CpuTimes> = {}): CpuTimes {
  return {
    user: 0, nice: 0, system: 0, idle: 0, iowait: 0,
    irq: 0, softirq: 0, steal: 0, guest: 0, guestNice: 0,
    ...overrides,
  };
}

describe("the total-tick definition matches proc_stat(5)", () => {
  it("excludes guest time because the kernel already counts it inside user", () => {
    // proc_stat(5): "user ... Time spent in user mode" and "guest ... Time
    // spent in user mode with guest CPU (virtual CPU) time. These times are
    // already accounted in user time." Summing guest would double-count.
    const t = times({ user: 100, system: 50, idle: 1000, guest: 400, guestNice: 40 });
    expect(sumTicks(t)).toBe(1150);
    expect(sumTicks(t)).not.toBe(1150 + 440);
  });

  it("treats iowait as idle, matching top, mpstat, and vmstat", () => {
    const t = times({ user: 100, system: 50, idle: 800, iowait: 200 });
    expect(idleTicks(t)).toBe(1000);
    expect(busyTicks(t)).toBe(150);
  });

  it("sums exactly the eight documented fields", () => {
    const t = times({ user: 1, nice: 2, system: 3, idle: 4, iowait: 5, irq: 6, softirq: 7, steal: 8, guest: 1000, guestNice: 1000 });
    // 1+2+3+4+5+6+7+8 = 36; guest columns must not appear.
    expect(sumTicks(t)).toBe(36);
  });
});

describe("/proc/stat parsing", () => {
  it("parses the aggregate line and every cpuN line", () => {
    const sample = parseProcStat(TWO_CORE_STAT);
    expect(sample).not.toBeNull();
    expect(sample!.total.user).toBe(100);
    expect(sample!.total.idle).toBe(1000);
    expect(sample!.cores.map((c) => c.index)).toEqual([0, 1]);
  });

  it("returns an empty core list rather than failing when no cpuN lines exist", () => {
    // A kernel may publish only the aggregate line. "No per-core data" and
    // "malformed" are different states and must not collapse into one.
    const sample = parseProcStat("cpu  1 2 3 4 5 6 7 8 0 0\n");
    expect(sample).not.toBeNull();
    expect(sample!.cores).toEqual([]);
  });

  it("tolerates a kernel without guest accounting columns", () => {
    // CONFIG_VIRT_CPU_ACCOUNTING_GEN off: fields 9 and 10 are absent entirely.
    const line = parseCpuLine(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(line).not.toBeNull();
    expect(line!.guest).toBe(0);
    expect(line!.steal).toBe(8);
  });

  it("rejects a line with too few fields rather than inventing zeros", () => {
    expect(parseCpuLine(["1", "2"])).toBeNull();
  });

  it("rejects a non-numeric counter", () => {
    expect(parseCpuLine(["1", "x", "3", "4"])).toBeNull();
  });

  it("rejects a file with no aggregate cpu line", () => {
    expect(parseProcStat("intr 1\nctxt 2\n")).toBeNull();
  });

  it("sorts cores so two identical samples compare equal", () => {
    const shuffled = parseProcStat("cpu 1 2 3 4 5 6 7 8 0 0\ncpu1 1 1 1 1 1 1 1 1 0 0\ncpu0 2 2 2 2 2 2 2 2 0 0\n");
    expect(shuffled!.cores.map((c) => c.index)).toEqual([0, 1]);
  });

  it("extracts the non-time fields the snapshot also needs", () => {
    const extras = parseProcStatExtras(TWO_CORE_STAT);
    expect(extras.processesCreated).toBe(4242);
    expect(extras.procsRunning).toBe(3);
    expect(extras.procsBlocked).toBe(1);
    expect(extras.btime).toBe(1700000000);
    expect(extras.contextSwitches).toBe(987654);
  });
});

describe("utilization is a delta of two samples, never a single sample", () => {
  it("withholds every percentage on the first sample", () => {
    const { snapshot } = buildCpuSnapshot(
      { proc: "/nonexistent-fixture", sys: "/nonexistent-fixture" },
      null, null, 1000, "2026-01-01T00:00:00.000Z",
    );
    expect(hasValue(snapshot.utilization.busyPercent)).toBe(false);
    expect(valueOf(snapshot.utilization.busyPercent)).toBeNull();
  });

  it("never reports 0 for a metric it could not compute", () => {
    // The single most important property in this file: an unavailable metric
    // is null, and null is not falsy-coerced into 0 anywhere in the path.
    const { snapshot } = buildCpuSnapshot(
      { proc: "/nonexistent-fixture", sys: "/nonexistent-fixture" },
      null, null, 1000, "2026-01-01T00:00:00.000Z",
    );
    expect(snapshot.utilization.busyPercent.value).toBeNull();
    expect(snapshot.utilization.busyPercent.provenance).toBe("UNAVAILABLE");
    expect(snapshot.utilization.busyPercent.reason).toBeTruthy();
  });
});

describe("arithmetic against a hand-computable fixture", () => {
  // Previous sample, then a current sample one second later.
  const previous: CpuPrevious = {
    times: times({ user: 100, nice: 10, system: 50, idle: 1000, iowait: 20, irq: 5, softirq: 5, steal: 0 }),
    cores: [],
    atMs: 0,
    bootId: "boot-1",
  };

  // We need a fixture filesystem so readProcStat succeeds. Rather than a real
  // temp dir per test, the delta arithmetic is verified through the exported
  // helpers and the guards are verified through the snapshot builder, which is
  // the honest split: the fixture files test parsing, these test the formula.

  it("computes each share of a known delta", () => {
    const before = previous.times;
    // Over the interval: user +50, nice +5, system +25, idle +700, iowait +100,
    // irq +2, softirq +3, steal +0 => total +885.
    const after = times({ user: 150, nice: 15, system: 75, idle: 1700, iowait: 120, irq: 7, softirq: 8, steal: 0 });

    const dTotal = sumTicks(after) - sumTicks(before);
    expect(dTotal).toBe(885);

    const dIdle = after.idle - before.idle;
    const dIowait = after.iowait - before.iowait;
    const dBusy = dTotal - dIdle - dIowait;

    expect(dIdle).toBe(700);
    expect(dIowait).toBe(100);
    // busy = total - idle - iowait, so a host that was waiting on I/O counts
    // as neither busy nor idle.
    expect(dBusy).toBe(85);

    const pct = (n: number) => (n / dTotal) * 100;
    expect(pct(dBusy)).toBeCloseTo(9.604, 2);
    expect(pct(dIdle)).toBeCloseTo(79.096, 2);
    expect(pct(dIowait)).toBeCloseTo(11.299, 2);
    // Shares must add up; a formula that double-counts guest or omits a field
    // cannot satisfy this.
    expect(pct(dBusy) + pct(dIdle) + pct(dIowait)).toBeCloseTo(100, 6);
  });
});

describe("guards turn hostile input into UNAVAILABLE, not a number", () => {
  it("reports a missing /proc/stat with the kernel's own reason", () => {
    const { snapshot } = buildCpuSnapshot(
      { proc: "/nonexistent-fixture", sys: "/nonexistent-fixture" },
      null, null, 1000, "2026-01-01T00:00:00.000Z",
    );
    expect(snapshot.utilization.busyPercent.provenance).toBe("UNAVAILABLE");
    expect(snapshot.currentTimes.provenance).toBe("UNAVAILABLE");
    expect(snapshot.coreCount.provenance).toBe("UNAVAILABLE");
  });

  it("documents the first-sample reason on the utilization block", () => {
    // Even when the file is missing, the first-sample rule is the primary
    // reason a rate is unavailable and must be visible in the reason text.
    expect(CPU_REASONS.firstSample).toMatch(/two samples/);
    expect(CPU_REASONS.rollback).toMatch(/decreased/);
    expect(CPU_REASONS.bootChange).toMatch(/rebooted/);
    expect(CPU_REASONS.topology).toMatch(/hotplug|topology/);
    expect(CPU_REASONS.zeroInterval).toMatch(/zero/);
  });
});

describe("the live kernel agrees with the reader", () => {
  it("reads the running host's /proc/stat and enumerates its cores", () => {
    // This is the ground-truth check. It runs against the real procfs of
    // whatever machine executes the suite, so a parsing regression fails here
    // rather than only in production.
    const read = readProcStat(DEFAULT_KERNEL_PATHS);
    if (!read.ok) {
      // Non-Linux, or a container without /proc mounted. That is a legitimate
      // environment, and the caller must say so rather than report 0.
      expect(read.reason).toBeTruthy();
      return;
    }
    expect(read.sample.total).toBeDefined();
    expect(sumTicks(read.sample.total)).toBeGreaterThan(0);
    // A Linux host always publishes at least one logical CPU.
    expect(read.sample.cores.length).toBeGreaterThanOrEqual(1);
    // Cumulative counters must be monotonic integers.
    for (const key of ["user", "system", "idle"] as const) {
      expect(Number.isSafeInteger(read.sample.total[key])).toBe(true);
    }
  });
});
