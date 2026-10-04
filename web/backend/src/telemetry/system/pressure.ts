/**
 * Load average and pressure stall information.
 *
 * LOAD, UTILIZATION, AND PRESSURE ARE THREE DIFFERENT NUMBERS
 * ---------------------------------------------------------
 * These are routinely conflated and the conflation is the single most common
 * error in a home-grown dashboard, so each is defined here once:
 *
 *   - **Utilization** (`cpu.ts`): the fraction of CPU *time* spent running
 *     something. Bounded 0..100. A host at 100% utilization has every
 *     millisecond of CPU spent on work.
 *   - **Load average** (`/proc/loadavg`): the exponentially-damped average
 *     count of runnable and uninterruptible-sleep tasks. Unbounded. A host at
 *     load 8 on 12 CPUs at 20% utilization is normal: tasks are queued waiting
 *     for their turn, not for CPU time.
 *   - **Pressure** (`/proc/pressure/*`): the fraction of wall time at least
 *     some task spent *stalled* on a resource. Bounded 0..100, and about a
 *     different thing again. A host can sit at 5% utilization and 90% memory
 *     pressure at the same time.
 *
 * No module in this directory converts one of these into another, because each
 * conversion loses information and none of them is a valid substitute.
 */

import { readTextFile, parseFinite, procPath, type KernelPaths } from "./read.js";
import { derived, observed, unavailable, type LoadSnapshot, type PressureAverages, type PressureRecord, type SystemMetric } from "./types.js";

// ---------------------------------------------------------------------------
// Load average
// ---------------------------------------------------------------------------

/** One `/proc/loadavg` parse. */
export interface LoadAvg {
  load1: number;
  load5: number;
  load15: number;
  runnable: number;
  totalThreads: number;
  lastPid: number;
}

/**
 * Parse `/proc/loadavg`.
 *
 * The format is fixed by the kernel: three floats, then `runnable/total`, then
 * the last allocated PID. A trailing field Linux may append is ignored.
 */
export function parseLoadAvg(text: string): LoadAvg | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const load1 = Number(parts[0]);
  const load5 = Number(parts[1]);
  const load15 = Number(parts[2]);
  if (!Number.isFinite(load1) || !Number.isFinite(load5) || !Number.isFinite(load15)) return null;

  const counts = parts[3]!.split("/");
  const runnable = Number(counts[0]);
  const total = Number(counts[1]);
  if (!Number.isSafeInteger(runnable) || !Number.isSafeInteger(total)) return null;

  const lastPid = Number(parts[4]);
  if (!Number.isSafeInteger(lastPid)) return null;

  return { load1, load5, load15, runnable, totalThreads: total, lastPid };
}

/** Build the load block. `logicalCpus` null yields an unavailable per-CPU load. */
export function buildLoadSnapshot(
  paths: KernelPaths,
  logicalCpus: number | null,
  timestamp: string,
): LoadSnapshot {
  const path = procPath(paths, "loadavg");
  const result = readTextFile(path);
  if (!result.ok) {
    const bad = unavailable<number>("1", path, timestamp, result.failure.reason);
    return {
      load1: bad, load5: bad, load15: bad, load1PerCpu: bad,
      runnable: bad, totalThreads: bad, lastPid: bad,
    };
  }
  const parsed = parseLoadAvg(result.text);
  if (parsed === null) {
    const bad = unavailable<number>("1", path, timestamp, "/proc/loadavg did not match the kernel's documented format");
    return {
      load1: bad, load5: bad, load15: bad, load1PerCpu: bad,
      runnable: bad, totalThreads: bad, lastPid: bad,
    };
  }

  const where = `${path} (proc_loadavg(5))`;
  const note = "Exponentially-damped average of runnable and uninterruptible-sleep tasks. NOT CPU utilization and NOT a queue depth.";
  const load1PerCpu: SystemMetric<number> =
    logicalCpus === null || logicalCpus <= 0
      ? unavailable<number>("1", where, timestamp, "Cannot normalise by CPU count: the kernel's logical CPU count is unavailable")
      : derived(
          parsed.load1 / logicalCpus,
          "1",
          where,
          timestamp,
          "load1 / logical CPU count. Comparable to a load of 1.0 meaning one runnable task per CPU; the raw load is unbounded.",
        );

  return {
    load1: observed(parsed.load1, "1", where, timestamp, note),
    load5: observed(parsed.load5, "1", where, timestamp, note),
    load15: observed(parsed.load15, "1", where, timestamp, note),
    load1PerCpu,
    runnable: observed(parsed.runnable, "1", `${path} runnable numerator`, timestamp, "Threads currently runnable on the CPU"),
    totalThreads: observed(parsed.totalThreads, "1", `${path} total denominator`, timestamp, "Threads in the whole system, the denominator of the load average"),
    lastPid: observed(parsed.lastPid, "1", `${path} last field`, timestamp, "Most recently allocated PID. Advances on every fork, so a stalled value means the collector is reading a stale file rather than the live kernel."),
  };
}

// ---------------------------------------------------------------------------
// Pressure stall information
// ---------------------------------------------------------------------------

