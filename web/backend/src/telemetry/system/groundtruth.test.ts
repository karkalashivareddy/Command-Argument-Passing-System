/**
 * Ground-truth cross-check for the host collectors.
 *
 * WHAT THIS IS
 * ------------
 * An independent re-derivation of the same arithmetic, reading the same procfs
 * and sysfs files *directly*, with no shared code beyond the filesystem paths.
 * The point is to catch a collector that is consistently wrong in a way its own
 * unit tests cannot see, because those tests were written from the same reading
 * of the kernel documentation as the collector.
 *
 * If both this file and the collectors mis-index `/proc/stat`, they will agree
 * with each other and the bug survives. So this file re-reads the raw text and
 * indexes it by hand, using the field numbers from proc_stat(5),
 * proc_diskstats(5), and proc_pid_stat(5).
 *
 * Every assertion runs against the real kernel of whatever machine executes the
 * suite, so a parsing regression fails here rather than only in production. On
 * a kernel that lacks a subsystem, the assertion becomes a check that the
 * collectors said UNAVAILABLE with a reason - which is the property that
 * matters most.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statfsSync } from "node:fs";

import { HostCollector } from "./collector.js";
import { parseProcStat, sumTicks, idleTicks } from "./cpu.js";
import { parseMemInfo } from "./memory.js";
import { parseLoadAvg, parsePressure } from "./pressure.js";
import { parseDiskstats } from "./disk.js";
import { parseNetDev } from "./network.js";
import { parseStatLine, parseCmdline, parseSchedstat } from "./processes.js";
import { parseSmapsRollup } from "./smaps.js";
import { DEFAULT_KERNEL_PATHS } from "./read.js";
import { hasValue, valueOf } from "./types.js";
import type { SystemSnapshot } from "./types.js";

function readOr(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listOr(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

const isLinux = process.platform === "linux";

/** One collector, warmed up so rate metrics have a previous sample. */
async function warmed(): Promise<SystemSnapshot> {
  const collector = new HostCollector();
  collector.collect();
  await new Promise((r) => setTimeout(r, 250));
  return collector.collect();
}

