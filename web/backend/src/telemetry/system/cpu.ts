/**
 * System CPU telemetry from `/proc/stat`.
 *
 * THE RULE THAT MAKES THIS HONEST
 * -------------------------------
 * `/proc/stat` publishes *cumulative* counters in USER_HZ ticks, reset only at
 * boot. A single sample therefore cannot produce a utilization figure: a machine
 * that has been up for six days has enormous `user` and `idle` values that say
 * nothing about the last second. Utilization is always a delta between two
 * samples separated by a measured interval, and when those two samples cannot
 * be trusted the result is UNAVAILABLE, never 0.
 *
 * HOW IDLE AND IOWAIT ARE TREATED (and why)
 * -----------------------------------------
 * The kernel itself does not distinguish idle from iowait: `iowait` is time
 * spent idle waiting for block I/O to complete, and the kernel counts it
 * toward the idle total. `top`, `mpstat`, and `vmstat` all treat
 * `idle + iowait` as idle. This module follows that convention so the number
 * agrees with every other Linux tool:
 *
 *     deltaIdle = delta(idle) + delta(iowait)
 *     deltaBusy = deltaTotal - deltaIdle
 *     busyPercent = deltaBusy / deltaTotal * 100
 *
 * That makes a storage-bound host read as *idle*, which is arguably wrong from
 * a human standpoint, so `busyPlusIowaitPercent` is published alongside it.
 * Neither is invented: both come from the same two deltas, and the UI shows
 * them as distinct fields rather than picking one and calling it the truth.
 *
 * WHY GUEST TIME IS NOT ADDED
 * --------------------------
 * `proc_stat(5)` states that guest time is *already included* in user, and
 * guest_nice in nice. Summing all ten fields would inflate the denominator and
 * understate every percentage. `sumTicks` therefore sums eight fields and is
 * the only place that decision is encoded.
 */

import { readTextFile, procPath, type KernelPaths } from "./read.js";
import {
  unavailable,
  observed,
  derived,
  type CpuCore,
  type CpuCoreUtilization,
  type CpuSnapshot,
  type CpuTimes,
  type CpuUtilization,
  type ProcStatSample,
  type SystemMetric,
} from "./types.js";

/** Reasons a delta cannot be computed, reused by every guard below. */
export const CPU_REASONS = {
  firstSample: "First CPU sample for this boot: utilization needs two samples separated by a measured interval",
  zeroInterval: "Interval between the two CPU samples was zero; no rate is defined",
  rollback: "A /proc/stat counter decreased between samples, which Linux does not do within one boot; the interval is not trustworthy",
  bootChange: "The machine rebooted between the two CPU samples; cumulative counters are not comparable across a boot",
  topology: "The set of logical CPUs changed between samples (hotplug or topology change); per-core deltas are not comparable",
  malformed: "/proc/stat was present but did not parse as CPU counters",
  missing: "CPU utilization is unavailable on this kernel",
  cpuIdle: "Cumulative CPU ticks did not advance over the interval; the host may be suspended or the counters may be frozen",
} as const;

/** Field order in `/proc/stat`, per proc_stat(5). Index 3 is the first tick. */
const CPU_FIELD_ORDER = [
  "user",
  "nice",
  "system",
  "idle",
  "iowait",
  "irq",
  "softirq",
  "steal",
  "guest",
  "guestNice",
] as const satisfies readonly (keyof CpuTimes)[];

/** The eight fields that sum to total CPU time. guest/guestNice are excluded. */
const TOTAL_FIELDS = ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"] as const satisfies readonly (keyof CpuTimes)[];

/**
 * Sum CPU ticks as the kernel defines total time.
 *
 * Deliberately excludes `guest` and `guestNice`, which proc_stat(5) documents as
 * already counted inside `user` and `nice`. Exported because the documented
 * formula in docs/telemetry-contract.md has to be checkable from a test.
 */
export function sumTicks(times: CpuTimes): number {
  return TOTAL_FIELDS.reduce((acc, key) => acc + times[key], 0);
}

/** Idle ticks as the kernel defines them: idle time including block-I/O wait. */
export function idleTicks(times: CpuTimes): number {
  return times.idle + times.iowait;
}

/** Busy ticks: everything that is not idle. */
export function busyTicks(times: CpuTimes): number {
  return sumTicks(times) - idleTicks(times);
}

function zeroTimes(): CpuTimes {
  return { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0, guest: 0, guestNice: 0 };
}

/**
 * Parse one `cpu` / `cpuN` line.
 *
 * `fields` is the line's values only: the `cpu` / `cpuN` label has already
 * been removed by the caller, so `fields[0]` is the `user` counter. Indexing
 * from `fields[0]` matters more than it looks: shifting by even one position
 * makes every field report its neighbour's value, and the resulting
 * utilization figures are entirely plausible while being completely wrong.
 *
 * Linux appends guest columns conditionally: a kernel without
 * CONFIG_VIRT_CPU_ACCOUNTING_GEN omits fields 9 and 10 entirely. The parser
 * accepts 4..10 numeric fields and leaves absent trailing fields at zero, so
 * `guest` reads 0 rather than becoming a parse failure.
 */
