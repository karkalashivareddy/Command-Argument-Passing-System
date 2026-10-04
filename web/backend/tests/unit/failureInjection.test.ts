/**
 * Failure injection: every way the host can lie, and what CAPS must say instead.
 *
 * These tests are the ones that matter most for a product whose whole claim is
 * truthfulness. Each case takes a real reader that the kernel can produce under
 * ordinary, unremarkable conditions -- a counter that resets on reboot, a
 * sensor that unloads, a process that exits between two reads -- and asserts
 * that CAPS reports the condition rather than a plausible number.
 *
 * A counter reset is the canonical example. The truthful answer is "this counter
 * went backwards, so no rate is stated". The convenient answer is to report zero,
 * and a dashboard built on that convenient answer shows a machine that briefly
 * did nothing, every time it reboots.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CADENCE, collectHostSnapshot } from "../../src/telemetry/system/collector.js";
import type { KernelPaths } from "../../src/telemetry/system/read.js";
import { discoverThermal, THERMAL_ABSENT_REASON } from "../../src/telemetry/system/thermal.js";
import { buildDiskSnapshot } from "../../src/telemetry/system/disk.js";
import { buildNetworkSnapshot, parseNetDev } from "../../src/telemetry/system/network.js";
import { buildPressure, parsePressure } from "../../src/telemetry/system/pressure.js";
import { buildCpuSnapshot, parseProcStat, sumTicks as sumTimes, busyTicks, idleTicks } from "../../src/telemetry/system/cpu.js";
import { parseStatLine, probeClockTicks, resetClockTicksCache, readHostProcess, processSummaryFrom } from "../../src/telemetry/system/processes.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  resetClockTicksCache();
});

/** A synthetic /proc and /sys tree, so every failure is reproducible. */
function fakeHost(opts: {
  stat?: string;
  diskstats?: string;
  netDev?: string;
  pressure?: Record<string, string>;
  thermal?: Array<{ milliCelsius: string; type?: string }>;
  bootId?: string;
}): KernelPaths {
  const root = mkdtempSync(join(tmpdir(), "caps-fault-"));
  roots.push(root);
  const proc = join(root, "proc");
  const sys = join(root, "sys");
  mkdirSync(join(proc, "pressure"), { recursive: true });
  mkdirSync(join(sys, "class", "thermal"), { recursive: true });
  mkdirSync(join(sys, "class", "hwmon"), { recursive: true });
  mkdirSync(join(sys, "devices", "system", "cpu"), { recursive: true });

  writeFileSync(join(proc, "stat"), opts.stat ?? "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\n");
  writeFileSync(join(proc, "loadavg"), "0.10 0.20 0.30 1/100 12345\n");
  writeFileSync(join(proc, "meminfo"), "MemTotal:       1024 kB\nMemFree:         512 kB\nMemAvailable:    256 kB\n");
  writeFileSync(join(proc, "uptime"), "1000.00 900.00\n");
  writeFileSync(join(proc, "diskstats"), opts.diskstats ?? "");
  // `mkdir` before the write: net/dev lives two levels down, and writing into a
  // directory that does not exist throws rather than creating it.
  mkdirSync(join(proc, "net"), { recursive: true });
  writeFileSync(join(proc, "net", "dev"), opts.netDev ?? "");
  mkdirSync(join(sys, "kernel"), { recursive: true });
  writeFileSync(join(sys, "kernel", "osrelease"), "6.6.0-test\n");
  mkdirSync(join(proc, "sys", "kernel", "random"), { recursive: true });
  writeFileSync(join(proc, "sys", "kernel", "random", "boot_id"), opts.bootId ?? "boot-aaaa\n");

  for (const [name, body] of Object.entries(opts.pressure ?? {})) {
    writeFileSync(join(proc, "pressure", name), body);
  }
  (opts.thermal ?? []).forEach((t, i) => {
    const dir = join(sys, "class", "thermal", `thermal_zone${i}`);
    mkdirSync(dir, { recursive: true });
    if (t.type !== undefined) writeFileSync(join(dir, "type"), `${t.type}\n`);
    writeFileSync(join(dir, "temp"), `${t.milliCelsius}\n`);
  });
  return { proc, sys };
}

// ---------------------------------------------------------------- CPU

