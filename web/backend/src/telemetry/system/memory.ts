/**
 * System memory from `/proc/meminfo`.
 *
 * THE MEMORY QUESTION THIS MODULE REFUSES TO ANSWER
 * -------------------------------------------------
 * "How much memory is the machine using?" has three plausible answers and they
 * disagree by gigabytes on a healthy Linux host:
 *
 *   - `MemFree` is memory on the free list. On a healthy host it is
 *     deliberately small: the kernel spends idle memory on page cache because
 *     that is strictly better than keeping it unused.
 *   - `MemTotal - MemFree` counts the page cache as "used", so a machine that
 *     has been reading files for a week looks full.
 *   - `MemTotal - MemAvailable` is what the kernel believes an application
 *     could actually allocate without swapping. This is the figure every
 *     serious tool reports as "used".
 *
 * This module reports `used` as `total - available`, publishes `free` and
 * `available` separately so the difference is visible, and marks
 * `MemAvailable` with `estimate: true` because that is what the kernel
 * documents it as. Nothing here is normalised into a single "memory %" that
 * hides which of the three it used.
 */

import { readTextFile, parseKibibytes, procPath, type KernelPaths } from "./read.js";
import { derived, observed, observedEstimate, unavailable, type MemorySnapshot, type SystemMetric } from "./types.js";

export const MEMINFO_SOURCE = "proc_meminfo(5)";

/**
 * Fields read from `/proc/meminfo`.
 *
 * Every one is optional in principle: a kernel built with a smaller
 * CONFIG_KALLSYMS footprint publishes fewer lines. Each is therefore resolved
 * independently, and a missing line becomes UNAVAILABLE with "absent from
 * /proc/meminfo on this kernel" rather than 0 kB.
 */
const FIELDS = [
  "MemTotal",
  "MemFree",
  "MemAvailable",
  "Buffers",
  "Cached",
  "SReclaimable",
  "SwapTotal",
  "SwapFree",
  "SwapCached",
  "Active",
  "Inactive",
  "Dirty",
  "Writeback",
  "AnonPages",
  "Mapped",
  "Shmem",
  "Slab",
] as const;

export type MemInfoKey = (typeof FIELDS)[number];

/**
 * Parse `/proc/meminfo` into kibibyte values.
 *
 * Returns a map of only the fields the kernel actually published, so the
 * caller can distinguish "absent" from "zero". `MemTotal: 0` is a real reading
 * (a kernel with no memory is pathological but not impossible) and is kept.
 */
export function parseMemInfo(text: string): Map<MemInfoKey, number> {
  const known = new Set<string>(FIELDS);
  const out = new Map<MemInfoKey, number>();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (!known.has(key)) continue;
    const kib = parseKibibytes(line.slice(colon + 1));
    if (kib !== null) out.set(key as MemInfoKey, kib);
  }
  return out;
}

function field(
  values: Map<MemInfoKey, number>,
  key: MemInfoKey,
  source: string,
  timestamp: string,
): SystemMetric<number> {
  const kib = values.get(key);
  if (kib === undefined) {
    return unavailable<number>("bytes", source, timestamp, `${key} is absent from /proc/meminfo on this kernel`);
  }
  return observed(kib, "bytes", source, timestamp, `${key} from /proc/meminfo, converted from kB to bytes`);
}