export function parseCpuLine(fields: readonly string[]): CpuTimes | null {
  if (fields.length < 4) return null;
  const times = zeroTimes();
  for (let i = 0; i < CPU_FIELD_ORDER.length; i += 1) {
    const raw = fields[i];
    if (raw === undefined) break;
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return null;
    times[CPU_FIELD_ORDER[i]!] = n;
  }
  return times;
}

/**
 * Parse a whole `/proc/stat`.
 *
 * Only the `cpu` and `cpuN` lines are interpreted. `intr`, `ctxt`, `btime`,
 * and `processes` are real kernel data that other parts of this module consume
 * (see processSummary in collector.ts) but are not CPU *time*, and folding them
 * in here would be a category error.
 */
export function parseProcStat(text: string): ProcStatSample | null {
  let total: CpuTimes | null = null;
  const cores: CpuCore[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("cpu ")) {
      total = parseCpuLine(line.split(/\s+/).filter(Boolean).slice(1));
      if (total === null) return null;
      continue;
    }
    const coreMatch = /^cpu(\d+)\s+(.*)$/.exec(line);
    if (coreMatch === null) continue;
    const index = Number(coreMatch[1]);
    if (!Number.isSafeInteger(index) || index < 0) return null;
    const times = parseCpuLine(coreMatch[2]!.split(/\s+/).filter(Boolean));
    if (times === null) return null;
    cores.push({ index, times });
  }
  if (total === null) return null;
  // The kernel lists cores in ascending index; sorting makes the sample
  // order-independent so two identical samples compare equal.
  cores.sort((a, b) => a.index - b.index);
  return { total, cores };
}

/** `processes` (forks since boot) and `procs_running`/`procs_blocked` counts. */
export interface ProcStatExtras {
  processesCreated: number | null;
  procsRunning: number | null;
  procsBlocked: number | null;
  btime: number | null;
  contextSwitches: number | null;
}

/** Extract the non-CPU-time fields the snapshot needs from `/proc/stat`. */
export function parseProcStatExtras(text: string): ProcStatExtras {
  const out: ProcStatExtras = {
    processesCreated: null,
    procsRunning: null,
    procsBlocked: null,
    btime: null,
    contextSwitches: null,
  };
  for (const line of text.split("\n")) {
    const parts = line.split(/\s+/).filter(Boolean);
    const key = parts[0];
    if (key === undefined) continue;
    if (key === "processes" || key === "ctxt") {
      const n = Number(parts[1]);
      if (Number.isSafeInteger(n)) {
        if (key === "processes") out.processesCreated = n;
        else out.contextSwitches = n;
      }
    } else if (key === "procs_running" || key === "procs_blocked") {
      const n = Number(parts[1]);
      if (Number.isSafeInteger(n)) {
        if (key === "procs_running") out.procsRunning = n;
        else out.procsBlocked = n;
      }
    } else if (key === "btime") {
      const n = Number(parts[1]);
      if (Number.isFinite(n) && n > 0) out.btime = n;
    }
  }
  return out;
}

/** Read and parse `/proc/stat`, or explain why it could not be used. */
export function readProcStat(paths: KernelPaths): { ok: true; sample: ProcStatSample; extras: ProcStatExtras; source: string } | { ok: false; reason: string } {
  const path = procPath(paths, "stat");
  const result = readTextFile(path);
  if (!result.ok) return { ok: false, reason: result.failure.reason };
  const sample = parseProcStat(result.text);
  if (sample === null) return { ok: false, reason: CPU_REASONS.malformed };
  return { ok: true, sample, extras: parseProcStatExtras(result.text), source: path };
}

/** Everything the delta computation needs to carry between two samples. */
export interface CpuPrevious {
  times: CpuTimes;
  cores: CpuCore[];
  /** Monotonic or wall clock of the previous read, in ms. */
  atMs: number;
  /** Boot identity at the previous read. A change invalidates the delta. */
  bootId: string | null;
}

function percent(
  numerator: number,
  denominator: number,
  unit: string,
  source: string,
  timestamp: string,
  formula: string,
): SystemMetric<number> {
  if (denominator <= 0) {
    return unavailable<number>("%", source, timestamp, CPU_REASONS.cpuIdle);
  }
  return derived((numerator / denominator) * 100, "%", source, timestamp, formula);
}

/**
 * Compute utilization of one CPU set from two cumulative samples.
 *
 * `label` names the CPU set in the metric source ("all CPUs" or `cpu3`) so a
 * per-core percentage is never mistaken for the machine-wide figure.
 */