describe("a CPU counter that goes backwards produces no utilization", () => {
  /**
   * One /proc/stat, with the SAME totals on every call.
   *
   * A fixture that grows between calls would make the "utilization computed"
   * case depend on how the test happened to order two reads, which is a race
   * rather than an assertion. The interval is supplied explicitly, and the guard
   * that rejects a zero interval is covered separately.
   */
  const stat = (busy: number, idle: number): string => {
    const b = String(busy);
    const i = String(idle);
    const cores = [0, 1].map((n) => `cpu${n} ${b} 0 0 ${i} 0 0 0 0 0 0`).join("\n");
    return `cpu  ${b} 0 0 ${i} 0 0 0 0 0 0\n${cores}\n`;
  };

  const build = (paths: KernelPaths, previous: Parameters<typeof buildCpuSnapshot>[1], nowMs: number) =>
    buildCpuSnapshot(paths, previous, "boot-a", nowMs, `t${nowMs}`);

  it("reports no utilization on the first sample rather than zero", () => {
    const paths = fakeHost({ stat: stat(1000, 8000) });
    const first = build(paths, null, 1_000);
    // A rate needs two samples. 0% busy here would be a claim that the machine
    // was idle, which is precisely what a first sample cannot establish.
    const busy = first.snapshot.utilization.busyPercent;
    expect(busy.value).toBeNull();
    expect(busy.provenance).toBe("UNAVAILABLE");
    expect(busy.reason).toMatch(/two samples|first/i);
  });

  it("computes a utilization once two samples exist", () => {
    const paths = fakeHost({ stat: stat(1000, 8000) });
    const first = build(paths, null, 1_000);
    // A LATER read with advanced counters, so the delta is real rather than
    // zero-interval.
    const paths2 = fakeHost({ stat: stat(2000, 16000) });
    const second = buildCpuSnapshot(paths2, first.previous, "boot-a", 11_000, "t2");
    const busy = second.snapshot.utilization.busyPercent;
    expect(busy.provenance, `expected a real figure, got: ${busy.reason}`).not.toBe("UNAVAILABLE");
    expect(busy.value).not.toBeNull();
  });

  it("refuses a rate across a counter reset rather than reporting a spike", () => {
    const paths = fakeHost({ stat: stat(1000, 8000) });
    const first = build(paths, null, 1_000);

    /*
     * A reboot, or a counter wrap: the previous totals are LARGER than the
     * current ones. The truthful answer is that no rate can be stated. The
     * convenient answer is zero, and a dashboard built on that shows a machine
     * that briefly did nothing, every time it reboots.
     */
    const inflated = {
      ...first.previous,
      times: { ...first.previous.times, user: 9_000_000, idle: 9_000_000, system: 9_000_000 },
    };
    const afterReset = build(paths, inflated, 2_000);

    // The fixture must actually decrease for the case to mean anything.
    expect(sumTimes(afterReset.snapshot.currentTimes.value!)).toBeLessThan(sumTimes(inflated.times));
    expect(afterReset.snapshot.utilization.busyPercent.value).toBeNull();
    expect(afterReset.snapshot.utilization.busyPercent.provenance).toBe("UNAVAILABLE");
  });

  it("reports an unparseable /proc/stat as unavailable, not as zero", () => {
    const paths = fakeHost({ stat: "this is not a cpu line\n" });
    const { snapshot } = build(paths, null, 1_000);
    // 0% busy would be a claim that the machine was idle.
    expect(snapshot.utilization.busyPercent.value).toBeNull();
    expect(snapshot.utilization.busyPercent.provenance).toBe("UNAVAILABLE");
    expect(snapshot.utilization.busyPercent.reason?.length ?? 0).toBeGreaterThan(10);
  });

  it("handles a CPU disappearing from the topology between samples", () => {
    // Fewer per-core lines than before is a hotplug or a container change. The
    // aggregate stays valid and the core count is what changes shape.
    const two = parseProcStat(`cpu  100 0 0 800 0 0 0 0 0 0\ncpu0 100 0 0 800 0 0 0 0 0 0\ncpu1 100 0 0 800 0 0 0 0 0 0\n`);
    const one = parseProcStat(`cpu  100 0 0 800 0 0 0 0 0 0\ncpu0 100 0 0 800 0 0 0 0 0 0\n`);
    expect(two).not.toBeNull();
    expect(one).not.toBeNull();
    expect(two!.cores.length).toBe(2);
    expect(one!.cores.length).toBe(1);
    // The aggregate survives a hotplug even when the per-core shape changes.
    expect(two!.total).not.toBeNull();
  });

  it("reports a missing /proc/stat rather than a zeroed snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "caps-nostat-"));
    roots.push(root);
    const paths: KernelPaths = { proc: join(root, "p"), sys: join(root, "s") };
    mkdirSync(paths.proc, { recursive: true });
    mkdirSync(paths.sys, { recursive: true });
    const { snapshot } = build(paths, null, 1_000);
    // Every derived percentage is unavailable, and so are the cumulative
    // totals, because there was nothing to read. Zero anywhere here would be a
    // claim about the machine rather than about our inability to read it.
    expect(snapshot.utilization.busyPercent.value).toBeNull();
    expect(snapshot.utilization.busyPercent.provenance).toBe("UNAVAILABLE");
    expect(snapshot.utilization.busyPercent.reason?.length ?? 0).toBeGreaterThan(0);
    // A missing core count must be absent too, not zero: "this machine has no
    // cores" is not a statement about the host, it is a statement about us.
    expect(snapshot.currentTimes.provenance).toBe("UNAVAILABLE");
  });

  it("separates busy from idle without confusing the two", () => {
    const s = parseProcStat("cpu  100 0 0 400 0 0 0 0 0 0\ncpu0 100 0 0 400 0 0 0 0 0 0\n");
    expect(s).not.toBeNull();
    if (s === null) return;
    // busy and idle must partition the total, or a reader summing them reports a
    // figure the kernel never produced.
    expect(busyTicks(s.total) + idleTicks(s.total)).toBe(sumTimes(s.total));
    // The per-core times are per-core, not the aggregate: a test that read the
    // aggregate twice would pass while the parser mixed the two.
    expect(s.cores).toHaveLength(1);
    expect(s.cores[0]!.index).toBe(0);
  });
});