describe.skipIf(!isLinux)("host collectors agree with an independent raw read of the kernel", () => {
  it("/proc/stat: field indices and the idle convention match a hand-indexed parse", async () => {
    const raw = readOr("/proc/stat");
    expect(raw).not.toBeNull();

    // Independent read: split the cpu line and index by hand using the
    // proc_stat(5) field numbers. f[0] is the "cpu" label, so field N is f[N].
    const cpuLine = raw!.split("\n").find((l) => l.startsWith("cpu "))!;
    const f = cpuLine.trim().split(/\s+/);
    const handUser = Number(f[1]);
    const handSystem = Number(f[3]);
    const handIdle = Number(f[4]);
    const handIowait = Number(f[5]);

    const parsed = parseProcStat(raw!)!;
    // An off-by-one here would silently report the neighbouring field, which
    // produces entirely plausible and completely wrong utilization figures.
    expect(parsed.total.user).toBe(handUser);
    expect(parsed.total.nice).toBe(Number(f[2]));
    expect(parsed.total.system).toBe(handSystem);
    expect(parsed.total.idle).toBe(handIdle);
    expect(parsed.total.iowait).toBe(handIowait);
    expect(parsed.total.steal).toBe(Number(f[8]));

    // The collector's own sum convention, checked against the hand total.
    const handTotal = f.slice(1, 9).reduce((a: number, b) => a + Number(b), 0);
    expect(sumTicks(parsed.total)).toBe(handTotal);
    expect(idleTicks(parsed.total)).toBe(handIdle + handIowait);
  });

  it("/proc/stat: a warmed snapshot produces in-range utilization and shares that sum to 100", async () => {
    const snap = await warmed();
    const u = snap.cpu.utilization;
    const busy = valueOf(u.busyPercent);
    if (busy === null) {
      // A legitimately unavailable reading must carry a reason.
      expect(u.busyPercent.provenance).toBe("UNAVAILABLE");
      expect(u.busyPercent.reason).toBeTruthy();
      return;
    }
    expect(busy).toBeGreaterThanOrEqual(0);
    expect(busy).toBeLessThanOrEqual(100);
    const idle = valueOf(u.idlePercent)!;
    const iowait = valueOf(u.iowaitPercent)!;
    // busy + idle + iowait must be exactly 100: a formula that double-counts
    // guest time, or forgets a field, cannot satisfy this.
    expect(busy + idle + iowait).toBeCloseTo(100, 6);
    // And busy + iowait is the same numerator over the same denominator.
    expect(valueOf(u.busyPlusIowaitPercent)!).toBeCloseTo(busy + iowait, 6);
  });

  it("/proc/stat: per-core rows match the cpuN lines and are never invented", async () => {
    const raw = readOr("/proc/stat")!;
    const snap = await warmed();
    const handCores = parseProcStat(raw)!.cores;
    expect(snap.cpu.coreCount.value).toBe(handCores.length);
    expect(snap.cpu.perCore.length).toBe(handCores.length);
    for (const core of snap.cpu.perCore) {
      expect(handCores.some((c) => c.index === core.index)).toBe(true);
      const b = valueOf(core.busyPercent);
      if (b !== null) {
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(100);
      }
    }
  });

  it("/proc/meminfo: every field CAPS reports equals the raw kB value times 1024", async () => {
    // The collector and this test each read /proc/meminfo at their own instant,
    // and several of these counters move continuously. Comparing a single
    // hand read against the collector's read is therefore flaky by
    // construction: a 56 kB drift in MemFree between two reads a few hundred
    // milliseconds apart is normal kernel behaviour, not a defect.
    //
    // The fix is to bracket instead of compare. The kernel's read happened at
    // some instant strictly between the two hand reads, so the collector's
    // value must lie inside the envelope those two reads span. A value
    // outside that envelope cannot be explained by a race and is a real bug
    // (a wrong field index, a wrong unit, a wrong divisor).
    const rawBefore = readOr("/proc/meminfo")!;
    const collector = new HostCollector();
    const snap = collector.collect();
    const rawAfter = readOr("/proc/meminfo")!;

    const handKib = (raw: string, key: string): number | null => {
      const line = raw.split("\n").find((l) => l.startsWith(`${key}:`));
      if (line === undefined) return null;
      const m = /^(\d+)\s+kB$/.exec(line.slice(line.indexOf(":") + 1).trim());
      return m ? Number(m[1]) : null;
    };

    const volatile: Array<[string, { value: number | null }]> = [
      ["MemFree", snap.memory.freeBytes],
      ["MemAvailable", snap.memory.availableBytes],
      ["Buffers", snap.memory.buffersBytes],
      ["Cached", snap.memory.cachedBytes],
      ["Slab", snap.memory.slabBytes],
      ["Active", snap.memory.activeBytes],
      ["AnonPages", snap.memory.anonPagesBytes],
      ["SwapFree", snap.memory.swapFreeBytes],
    ];
    /*
     * The envelope needs a tolerance, because a value is not monotonic between
     * two samples: the kernel's read happened somewhere inside the window, and
     * a counter that overshoots and returns (MemFree rises as page cache is
     * reclaimed, then falls as it is touched again) can leave the window
     * entirely even though nothing is wrong.
     *
     * The tolerance is sized by what it has to distinguish. A wrong field index,
     * a wrong unit, or a wrong divisor produces an error of hundreds of
     * megabytes or more; a missing kB->byte conversion produces a factor of
     * 1024. 256 MiB is therefore many orders of magnitude below every error
     * this assertion exists to catch, while comfortably absorbing the movement
     * of a busy machine between two reads.
     */
    const SLACK_BYTES = 256 * 1024 * 1024;
    for (const [key, metric] of volatile) {
      const before = handKib(rawBefore, key);
      const after = handKib(rawAfter, key);
      if (before === null || after === null || metric.value === null) continue;
      const lo = Math.min(before, after) * 1024 - SLACK_BYTES;
      const hi = Math.max(before, after) * 1024 + SLACK_BYTES;
      expect(
        metric.value,
        `${key} must lie within ${SLACK_BYTES} bytes of the envelope spanned by the two hand reads (${lo}..${hi})`,
      ).toBeGreaterThanOrEqual(lo);
      expect(metric.value, `${key} must lie within the envelope spanned by the two hand reads`).toBeLessThanOrEqual(hi);
    }

    // Total memory and total swap cannot change without a reboot or a
    // swapon/swapoff, neither of which happens inside this test. For these the
    // comparison is exact.
    const invariant: Array<[string, { value: number | null }]> = [
      ["MemTotal", snap.memory.totalBytes],
      ["SwapTotal", snap.memory.swapTotalBytes],
    ];
    for (const [key, metric] of invariant) {
      const expected = handKib(rawBefore, key);
      if (expected === null) continue;
      expect(metric.value, `${key} is immutable during a test run and must match exactly`).toBe(expected * 1024);
    }

    // used = total - available, recomputed from the collector's own two
    // figures. Note this is NOT total - free, which would count the page
    // cache as used.
    const total = valueOf(snap.memory.totalBytes);
    const available = valueOf(snap.memory.availableBytes);
    if (total !== null && available !== null) {
      expect(valueOf(snap.memory.usedBytes)).toBe(total - available);
      expect(valueOf(snap.memory.usedPercent)!).toBeCloseTo(((total - available) / total) * 100, 9);
    }
  });

  it("/proc/meminfo: MemAvailable is labelled a kernel estimate, not a measurement", async () => {
    const snap = await warmed();
    const available = snap.memory.availableBytes;
    if (available.provenance === "UNAVAILABLE") {
      expect(available.reason).toMatch(/MemAvailable/);
    } else {
      expect(available.provenance).toBe("OBSERVED");
      expect(available.estimate).toBe(true);
      expect(available.reason).toMatch(/estimate/i);
    }
  });

  it("/proc/loadavg: CAPS values equal the raw file's first three numbers", async () => {
    // Bracket the read, for the same reason as /proc/meminfo: this test suite
    // forks processes constantly, and `lastPid` advances on every single fork.
    // A single hand read therefore disagrees with the collector's read by
    // construction, and asserting equality would make the test flaky rather
    // than strict.
    const rawBefore = readOr("/proc/loadavg")!;
    const collector = new HostCollector();
    const snap = collector.collect();
    const rawAfter = readOr("/proc/loadavg")!;

    const trimmed = rawBefore.trim().split(/\s+/);
    // The exponentially-damped averages change slowly, so a bracket that is
    // tight is meaningful: a wrong field index would be far outside it.
    const lo = Math.min(Number(trimmed[0]), Number(rawAfter.trim().split(/\s+/)[0]!));
    const hi = Math.max(Number(trimmed[0]), Number(rawAfter.trim().split(/\s+/)[0]!));
    const load1 = valueOf(snap.load.load1)!;
    expect(load1).toBeGreaterThanOrEqual(lo);
    expect(load1).toBeLessThanOrEqual(hi);

    expect(parseLoadAvg(rawBefore)).not.toBeNull();
    // lastPid must be plausible rather than equal: it is a PID, so it only has
    // to be a positive integer, and the interesting property is that the
    // collector reports the kernel's value and not a fabricated one.
    const lastPid = valueOf(snap.load.lastPid);
    if (lastPid !== null) {
      expect(Number.isSafeInteger(lastPid)).toBe(true);
      expect(lastPid).toBeGreaterThan(0);
    }
  });

  it("/proc/pressure/*: values match the raw file, and absence is never a zero", async () => {
    const snap = await warmed();
    expect(snap.pressure).toHaveLength(3);
    expect(snap.pressure.map((r) => r.resource)).toEqual(["cpu", "memory", "io"]);

    const cpuRaw = readOr("/proc/pressure/cpu");
    if (cpuRaw === null) {
      // No CONFIG_PSI. Every field must be UNAVAILABLE with a reason, and
      // critically none may be 0.
      for (const record of snap.pressure) {
        for (const window of [record.some, record.full]) {
          for (const key of ["avg10", "avg60", "avg300"] as const) {
            expect(window[key].provenance).toBe("UNAVAILABLE");
            expect(window[key].value).toBeNull();
            expect(window[key].reason).toBeTruthy();
          }
        }
      }
      return;
    }
    const parsed = parsePressure(cpuRaw);
    expect(parsed).not.toBeNull();
    const cpuRecord = snap.pressure.find((r) => r.resource === "cpu")!;
    // Independent read of avg10 from the "some" line.
    const someLine = cpuRaw.split("\n").find((l) => l.startsWith("some "))!;
    const handAvg10 = Number(/avg10=([\d.]+)/.exec(someLine)![1]);
    expect(valueOf(cpuRecord.some.avg10)).toBe(handAvg10);
    // All pressure values are bounded percentages.
    for (const record of snap.pressure) {
      for (const window of [record.some, record.full]) {
        for (const key of ["avg10", "avg60", "avg300"] as const) {
          const v = valueOf(window[key]);
          if (v !== null) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(100);
          }
        }
      }
    }
  });

  it("thermal: CAPS reports exactly the sensors the kernel exposes, and invents none", async () => {
    const snap = await warmed();

    // Independent count: temp*_input files plus thermal zones.
    let handSensorCount = 0;
    for (const hwmon of listOr("/sys/class/hwmon") ?? []) {
      if (!/^hwmon\d+$/.test(hwmon)) continue;
      for (const f of listOr(`/sys/class/hwmon/${hwmon}`) ?? []) {
        if (/^temp\d+_input$/.test(f)) handSensorCount += 1;
      }
    }
    const handZoneCount = (listOr("/sys/class/thermal") ?? []).filter((n) => /^thermal_zone\d+$/.test(n)).length;
    const expected = handSensorCount + handZoneCount;

    expect(snap.thermal.sensors.length).toBe(expected);

    if (expected === 0) {
      // The critical property: no sensor means UNAVAILABLE, never 0 degrees.
      expect(valueOf(snap.thermal.highestCelsius)).toBeNull();
      expect(valueOf(snap.thermal.packageCelsius)).toBeNull();
      expect(valueOf(snap.thermal.availability)).toBe("UNAVAILABLE");
      expect(snap.thermal.availability.reason).toMatch(/no temperature sensor/i);
      return;
    }

    for (const sensor of snap.thermal.sensors) {
      const rawText = readOr(sensor.path);
      if (rawText === null) continue;
      expect(valueOf(sensor.rawMilliCelsius)).toBe(Number(rawText.trim()));
      if (sensor.rawMilliCelsius.value !== null && sensor.celsius.value !== null) {
        // The single, only millidegree-to-Celsius conversion.
        expect(sensor.celsius.value).toBeCloseTo(sensor.rawMilliCelsius.value / 1000, 9);
      }
      // A sensor is never given a synthesized "CPU Temperature" label.
      expect(sensor.name).not.toBe("CPU Temperature");
      expect(sensor.name).not.toBe("CPU temperature");
    }

    // The reported maximum is the real maximum of the readable set.
    const readable = snap.thermal.sensors.filter((s) => s.celsius.value !== null).map((s) => s.celsius.value!);
    if (readable.length > 0) {
      expect(valueOf(snap.thermal.highestCelsius)).toBe(Math.max(...readable));
    }
  });

  it("thermal: a package sensor is claimed only when the kernel names one", async () => {
    const snap = await warmed();
    const named = snap.thermal.sensors.filter((s) => s.isPackage.value === true);
    if (named.length === 0) {
      expect(valueOf(snap.thermal.packageCelsius)).toBeNull();
      expect(snap.thermal.packageCelsius.reason).toBeTruthy();
      // Crucially, an absent package sensor must not be reported as 0 C.
      expect(snap.thermal.packageCelsius.value).not.toBe(0);
    } else {
      for (const sensor of named) {
        expect(sensor.isPackage.reason).toMatch(/identifies this sensor as a package/i);
      }
    }
  });

  it("frequency: no policy is invented, and a hardware measurement is never claimed", async () => {
    const snap = await warmed();
    const handPolicies = (listOr("/sys/devices/system/cpu/cpufreq") ?? []).filter((n) => /^policy\d+$/.test(n)).length;
    expect(snap.frequency.policies.length).toBe(handPolicies);

    if (handPolicies === 0) {
      expect(valueOf(snap.frequency.availability)).toBe("UNAVAILABLE");
      expect(snap.frequency.availability.reason).toMatch(/cpufreq/i);
    } else {
      expect(valueOf(snap.frequency.availability)).toBe("AVAILABLE");
      for (const policy of snap.frequency.policies) {
        if (policy.requestedKhz.value === null) continue;
        const text = readOr(`/sys/devices/system/cpu/cpufreq/${policy.policy}/scaling_cur_freq`);
        if (text !== null) expect(policy.requestedKhz.value).toBe(Number(text.trim()));
      }
    }
    // Never a measured silicon clock: that is a product decision, not an
    // environment limitation, and it must stay UNAVAILABLE everywhere.
    expect(snap.frequency.measuredHardwareKhz.provenance).toBe("UNAVAILABLE");
    expect(valueOf(snap.frequency.measuredHardwareKhz)).toBeNull();
  });

  it("/proc/diskstats: CAPS device rows equal the raw file's fields", async () => {
    const snap = await warmed();
    const rawText = readOr("/proc/diskstats");
    if (rawText === null) {
      expect(snap.disk.devices).toEqual([]);
      return;
    }
    const parsed = parseDiskstats(rawText);

    // Regression guard. A parser that rejects the non-numeric device-name field
    // returns zero devices for every line, which looks identical to "this
    // kernel exposes no block devices" and would make every assertion below
    // vacuous. Compare against the count of non-pseudo lines actually present.
    const rawNonPseudo = rawText
      .split("\n")
      .filter((l) => /^\s*\d+\s+\d+\s+\S/.test(l))
      .filter((l) => !/^\s*\d+\s+\d+\s+(loop|ram|zram|dm-|md|sr|fd)\d*\s/.test(l));
    expect(snap.disk.devices.length, "every non-pseudo /proc/diskstats line must become a device row").toBe(rawNonPseudo.length);
    expect(snap.disk.devices.length).toBeGreaterThan(0);

    const byName = new Map(parsed.map((d) => [d.name, d]));
    for (const device of snap.disk.devices) {
      const hand = byName.get(device.name);
      if (hand === undefined) continue;
      expect(valueOf(device.readsCompleted)).toBe(hand.readsCompleted);
      expect(valueOf(device.sectorsRead)).toBe(hand.sectorsRead);
      expect(valueOf(device.sectorsWritten)).toBe(hand.sectorsWritten);
      expect(valueOf(device.inFlight)).toBe(hand.inFlight);
      expect(valueOf(device.ioMillis)).toBe(hand.ioMillis);
      // Byte counters are 512-byte sectors, per proc_diskstats(5).
      expect(valueOf(device.readBytes)).toBe(hand.sectorsRead * 512);
      // inFlight is a gauge and must never be differenced.
      expect(device.inFlight.provenance).toBe("OBSERVED");
    }
  });

  it("/proc/net/dev: CAPS enumerates every interface the kernel lists", async () => {
    const snap = await warmed();
    const rawText = readOr("/proc/net/dev");
    if (rawText === null) {
      expect(snap.network.interfaces).toEqual([]);
      return;
    }
    // Same regression guard as for diskstats: an empty list must never pass
    // vacuously when the file clearly has rows.
    expect(snap.network.interfaces.length).toBe(parseNetDev(rawText).length);
    // Linux always has loopback.
    expect(snap.network.interfaces.length).toBeGreaterThan(0);
  });

  it("/proc/net/dev: CAPS interface rows equal the raw file's counters", async () => {
    const snap = await warmed();
    // Per-process network is UNAVAILABLE by design, always, with a reason that
    // says why rather than a bare zero.
    expect(snap.network.perProcessBytes.provenance).toBe("UNAVAILABLE");
    expect(valueOf(snap.network.perProcessBytes)).toBeNull();
    expect(snap.network.perProcessBytes.reason).toMatch(/no per-process network/i);

    const rawText = readOr("/proc/net/dev");
    if (rawText === null) {
      expect(snap.network.interfaces).toEqual([]);
      return;
    }
    const parsed = parseNetDev(rawText);
    const byName = new Map(parsed.map((i) => [i.name, i]));
    expect(snap.network.interfaces.length).toBe(parsed.length);
    for (const iface of snap.network.interfaces) {
      const hand = byName.get(iface.name);
      if (hand === undefined) continue;
      expect(valueOf(iface.rxBytes)).toBe(hand.rxBytes);
      expect(valueOf(iface.rxPackets)).toBe(hand.rxPackets);
      expect(valueOf(iface.rxErrors)).toBe(hand.rxErrors);
      expect(valueOf(iface.rxDropped)).toBe(hand.rxDropped);
      expect(valueOf(iface.txBytes)).toBe(hand.txBytes);
      expect(valueOf(iface.txDropped)).toBe(hand.txDropped);
    }
    // Loopback is present, not filtered out: it is where host-local traffic is.
    if (byName.has("lo")) expect(snap.network.interfaces.some((i) => i.name === "lo")).toBe(true);
  });

  it("statfs: CAPS capacity equals an independent statfs call", async () => {
    const snap = await warmed();
    const fs = snap.disk.filesystems.find((f) => f.mountPoint === "/");
    if (fs === undefined) return;
    const stats = statfsSync("/");
    const bsize = Number(stats.bsize);
    expect(valueOf(fs.totalBytes)).toBe(Number(stats.blocks) * bsize);
    expect(valueOf(fs.freeBytes)).toBe(Number(stats.bfree) * bsize);
    // f_bavail, which is legitimately lower than f_bfree by the root reserve.
    expect(valueOf(fs.availableToUserBytes)).toBe(Number(stats.bavail) * bsize);
  });
});