/** Build the memory block. `available` is deliberately flagged as an estimate. */
export function buildMemorySnapshot(
  paths: KernelPaths,
  nowMs: number,
  timestamp: string,
): MemorySnapshot {
  const path = procPath(paths, "meminfo");
  const result = readTextFile(path);
  if (!result.ok) {
    const reason = result.failure.reason;
    const bad = unavailable<number>("bytes", path, timestamp, reason);
    return {
      totalBytes: bad, freeBytes: bad, availableBytes: bad, usedBytes: bad, usedPercent: bad,
      buffersBytes: bad, cachedBytes: bad, reclaimableBytes: bad, anonPagesBytes: bad,
      sharedBytes: bad, slabBytes: bad, activeBytes: bad, inactiveBytes: bad,
      dirtyBytes: bad, writebackBytes: bad,
      swapTotalBytes: bad, swapFreeBytes: bad, swapUsedBytes: bad, swapPercent: bad, swapCachedBytes: bad,
    };
  }

  const values = parseMemInfo(result.text);
  const src = path;
  const where = `${path} (${MEMINFO_SOURCE})`;

  const total = field(values, "MemTotal", where, timestamp);
  const free = field(values, "MemFree", where, timestamp);
  const availableRaw = values.get("MemAvailable");

  // MemAvailable is the one field in this module the kernel itself calls an
  // estimate. proc_meminfo(5): "An estimate of how much memory is available
  // for starting new applications, without swapping."
  const available: SystemMetric<number> =
    availableRaw === undefined
      ? unavailable<number>(
          "bytes",
          where,
          timestamp,
          "MemAvailable is absent from /proc/meminfo on this kernel (CONFIG_PSI or a pre-3.14 kernel); used memory cannot be computed as total - available",
        )
      : observedEstimate(
          availableRaw,
          "bytes",
          where,
          timestamp,
          "MemAvailable: the kernel's own estimate of memory available to new applications without swapping. Not a measurement, and not interchangeable with MemFree.",
        );

  let used: SystemMetric<number>;
  let usedPercent: SystemMetric<number>;
  if (total.value === null || available.value === null) {
    used = unavailable<number>("bytes", where, timestamp, "Requires both MemTotal and MemAvailable, and at least one is unavailable");
    usedPercent = unavailable<number>("%", where, timestamp, "Requires used memory, which requires both MemTotal and MemAvailable");
  } else {
    used = derived(
      total.value - available.value,
      "bytes",
      where,
      timestamp,
      "MemTotal - MemAvailable. Deliberately NOT MemTotal - MemFree: the kernel keeps MemFree small by design, so total-free counts the page cache as used.",
    );
    usedPercent = derived(
      ((total.value - available.value) / total.value) * 100,
      "%",
      where,
      timestamp,
      "(MemTotal - MemAvailable) / MemTotal * 100",
    );
  }

  const swapTotal = field(values, "SwapTotal", where, timestamp);
  const swapFree = field(values, "SwapFree", where, timestamp);
  let swapUsed: SystemMetric<number>;
  let swapPercent: SystemMetric<number>;
  if (swapTotal.value === null || swapFree.value === null) {
    swapUsed = unavailable<number>("bytes", where, timestamp, "Requires both SwapTotal and SwapFree");
    swapPercent = unavailable<number>("%", where, timestamp, "Requires swap used, which requires both SwapTotal and SwapFree");
  } else {
    swapUsed = derived(swapTotal.value - swapFree.value, "bytes", where, timestamp, "SwapTotal - SwapFree");
    // A machine with no swap is a real configuration, not missing data. 0% swap
    // used is truthful here; the division is what has to be guarded, because
    // SwapTotal can legitimately be 0.
    swapPercent =
      swapTotal.value === 0
        ? derived(0, "%", where, timestamp, "SwapTotal is 0 on this kernel: this machine has no swap configured, so swap utilisation is genuinely 0% and the percentage is undefined but not misleading")
        : derived(((swapTotal.value - swapFree.value) / swapTotal.value) * 100, "%", where, timestamp, "(SwapTotal - SwapFree) / SwapTotal * 100");
  }

  return {
    totalBytes: total,
    freeBytes: free,
    availableBytes: available,
    usedBytes: used,
    usedPercent,
    buffersBytes: field(values, "Buffers", where, timestamp),
    cachedBytes: field(values, "Cached", where, timestamp),
    reclaimableBytes: field(values, "SReclaimable", where, timestamp),
    anonPagesBytes: field(values, "AnonPages", where, timestamp),
    sharedBytes: field(values, "Shmem", where, timestamp),
    slabBytes: field(values, "Slab", where, timestamp),
    activeBytes: field(values, "Active", where, timestamp),
    inactiveBytes: field(values, "Inactive", where, timestamp),
    dirtyBytes: field(values, "Dirty", where, timestamp),
    writebackBytes: field(values, "Writeback", where, timestamp),
    swapTotalBytes: swapTotal,
    swapFreeBytes: swapFree,
    swapUsedBytes: swapUsed,
    swapPercent,
    swapCachedBytes: field(values, "SwapCached", where, timestamp),
  };
}

/** Total memory in bytes, for the identity block. Reuses the same parse. */
export function readTotalMemoryBytes(paths: KernelPaths): { value: number; source: string } | { reason: string } {
  const path = procPath(paths, "meminfo");
  const result = readTextFile(path);
  if (!result.ok) return { reason: result.failure.reason };
  const values = parseMemInfo(result.text);
  const total = values.get("MemTotal");
  if (total === undefined) return { reason: "MemTotal is absent from /proc/meminfo on this kernel" };
  return { value: total, source: path };
}