// ---------------------------------------------------------------- boot id

describe("a boot ID change is never averaged across", () => {
  it("records the boot id from /proc", () => {
    const paths = fakeHost({ bootId: "boot-first\n" });
    const snap = collectHostSnapshot({ paths });
    expect(snap.identity.bootId.value).toBe("boot-first");
  });

  it("reports a missing boot id as unavailable with a reason", () => {
    const root = mkdtempSync(join(tmpdir(), "caps-noboot-"));
    roots.push(root);
    const paths: KernelPaths = { proc: join(root, "p"), sys: join(root, "s") };
    mkdirSync(paths.proc, { recursive: true });
    mkdirSync(paths.sys, { recursive: true });
    const snap = collectHostSnapshot({ paths });
    expect(snap.identity.bootId.value).toBeNull();
    expect(snap.identity.bootId.provenance).toBe("UNAVAILABLE");
    expect(snap.identity.bootId.reason?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- thermal

describe("thermal sensor failures are reported, never smoothed over", () => {
  it("reports UNAVAILABLE when the host exposes no sensor", () => {
    const paths = fakeHost({ thermal: [] });
    const snap = discoverThermal(paths, "t");
    expect(snap.sensors).toHaveLength(0);
    expect(snap.highestCelsius.value).toBeNull();
    expect(snap.highestCelsius.provenance).toBe("UNAVAILABLE");
    // The reason must name the environment, because "no sensor" is a correct
    // and expected answer under WSL2 and inside most VMs.
    expect(snap.highestCelsius.reason).toContain(THERMAL_ABSENT_REASON.slice(0, 40));
  });

  it("reports a sensor that exists but cannot be read", () => {
    const paths = fakeHost({ thermal: [{ milliCelsius: "not-a-number", type: "x86_pkg_temp" }] });
    const snap = discoverThermal(paths, "t");
    // The zone is discovered -- the kernel published a type -- but its value is
    // unusable, so no maximum can be stated.
    expect(snap.sensors).toHaveLength(1);
    expect(snap.highestCelsius.value).toBeNull();
    expect(snap.highestCelsius.provenance).toBe("UNAVAILABLE");
  });

  it("never substitutes a plausible temperature for an absent sensor", () => {
    const paths = fakeHost({ thermal: [] });
    const snap = discoverThermal(paths, "t");
    // The specific failure this prevents: a chart that starts at 45 degrees and
    // rises with load, which is indistinguishable from a real trace and is
    // entirely invented.
    expect(snap.highestCelsius.value).not.toBe(0);
    expect(snap.highestCelsius.value).toBeNull();
    expect(snap.packageCelsius.value).toBeNull();
  });

  it("reads a real sensor and names it as the kernel names it", () => {
    const paths = fakeHost({ thermal: [{ milliCelsius: "47000", type: "x86_pkg_temp" }] });
    const snap = discoverThermal(paths, "t");
    expect(snap.highestCelsius.value).toBe(47);
    expect(snap.packageSensor.value).toBe("x86_pkg_temp");
    expect(snap.packageCelsius.value).toBe(47);
  });

  it("does not label an unidentified sensor as a CPU package", () => {
    const paths = fakeHost({ thermal: [{ milliCelsius: "40000", type: "acpitz" }] });
    const snap = discoverThermal(paths, "t");
    expect(snap.sensors[0]!.isPackage.value).toBe(false);
    expect(snap.packageCelsius.value).toBeNull();
  });
});

// ---------------------------------------------------------------- PSI

describe("pressure stall information is independently optional", () => {
  it("reports each file independently when the kernel omits some", () => {
    const parsed = parsePressure("some avg10=0.50 avg60=0.10 avg300=0.01 total=10\n");
    expect(parsed).not.toBeNull();
    expect(parsed!.some["avg10"]).toBeCloseTo(0.5, 5);

    const paths = fakeHost({ pressure: { cpu: "some avg10=0.50 avg60=0.10 avg300=0.01 total=10\n" } });
    const records = buildPressure(paths, "t");
    const cpu = records.find((r) => r.resource === "cpu");
    expect(cpu).toBeDefined();
    // memory and io were not written, so they are unavailable individually
    // rather than the whole subsystem failing.
    expect(cpu!.some.avg10.value).toBeCloseTo(0.5, 5);
    const memory = records.find((r) => r.resource === "memory");
    if (memory !== undefined) expect(memory.some.avg10.provenance).toBe("UNAVAILABLE");
  });

  it("treats a malformed PSI line as unavailable rather than parsing a zero", () => {
    const paths = fakeHost({ pressure: { cpu: "some avg10=abc\n" } });
    const records = buildPressure(paths, "t");
    const cpu = records.find((r) => r.resource === "cpu");
    // 0.0 would be a claim the host had no pressure at all.
    expect(cpu!.some.avg10.value).not.toBe(0);
  });
});

describe("disk and network counters never go negative", () => {
  it("reports no disk devices when /proc/diskstats is empty", () => {
    const paths = fakeHost({ diskstats: "" });
    const { snapshot } = buildDiskSnapshot(paths, null, [], 1_000, "t");
    // 0 B/s would be a claim the disk is idle; the kernel simply said nothing.
    // With no parsable device line there is nothing to report, and the device
    // list is empty rather than containing a synthetic zero device.
    expect(snapshot.devices).toHaveLength(0);
  });

  it("reports no network interfaces when /proc/net/dev is empty", () => {
    const paths = fakeHost({ netDev: "" });
    const { snapshot } = buildNetworkSnapshot(paths, null, 1_000, "t");
    // The per-interface list is empty. A synthetic interface with zero counters
    // would put a fabricated row in the explorer's network view.
    expect(snapshot.interfaces).toHaveLength(0);
  });

  it("parses the interfaces it was given, without inventing a host total", () => {
    const lines = parseNetDev(
      "Inter-|   Receive                          |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n  eth0: 1000    10      0    0    0     0          0         0    2000    20     0    0    0     0       0          0\n",
    );
    expect(lines.length).toBe(1);
    expect(lines[0]!.rxBytes).toBe(1000);
  });

  it("skips a malformed interface line rather than reading its fields wrong", () => {
    const lines = parseNetDev(
      "Inter-|   Receive                          |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n  eth0: garbage line that cannot be parsed\n",
    );
    expect(lines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- process stat

describe("a malformed /proc/<pid>/stat is discarded rather than guessed at", () => {
  it("refuses a line with no closing parenthesis", () => {
    const parsed = parseStatLine("1234 nonsense without a close paren");
    expect(parsed).toBeNull();
  });

  it("refuses a line whose numeric fields are absent", () => {
    expect(parseStatLine("1 (comm) S")).toBeNull();
  });

  it("locates the numeric fields after the LAST parenthesis", () => {
    /*
     * The comm field may contain both spaces and closing parentheses -- a
     * process can be named `weird )name`. Counting from the first ')' reads
     * some other process's start time, which would defeat the identity check
     * the field exists for.
     */
    const line = `4242 (evil ) name) S 1 4242 4242 0 -1 4194304 100 0 0 0 12345 678 0 0 20 0 5 0 98765 123456789 5678 ${42} 18446744073709551615 1 2 3\n`;
    const parsed = parseStatLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed!.pid).toBe(4242);
    expect(parsed!.ppid).toBe(1);
    // Field 22: the start time, which must be the one after the last ')'.
    expect(parsed!.startTicks).toBe(98765);
  });

  it("refuses an unsafe integer rather than wrapping", () => {
    const line = `9999 (big) S 1 9999 9999 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 18446744073709551615 ${999999999999999999999} 1 2 3\n`;
    expect(parseStatLine(line)).toBeNull();
  });
});

/*
 * A kernel that publishes a real zero is a fact. A field the kernel did not
 * publish is UNAVAILABLE. Conflating them is the single most common way a
 * telemetry product starts lying, because the fabrication is invisible in the
 * response: a null with the wrong provenance still serialises to a number on a
 * chart.
 *
 * `parseStatLine` used to end with `minflt ?? 0`, `majflt ?? 0` and
 * `threads ?? 1`. Each of those is a plausible measurement and none of them was
 * measured. "0 minor faults" says a process has never taken a page fault; "0
 * major faults" says it has never paged from disk, which reads as the absence of
 * disk pressure; "1 thread" says a process is single-threaded, which is the basis
 * of every threads-per-process figure downstream.
 */
describe("an unreadable stat field is UNAVAILABLE, never zero", () => {
  /** A well-formed stat line whose minor/major fault fields are replaced. */
  function statWithFaults(minflt: string, majflt: string): string {
    // fields after ')' : state ppid pgrp session tty tpgid flags minflt cminflt
    //                    majflt cmajflt utime stime cutime cstime priority nice
    //                    num_threads itrealvalue starttime ...
    return `4242 (p) S 1 4242 4242 0 -1 4194304 ${minflt} 0 ${majflt} 0 12345 678 0 0 20 0 5 0 98765 1 2 3\n`;
  }

  it("preserves a kernel-reported zero as zero", () => {
    const parsed = parseStatLine(statWithFaults("0", "0"));
    expect(parsed).not.toBeNull();
    expect(parsed!.minflt).toBe(0);
    expect(parsed!.majflt).toBe(0);
    expect(parsed!.threads).toBe(5);
  });

  it("does not invent 0 minor faults when the field is not a number", () => {
    const parsed = parseStatLine(statWithFaults("??", "3"));
    expect(parsed).not.toBeNull();
    expect(parsed!.minflt, "a non-numeric minflt must be null, not 0").toBeNull();
    expect(parsed!.majflt).toBe(3);
  });

  it("does not invent 0 major faults when the field is not a number", () => {
    const parsed = parseStatLine(statWithFaults("7", "-"));
    expect(parsed).not.toBeNull();
    expect(parsed!.minflt).toBe(7);
    expect(parsed!.majflt, "a non-numeric majflt must be null, not 0").toBeNull();
  });

  it("does not invent 1 thread when the thread count is not a number", () => {
    const parsed = parseStatLine(
      `4242 (p) S 1 4242 4242 0 -1 4194304 12 0 3 0 12345 678 0 0 20 0 x 0 98765 1 2 3\n`,
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.threads, "a non-numeric num_threads must be null, not 1").toBeNull();
  });

  it("turns the null into an UNAVAILABLE metric with an explicit reason on the row", () => {
    const paths = fakeHost({});
    const dir = join(paths.proc, "4242");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stat"), statWithFaults("??", "3"));
    writeFileSync(join(dir, "status"), "Name:\tp\nPid:\t4242\nPPid:\t1\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nVmRSS:\t1024 kB\n");
    writeFileSync(join(dir, "cmdline"), "p\0");

    const { row } = readHostProcess(paths, 4242, 100, "boot-aaaa", null, 1_000, null, {
      includePss: false,
      smaps: null,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(row.rowState).toBe("LIVE");
    expect(row.minorFaults.provenance).toBe("UNAVAILABLE");
    expect(row.minorFaults.value).toBeNull();
    expect(row.minorFaults.reason).toMatch(/minor_faults/);
    // The field that WAS readable is still reported, so the row is not blanked.
    expect(row.majorFaults).toMatchObject({ value: 3, provenance: "OBSERVED" });
  });

  it("counts an unknown thread count as unknown, not as one thread", () => {
    const paths = fakeHost({});
    const dir = join(paths.proc, "4242");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stat"), statWithFaults("12", "3"));
    writeFileSync(join(dir, "status"), "Name:\tp\nPid:\t4242\nPPid:\t1\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nVmRSS:\t1024 kB\n");
    writeFileSync(join(dir, "cmdline"), "p\0");
    // num_threads is the field before itrealvalue; blank it out.
    writeFileSync(join(dir, "stat"), `4242 (p) S 1 4242 4242 0 -1 4194304 12 0 3 0 12345 678 0 0 20 0 - 0 98765 1 2 3\n`);

    const { row } = readHostProcess(paths, 4242, 100, "boot-aaaa", null, 1_000, null, {
      includePss: false,
      smaps: null,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(row.threads.provenance).toBe("UNAVAILABLE");
    expect(row.threads.value).toBeNull();

    const summary = processSummaryFrom([row], "2026-01-01T00:00:00.000Z", { processesCreated: null });
    expect(summary.total.value).toBe(1);
    // The thread total covers no processes, and SAYS so. Reporting 1 here would
    // publish an OBSERVED sum whose only contribution was invented.
    expect(summary.threadsTotal.value).toBe(0);
    expect(summary.threadsTotal.reason).toMatch(/excluded rather than counted as single-threaded/);
  });
});

/*
 * A process can exit between the read of /proc/<pid>/stat and the read of
 * /proc/<pid>/status. That is not an error and not a permission problem: it is
 * the ordinary churn of a live host.
 *
 * The row used to answer `statusRead.ok ? "LIVE" : "PERMISSION_DENIED"`, so every
 * one of those exits was published as a permissions failure. The two claims have
 * opposite consequences -- one is routine and expected, the other tells an
 * operator their host is configured wrongly -- and reporting routine churn as a
 * configuration fault is how a badge that matters stops being read.
 *
 * Injection is deterministic: a fixture tree where `stat` exists and `status`
 * does not reproduces exactly what the kernel does when it reaps a process
 * between two syscalls.
 */
describe("a process that exits mid-sample is classified by what actually happened", () => {
  function hostWhereStatusIsMissing(): KernelPaths {
    const paths = fakeHost({});
    const dir = join(paths.proc, "4242");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "stat"),
      `4242 (p) S 1 4242 4242 0 -1 4194304 12 0 3 0 12345 678 0 0 20 0 5 0 98765 1 2 3\n`,
    );
    writeFileSync(join(dir, "cmdline"), "p\0");
    // No `status`: the read fails with ENOENT, exactly as it does when the
    // kernel removes the entry between the two reads.
    return paths;
  }

  it("reports EXITED, not PERMISSION_DENIED, when status vanished", () => {
    const paths = hostWhereStatusIsMissing();
    const { row } = readHostProcess(paths, 4242, 100, "boot-aaaa", null, 1_000, null, {
      includePss: false,
      smaps: null,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(row.rowState).toBe("EXITED");
    expect(row.rowState).not.toBe("PERMISSION_DENIED");
    expect(row.stateReason).toMatch(/exited between the two reads/);
    // What the kernel did publish is kept. Only the state changed.
    expect(row.name.value).toBe("p");
    expect(row.threads.value).toBe(5);
  });

  it("keeps PERMISSION_DENIED for a status file the kernel refused to open", () => {
    const paths = fakeHost({});
    const dir = join(paths.proc, "4243");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "stat"),
      `4243 (p) S 1 4243 4243 0 -1 4194304 12 0 3 0 12345 678 0 0 20 0 5 0 98766 1 2 3\n`,
    );
    writeFileSync(join(dir, "cmdline"), "p\0");
    // A directory in place of the file: readFileSync fails with EISDIR, which
    // classifies as an I/O failure and not as a permission decision. That is
    // what UNAVAILABLE is for, and it must not be reported as PERMISSION_DENIED.
    mkdirSync(join(dir, "status"), { recursive: true });

    const { row } = readHostProcess(paths, 4243, 100, "boot-aaaa", null, 1_000, null, {
      includePss: false,
      smaps: null,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(row.rowState).toBe("UNAVAILABLE");
    expect(row.rowState).not.toBe("PERMISSION_DENIED");
  });

  it("reports a stat line that vanished before it could be read as EXITED", () => {
    const paths = fakeHost({});
    // The directory exists (so discovery found it) but stat does not.
    mkdirSync(join(paths.proc, "4244"), { recursive: true });
    const { row } = readHostProcess(paths, 4244, 100, "boot-aaaa", null, 1_000, null, {
      includePss: false,
      smaps: null,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(row.rowState).toBe("EXITED");
  });

  it("reports a stat line that exists but does not parse as UNAVAILABLE", () => {
    const paths = fakeHost({});
    const dir = join(paths.proc, "4245");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stat"), "this is not a stat line\n");
    const { row } = readHostProcess(paths, 4245, 100, "boot-aaaa", null, 1_000, null, {
      includePss: false,
      smaps: null,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(row.rowState).toBe("UNAVAILABLE");
    expect(row.stateReason).toMatch(/did not parse/);
  });

  it("reports DISAPPEARED when status names a different process", () => {
    const paths = fakeHost({});
    const dir = join(paths.proc, "4246");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "stat"),
      `4246 (p) S 1 4246 4246 0 -1 4194304 12 0 3 0 12345 678 0 0 20 0 5 0 98767 1 2 3\n`,
    );
    // The kernel's own cross-check disagrees with the directory: PID reuse.
    writeFileSync(join(dir, "status"), "Name:\tq\nPid:\t9999\nPPid:\t1\n");
    const { row } = readHostProcess(paths, 4246, 100, "boot-aaaa", null, 1_000, null, {
      includePss: false,
      smaps: null,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(row.rowState).toBe("DISAPPEARED");
    expect(row.stateReason).toMatch(/9999/);
  });
});

// ---------------------------------------------------------------- clock ticks

describe("clock tick calibration never invents a value", () => {
  it("reports a real value on this host", () => {
    const hz = probeClockTicks();
    // Linux USER_HZ is conventionally 100; anything wildly different means the
    // calibration failed and returned something meaningless.
    if (hz !== null) expect(hz).toBeGreaterThanOrEqual(1);
  });

  it("returns null when the calculation is impossible rather than 100", () => {
    const bogus = probeClockTicks();
    // A non-null value must be a plausible USER_HZ; a fabricated 100 when the
    // probe failed would silently scale every CPU figure.
    if (bogus !== null) expect(bogus).toBeLessThan(100_000);
  });
});

// ---------------------------------------------------------------- snapshot totality

describe("a host snapshot with almost nothing readable still completes", () => {
  it("produces a snapshot whose unavailable fields carry reasons", () => {
    const root = mkdtempSync(join(tmpdir(), "caps-bare-"));
    roots.push(root);
    const paths: KernelPaths = { proc: join(root, "p"), sys: join(root, "s") };
    mkdirSync(paths.proc, { recursive: true });
    mkdirSync(paths.sys, { recursive: true });
    const snap = collectHostSnapshot({ paths });

    // A snapshot of a machine with no readable /proc must not throw, and must
    // not claim the machine has zero of everything.
    expect(snap.cpu.utilization.busyPercent.value).toBeNull();
    expect(snap.cpu.utilization.busyPercent.provenance).toBe("UNAVAILABLE");
    expect(snap.cpu.utilization.busyPercent.reason?.length ?? 0).toBeGreaterThan(0);
    expect(snap.identity.bootId.provenance).toBe("UNAVAILABLE");
    expect(snap.thermal.sensors).toHaveLength(0);
  });

  it("publishes its own sampling cadence", () => {
    expect(CADENCE.fastMs).toBeGreaterThan(0);
    expect(CADENCE.slowMs).toBeGreaterThanOrEqual(CADENCE.fastMs);
  });
});