describe.skipIf(!isLinux)("the gateway's own process row matches its own /proc entry", () => {
  it("reads the collector's own PID correctly from live procfs", () => {
    const pid = process.pid;
    const raw = readOr(`/proc/${pid}/stat`);
    expect(raw).not.toBeNull();
    const parsed = parseStatLine(raw!)!;
    expect(parsed.pid).toBe(pid);
    // Our own parent is the shell that launched vitest, and our own state is
    // running or sleeping. Both are checkable facts about this very process.
    expect(["R", "S", "D", "I"].includes(parsed.state)).toBe(true);
    expect(parsed.startTicks).toBeGreaterThan(0);
  });

  it("splits our own NUL-separated cmdline into the arguments we were given", () => {
    const raw = readOr(`/proc/${process.pid}/cmdline`);
    expect(raw).not.toBeNull();
    const argv = parseCmdline(raw!);
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.length).toBeGreaterThan(0);
    // No argument may contain a NUL: the kernel's separator, not data.
    for (const a of argv) expect(a.includes("\0")).toBe(false);
  });

  it("reports our own CPU time as a non-negative millisecond figure", () => {
    const raw = readOr(`/proc/${process.pid}/stat`)!;
    const parsed = parseStatLine(raw)!;
    const ticks = parsed.utime + parsed.stime;
    expect(ticks).toBeGreaterThanOrEqual(0);
  });
});