/** The resources the kernel publishes pressure for. */
export const PRESSURE_RESOURCES = ["cpu", "memory", "io"] as const;
export type PressureResource = (typeof PRESSURE_RESOURCES)[number];

/** What PSI is for, rendered verbatim in the UI so it cannot be misread. */
export const PRESSURE_EXPLANATION = {
  cpu: "Wall-clock time during which at least one task was stalled waiting for CPU. Low values with high load mean the queue is long but the wait is short; high values mean latency, not just queueing.",
  memory: "Wall-clock time during which at least one task was stalled reclaiming memory or hitting a limit. This is the metric that predicts out-of-memory kills; free memory does not.",
  io: "Wall-clock time during which at least one task was stalled on block I/O. Distinguishes a slow device from a saturated one.",
} as const;

const AVERAGES = [
  { key: "avg10", seconds: 10 },
  { key: "avg60", seconds: 60 },
  { key: "avg300", seconds: 300 },
] as const;

/** Reasons used when a pressure file is absent, which is common and legal. */
export const PRESSURE_REASONS = {
  missing: (resource: string) =>
    `/proc/pressure/${resource} does not exist. Linux exposes pressure stall information only when the kernel was built with CONFIG_PSI and the resource has a stall-tracking site; many container and virtualised kernels omit it.`,
  malformed: (resource: string) => `/proc/pressure/${resource} did not parse as pressure stall information`,
  fullUnsupported: (resource: string) =>
    `The kernel does not publish a "full" line for ${resource}. I/O pressure in particular has no meaningful full-window value, because it is not possible for every task on the system to be stalled on the same I/O device in a way the kernel counts.`,
} as const;

/**
 * Parse one `/proc/pressure/*` file.
 *
 * Format, per psi(5):
 *   some avg10=0.00 avg60=0.00 avg300=0.00 total=0
 *   full avg10=0.00 avg60=0.00 avg300=0.00 total=0
 *
 * `total` is cumulative stall microseconds and is deliberately not exported:
 * it is a counter whose useful form is a rate, and a rate needs two samples.
 * The `some`/`full` averages are already rates over their windows, so they are
 * published directly.
 */
export function parsePressure(text: string): { some: Record<string, number>; full: Record<string, number> } | null {
  const some: Record<string, number> = {};
  const full: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const space = trimmed.indexOf(" ");
    if (space <= 0) return null;
    const kind = trimmed.slice(0, space);
    if (kind !== "some" && kind !== "full") return null;
    const target = kind === "some" ? some : full;
    for (const pair of trimmed.slice(space + 1).split(/\s+/)) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const key = pair.slice(0, eq);
      const value = parseFinite(pair.slice(eq + 1));
      if (value === null) continue;
      target[key] = value;
    }
  }
  if (Object.keys(some).length === 0) return null;
  return { some, full };
}

function averages(
  values: Record<string, number>,
  window: "some" | "full",
  resource: string,
  where: string,
  timestamp: string,
): PressureAverages {
  const built: Partial<Record<"avg10" | "avg60" | "avg300", SystemMetric<number>>> = {};
  for (const { key, seconds } of AVERAGES) {
    const value = values[key];
    built[key] =
      value === undefined
        ? unavailable<number>(
            "%",
            where,
            timestamp,
            window === "full"
              ? PRESSURE_REASONS.fullUnsupported(resource)
              : `${key} is absent from the ${window} line for ${resource}`,
          )
        : observed(
            value,
            "%",
            where,
            timestamp,
            `Percent of wall time over the last ${seconds} seconds during which at least ${window === "some" ? "one" : "every"} task was stalled on ${resource}. From psi(5).`,
          );
  }
  return built as PressureAverages;
}

/**
 * Read all three pressure resources.
 *
 * A resource whose file is missing yields a record whose every field is
 * UNAVAILABLE carrying the kernel-accurate reason, rather than being dropped.
 * Keeping the record present means the UI can state which resources the
 * machine supports instead of silently rendering fewer cards.
 */
export function buildPressure(paths: KernelPaths, timestamp: string): PressureRecord[] {
  return PRESSURE_RESOURCES.map((resource) => {
    const path = procPath(paths, "pressure", resource);
    const result = readTextFile(path);
    if (!result.ok) {
      const reason = result.failure.kind === "missing" ? PRESSURE_REASONS.missing(resource) : result.failure.reason;
      const bad = unavailable<number>("%", path, timestamp, reason);
      return { resource, some: { avg10: bad, avg60: bad, avg300: bad }, full: { avg10: bad, avg60: bad, avg300: bad } };
    }
    const parsed = parsePressure(result.text);
    if (parsed === null) {
      const bad = unavailable<number>("%", path, timestamp, PRESSURE_REASONS.malformed(resource));
      return { resource, some: { avg10: bad, avg60: bad, avg300: bad }, full: { avg10: bad, avg60: bad, avg300: bad } };
    }
    const where = `${path} (psi(5))`;
    return {
      resource,
      some: averages(parsed.some, "some", resource, where, timestamp),
      full: averages(parsed.full, "full", resource, where, timestamp),
    };
  });
}