function utilizationFor(
  current: CpuTimes,
  previous: CpuTimes,
  label: string,
  source: string,
  timestamp: string,
): CpuUtilization {
  const dUser = current.user - previous.user;
  const dNice = current.nice - previous.nice;
  const dSystem = current.system - previous.system;
  const dIdle = current.idle - previous.idle;
  const dIowait = current.iowait - previous.iowait;
  const dIrq = current.irq - previous.irq;
  const dSoftirq = current.softirq - previous.softirq;
  const dSteal = current.steal - previous.steal;

  const deltas = [dUser, dNice, dSystem, dIdle, dIowait, dIrq, dSoftirq, dSteal];
  if (deltas.some((d) => d < 0)) {
    const bad = unavailable<number>("%", source, timestamp, CPU_REASONS.rollback);
    return {
      busyPercent: bad,
      idlePercent: bad,
      iowaitPercent: bad,
      userPercent: bad,
      nicePercent: bad,
      systemPercent: bad,
      irqPercent: bad,
      stealPercent: bad,
      busyPlusIowaitPercent: bad,
      intervalMs: unavailable<number>("ms", source, timestamp, CPU_REASONS.rollback),
    };
  }

  const dTotal = deltas.reduce((a, b) => a + b, 0);
  const dBusy = dTotal - dIdle - dIowait;
  const where = `${source} ${label}, delta of two samples`;
  const fmt = (field: string) => `delta(${field}) / delta(total) * 100, where total = user + nice + system + idle + iowait + irq + softirq + steal (proc_stat(5))`;

  return {
    busyPercent: percent(dBusy, dTotal, "%", where, timestamp, fmt("total - idle - iowait")),
    idlePercent: percent(dIdle, dTotal, "%", where, timestamp, fmt("idle")),
    iowaitPercent: percent(dIowait, dTotal, "%", where, timestamp, fmt("iowait")),
    userPercent: percent(dUser, dTotal, "%", where, timestamp, fmt("user")),
    nicePercent: percent(dNice, dTotal, "%", where, timestamp, fmt("nice")),
    systemPercent: percent(dSystem, dTotal, "%", where, timestamp, fmt("system")),
    irqPercent: percent(dIrq + dSoftirq, dTotal, "%", where, timestamp, fmt("irq + softirq")),
    stealPercent: percent(dSteal, dTotal, "%", where, timestamp, fmt("steal")),
    busyPlusIowaitPercent: percent(dBusy + dIowait, dTotal, "%", where, timestamp, fmt("total - idle")),
    intervalMs: unavailable<number>("ms", source, timestamp, "Interval is reported once for the whole snapshot, not per CPU set"),
  };
}

/** The failure shape returned when no delta can be computed at all. */
function utilizationUnavailable(source: string, timestamp: string, reason: string): CpuUtilization {
  const bad = unavailable<number>("%", source, timestamp, reason);
  return {
    busyPercent: bad,
    idlePercent: bad,
    iowaitPercent: bad,
    userPercent: bad,
    nicePercent: bad,
    systemPercent: bad,
    irqPercent: bad,
    stealPercent: bad,
    busyPlusIowaitPercent: bad,
    intervalMs: unavailable<number>("ms", source, timestamp, reason),
  };
}

function perCoreUnavailable(index: number, source: string, timestamp: string, reason: string): CpuCoreUtilization {
  return {
    index,
    busyPercent: unavailable<number>("%", source, timestamp, reason),
    idlePercent: unavailable<number>("%", source, timestamp, reason),
    iowaitPercent: unavailable<number>("%", source, timestamp, reason),
  };
}

/**
 * Build the CPU block of a snapshot.
 *
 * `previous` is `null` on the first collection after start-up, which yields a
 * fully UNAVAILABLE utilization block. That is the correct first response: the
 * cumulative counters are published (they are real observed data) but no
 * percentage can honestly be stated yet.
 */