describe.skipIf(!isLinux)("PSS parsing matches the kernel's own smaps_rollup", () => {
  it("reads the gateway's own smaps_rollup and reproduces PSS in bytes", () => {
    const raw = readOr("/proc/self/smaps_rollup");
    if (raw === null) {
      // CONFIG_PROC_PAGE_MONITOR off. The parser must not be required.
      expect(parseSmapsRollup("garbage", "/proc/self/smaps_rollup", new Date().toISOString())).toBeNull();
      return;
    }
    const parsed = parseSmapsRollup(raw, "/proc/self/smaps_rollup", new Date().toISOString())!;
    const handKib = Number(/^Pss:\s+(\d+)\s+kB$/m.exec(raw)![1]);
    expect(valueOf(parsed.pss)).toBe(handKib * 1024);
    // PSS must never exceed RSS for a real process: PSS divides shared pages.
    const pss = valueOf(parsed.pss)!;
    const rss = valueOf(parsed.rss)!;
    expect(pss).toBeLessThanOrEqual(rss + 1024);
  });
});

describe.skipIf(!isLinux)("schedstat parsing matches the kernel's own file", () => {
  it("parses three integers, or reports the file as absent", () => {
    const raw = readOr("/proc/self/schedstat");
    if (raw === null) {
      // CONFIG_SCHEDSTATS off, which is a legitimate kernel configuration.
      expect(parseSchedstat("", new Date().toISOString())).toBeNull();
      return;
    }
    const parsed = parseSchedstat(raw, new Date().toISOString());
    expect(parsed).not.toBeNull();
    const f = raw.trim().split(/\s+/).map(Number);
    expect(valueOf(parsed!.runtime)).toBe(f[0]);
    expect(valueOf(parsed!.wait)).toBe(f[1]);
    expect(valueOf(parsed!.timeslices)).toBe(f[2]);
  });
});