export function buildCpuSnapshot(
  paths: KernelPaths,
  previous: CpuPrevious | null,
  bootId: string | null,
  nowMs: number,
  timestamp: string,
): { snapshot: CpuSnapshot; previous: CpuPrevious; extras: ProcStatExtras | null } {
  const read = readProcStat(paths);

  if (!read.ok) {
    const reason = read.reason;
    const where = procPath(paths, "stat");
    // Preserve the previous sample so the *next* collection can still produce a
    // delta; dropping it would strand the collector at "first sample" forever.
    const carried: CpuPrevious = previous ?? { times: zeroTimes(), cores: [], atMs: nowMs, bootId };
    return {
      snapshot: {
        utilization: utilizationUnavailable(where, timestamp, reason),
        perCore: [],
        currentTimes: unavailable<CpuTimes>("USER_HZ", where, timestamp, reason),
        previousTimes: unavailable<CpuTimes>("USER_HZ", where, timestamp, reason),
        coreCount: unavailable<number>("1", where, timestamp, reason),
      },
      previous: carried,
      extras: null,
    };
  }

  const { sample, extras, source } = read;
  const currentTimes = observed(sample.total, "USER_HZ", source, timestamp, "Cumulative since boot; per proc_stat(5)");
  const coreCount = observed(sample.cores.length, "1", `${source} cpuN lines`, timestamp, "Logical CPUs the kernel enumerated in this sample");
  const next: CpuPrevious = { times: sample.total, cores: sample.cores, atMs: nowMs, bootId };

  if (previous === null) {
    // The cores are already known from the current sample even though no
    // percentage can be computed yet. Returning an empty list would tell the
    // UI "this machine has no cores", which is false; returning the rows with
    // UNAVAILABLE percentages says the true thing: the cores exist, and a rate
    // needs a second sample.
    return {
      snapshot: {
        utilization: utilizationUnavailable(source, timestamp, CPU_REASONS.firstSample),
        perCore: sample.cores.map((core) => perCoreUnavailable(core.index, `${source} cpu${core.index}`, timestamp, CPU_REASONS.firstSample)),
        currentTimes,
        previousTimes: unavailable<CpuTimes>("USER_HZ", source, timestamp, CPU_REASONS.firstSample),
        coreCount,
      },
      previous: next,
      extras,
    };
  }

  const previousTimes = observed(previous.times, "USER_HZ", source, timestamp, "Cumulative at the previous sample; retained so a reader can recompute the delta");
  const intervalMs = nowMs - previous.atMs;

  if (bootId !== null && previous.bootId !== null && bootId !== previous.bootId) {
    return {
      snapshot: { utilization: utilizationUnavailable(source, timestamp, CPU_REASONS.bootChange), perCore: [], currentTimes, previousTimes, coreCount },
      previous: next,
      extras,
    };
  }

  if (intervalMs <= 0) {
    return {
      snapshot: { utilization: utilizationUnavailable(source, timestamp, CPU_REASONS.zeroInterval), perCore: [], currentTimes, previousTimes, coreCount },
      previous: next,
      extras,
    };
  }

  const utilization = utilizationFor(sample.total, previous.times, "aggregate", source, timestamp);
  utilization.intervalMs = observed(intervalMs, "ms", "gateway monotonic clock", timestamp, "Wall time between the two /proc/stat reads");

  // Per-core comparison requires the same CPU set in both samples. If a core
  // appeared or vanished, the aggregate figure is still valid (it is a sum
  // over all ticks) but per-core deltas are not, so they are withheld rather
  // than matched up by index.
  const previousIndexes = previous.cores.map((c) => c.index);
  const currentIndexes = sample.cores.map((c) => c.index);
  const topologyStable =
    previousIndexes.length === currentIndexes.length && previousIndexes.every((v, i) => v === currentIndexes[i]);

  let perCore: CpuCoreUtilization[];
  if (!topologyStable) {
    const reason = CPU_REASONS.topology;
    perCore = sample.cores.map((core) => ({
      index: core.index,
      busyPercent: unavailable<number>("%", `${source} cpu${core.index}`, timestamp, reason),
      idlePercent: unavailable<number>("%", `${source} cpu${core.index}`, timestamp, reason),
      iowaitPercent: unavailable<number>("%", `${source} cpu${core.index}`, timestamp, reason),
    }));
  } else {
    perCore = sample.cores.map((core) => {
      const before = previous.cores.find((c) => c.index === core.index);
      const where = `${source} cpu${core.index}`;
      if (before === undefined) {
        return perCoreUnavailable(core.index, where, timestamp, CPU_REASONS.topology);
      }
      const dTotal = sumTicks(core.times) - sumTicks(before.times);
      const dIdle = core.times.idle - before.times.idle;
      const dIowait = core.times.iowait - before.times.iowait;
      if (dTotal < 0 || dIdle < 0 || dIowait < 0) {
        return perCoreUnavailable(core.index, where, timestamp, CPU_REASONS.rollback);
      }
      const where2 = `${where}, delta of two samples`;
      return {
        index: core.index,
        busyPercent: percent(dTotal - dIdle - dIowait, dTotal, "%", where2, timestamp, "delta(total - idle - iowait) / delta(total) * 100"),
        idlePercent: percent(dIdle, dTotal, "%", where2, timestamp, "delta(idle) / delta(total) * 100"),
        iowaitPercent: percent(dIowait, dTotal, "%", where2, timestamp, "delta(iowait) / delta(total) * 100"),
      };
    });
  }

  return { snapshot: { utilization, perCore, currentTimes, previousTimes, coreCount }, previous: next, extras };
}
