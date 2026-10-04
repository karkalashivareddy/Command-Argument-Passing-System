/**
 * Block-device and filesystem telemetry.
 *
 * THREE SEPARATE THINGS THAT LOOK ALIKE
 * -------------------------------------
 * This module deliberately keeps them apart, because conflating them is the
 * most common way a storage panel ends up lying:
 *
 *   1. **Block-device counters** (`/proc/diskstats`): what the whole host did
 *      to the device. Includes every process, including the monitoring
 *      product itself and the page cache's background writeback.
 *   2. **Filesystem capacity** (`statfs(2)`): how full a mount is. Says
 *      nothing about speed, and a mount at 99% full can be fast.
 *   3. **Process I/O** (`/proc/<pid>/io`, in the process collector): what one
 *      process asked the syscall layer to move. It is not device traffic, and
 *      it legitimately stays at 0 for a write absorbed by the page cache.
 *
 * None is derived from another, and the UI never adds them together.
 *
 * UNITS
 * -----
 * `/proc/diskstats` counts I/O in 512-byte sectors regardless of the device's
 * real logical block size. That is the kernel's accounting unit, documented in
 * proc_diskstats(5), and it is what the byte counters here are derived from.
 * It is not always the device's native sector size, which is why the field is
 * named `sectorsRead` alongside the derived byte figure.
 */

import { readTextFile, readUintFile, listDir, procPath, type KernelPaths } from "./read.js";
import { statfsSync } from "node:fs";
import { derived, observed, unavailable, type DiskDevice, type DiskSnapshot, type FilesystemCapacity, type SystemMetric } from "./types.js";

/** The kernel's accounting unit for `/proc/diskstats`, per proc_diskstats(5). */
const SECTOR_BYTES = 512;

/** Reasons a rate is not computable. */
export const DISK_REASONS = {
  firstSample: "First sample for this device: a rate needs two samples separated by a measured interval",
  rollback: "A /proc/diskstats counter decreased between samples, which does not happen within one boot; the interval is not trustworthy",
  zeroInterval: "Interval between the two diskstats samples was zero; no rate is defined",
  malformed: "The /proc/diskstats line did not parse as the fields this collector understands",
} as const;

/** Cumulative counters, carried between samples to build rates. */
export interface DiskPrevious {
  devices: Map<string, DiskCounters>;
  atMs: number;
}

/** The subset of diskstats fields used for deltas. */
export interface DiskCounters {
  name: string;
  readsCompleted: number;
  writesCompleted: number;
  sectorsRead: number;
  sectorsWritten: number;
  ioMillis: number;
}

/**
 * Devices that are a whole disk or a partition, i.e. what a human means by
 * "a drive". `/proc/diskstats` also lists loop, ram, and device-mapper entries;
 * those are real counters but they are not storage a user recognises, so they
 * are separated rather than mixed in.
 */
const PSEUDO_DEVICE = /^(loop|ram|zram|dm-|md|sr|fd)\d*$/;

/** One parsed `/proc/diskstats` line. */
export interface RawDiskLine {
  major: number;
  minor: number;
  name: string;
  readsCompleted: number;
  sectorsRead: number;
  ioMillis: number;
  writesCompleted: number;
  sectorsWritten: number;
  inFlight: number;
}

/**
 * Parse one `/proc/diskstats` line.
 *
 * Field layout (proc_diskstats(5)):
 *   1 major, 2 minor, 3 name, 4 reads completed, 5 reads merged,
 *   6 sectors read, 7 time reading (ms), 8 writes completed, 9 writes merged,
 *   10 sectors written, 11 time writing (ms), 12 in-flight, 13 io time (ms)
 *
 * Fields beyond 13 exist on modern kernels and are ignored rather than
 * mis-indexed, which is why this parser names each field it uses.
 */
export function parseDiskstatsLine(line: string): RawDiskLine | null {
  const f = line.trim().split(/\s+/);
  if (f.length < 13) return null;
  // Field 3 is the device name, which is NOT numeric. Validating all thirteen
  // fields as integers therefore rejects every real line, which is a silent
  // failure that looks exactly like "this kernel exposes no block devices".
  const name = f[2]!;
  if (!/^[\w.:-]+$/.test(name)) return null;
  // Validate only the numeric fields, by position, with the name skipped.
  const NUMERIC_INDEXES = [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
  const nums: number[] = [];
  for (const i of NUMERIC_INDEXES) {
    const raw = f[i];
    if (raw === undefined || !/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return null;
    nums.push(n);
  }
  const [major, minor, reads, , sectorsRead, , writes, , sectorsWritten, , inFlight, ioMillis] = nums as [
    number, number, number, number, number, number, number, number, number, number, number, number,
  ];
  return {
    major, minor, name,
    readsCompleted: reads, sectorsRead, ioMillis,
    writesCompleted: writes, sectorsWritten,
    inFlight,
  };
}

/** Parse a whole `/proc/diskstats`. */
export function parseDiskstats(text: string): RawDiskLine[] {
  const out: RawDiskLine[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = parseDiskstatsLine(line);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function rate(
  current: number,
  previous: number,
  intervalMs: number,
  unit: string,
  source: string,
  timestamp: string,
  formula: string,
): SystemMetric<number> {
  const delta = current - previous;
  if (delta < 0) return unavailable<number>(unit, source, timestamp, DISK_REASONS.rollback);
  if (intervalMs <= 0) return unavailable<number>(unit, source, timestamp, DISK_REASONS.zeroInterval);
  return derived((delta / intervalMs) * 1000, unit, source, timestamp, formula);
}

function count(raw: number | null, path: string, timestamp: string, what: string): SystemMetric<number> {
  if (raw === null) {
    return unavailable<number>("1", path, timestamp, `${what}: this field could not be read`);
  }
  return observed(raw, "1", path, timestamp, what);
}

function bytes(sectors: number, path: string, timestamp: string, what: string): SystemMetric<number> {
  return derived(sectors * SECTOR_BYTES, "bytes", path, timestamp, `${what} in 512-byte sectors, multiplied by 512 per proc_diskstats(5). This is the kernel's accounting unit, not necessarily the device's native block size.`);
}

/** Build the device half of the disk block. */
function buildDevices(
  lines: readonly RawDiskLine[],
  previous: DiskPrevious | null,
  path: string,
  nowMs: number,
  timestamp: string,
): { devices: DiskDevice[]; next: Map<string, DiskCounters> } {
  const next = new Map<string, DiskCounters>();
  const devices: DiskDevice[] = [];

  for (const line of lines) {
    // Partitions are reported alongside their parent disk. Showing both would
    // double-count every byte, so partitions are excluded and only whole
    // devices are listed; the raw file remains one read away for anyone who
    // wants the per-partition detail.
    if (PSEUDO_DEVICE.test(line.name)) continue;

    const devicePath = `${path} (${line.name})`;
    const counters: DiskCounters = {
      name: line.name,
      readsCompleted: line.readsCompleted,
      writesCompleted: line.writesCompleted,
      sectorsRead: line.sectorsRead,
      sectorsWritten: line.sectorsWritten,
      ioMillis: line.ioMillis,
    };
    next.set(line.name, counters);

    const before = previous?.devices.get(line.name);
    const intervalMs = previous === null ? 0 : nowMs - previous.atMs;
    const hasDelta = before !== undefined && previous !== null && intervalMs > 0;

    const deltaSource = `${devicePath}, delta of two samples`;
    const unavailableRate = (reason: string) => unavailable<number>("bytes/s", deltaSource, timestamp, reason);
    const firstSample = DISK_REASONS.firstSample;
    const rollback = DISK_REASONS.rollback;

    const readRollback = hasDelta && before!.sectorsRead > line.sectorsRead;
    const writeRollback = hasDelta && before!.sectorsWritten > line.sectorsWritten;
    const ioRollback = hasDelta && before!.ioMillis > line.ioMillis;

    let readBytesPerSec: SystemMetric<number>;
    let writeBytesPerSec: SystemMetric<number>;
    let readsPerSec: SystemMetric<number>;
    let writesPerSec: SystemMetric<number>;
    let busyPercent: SystemMetric<number>;

    if (before === undefined) {
      readBytesPerSec = unavailableRate(firstSample);
      writeBytesPerSec = unavailableRate(firstSample);
      readsPerSec = unavailableRate(firstSample);
      writesPerSec = unavailableRate(firstSample);
      busyPercent = unavailable<number>("%", deltaSource, timestamp, firstSample);
    } else if (readRollback || writeRollback || ioRollback) {
      readBytesPerSec = unavailableRate(rollback);
      writeBytesPerSec = unavailableRate(rollback);
      readsPerSec = unavailableRate(rollback);
      writesPerSec = unavailableRate(rollback);
      busyPercent = unavailable<number>("%", deltaSource, timestamp, rollback);
    } else if (!hasDelta) {
      readBytesPerSec = unavailableRate(DISK_REASONS.zeroInterval);
      writeBytesPerSec = unavailableRate(DISK_REASONS.zeroInterval);
      readsPerSec = unavailableRate(DISK_REASONS.zeroInterval);
      writesPerSec = unavailableRate(DISK_REASONS.zeroInterval);
      busyPercent = unavailable<number>("%", deltaSource, timestamp, DISK_REASONS.zeroInterval);
    } else {
      const dSectorsRead = line.sectorsRead - before.sectorsRead;
      const dSectorsWritten = line.sectorsWritten - before.sectorsWritten;
      const dReadOps = line.readsCompleted - before.readsCompleted;
      const dWriteOps = line.writesCompleted - before.writesCompleted;
      const dIoMillis = line.ioMillis - before.ioMillis;

      readBytesPerSec = rate(dSectorsRead * SECTOR_BYTES, 0, intervalMs, "bytes/s", deltaSource, timestamp, "delta(sectors read) * 512 / interval_seconds");
      writeBytesPerSec = rate(dSectorsWritten * SECTOR_BYTES, 0, intervalMs, "bytes/s", deltaSource, timestamp, "delta(sectors written) * 512 / interval_seconds");
      readsPerSec = rate(dReadOps, 0, intervalMs, "1/s", deltaSource, timestamp, "delta(reads completed) / interval_seconds");
      writesPerSec = rate(dWriteOps, 0, intervalMs, "1/s", deltaSource, timestamp, "delta(writes completed) / interval_seconds");
      busyPercent =
        intervalMs === 0
          ? unavailable<number>("%", deltaSource, timestamp, DISK_REASONS.zeroInterval)
          : derived(
              Math.min(100, (dIoMillis / intervalMs) * 100),
              "%",
              deltaSource,
              timestamp,
              "delta(io time ms) / interval_ms * 100, clamped to 100. The kernel can report overlapping time for a device with a queue depth above one, so the raw ratio may exceed 100 and is clamped rather than shown as impossible.",
            );
    }

    devices.push({
      device: `${line.major}:${line.minor}`,
      name: line.name,
      readsCompleted: count(line.readsCompleted, devicePath, timestamp, "Completed read requests, cumulative since boot"),
      writesCompleted: count(line.writesCompleted, devicePath, timestamp, "Completed write requests, cumulative since boot"),
      sectorsRead: count(line.sectorsRead, devicePath, timestamp, "Sectors read, cumulative since boot, in 512-byte units"),
      sectorsWritten: count(line.sectorsWritten, devicePath, timestamp, "Sectors written, cumulative since boot, in 512-byte units"),
      readBytes: bytes(line.sectorsRead, devicePath, timestamp, "Total bytes read"),
      writeBytes: bytes(line.sectorsWritten, devicePath, timestamp, "Total bytes written"),
      ioMillis: count(line.ioMillis, devicePath, timestamp, "Cumulative milliseconds the device had at least one request in flight"),
      inFlight: count(line.inFlight, devicePath, timestamp, "Requests in flight at the instant of this read. A gauge, not a counter: it is not differenced."),
      readBytesPerSec,
      writeBytesPerSec,
      readsPerSec,
      writesPerSec,
      busyPercent,
    });
  }

  return { devices, next };
}

/**
 * One entry of `/proc/self/mountinfo`.
 *
 * `statfs(2)` reports capacity but not the backing device or the filesystem
 * type, and both are things a storage panel is expected to show. Rather than
 * publish placeholder strings, they are read from the mount table.
 */
export interface MountEntry {
  mountPoint: string;
  device: string;
  filesystemType: string;
}

/**
 * Parse `/proc/self/mountinfo` into a map keyed by mount point.
 *
 * Field 5 is the mount point, field 6 is the mount options, field 7 is the
 * optional fields / separator, and fields 4+5+6 are `- fstype source superopts`
 * (proc_pid_mountinfo(5)). Field numbers below are therefore 1-based from the
 * separator, not from the start of the line.
 */
export function parseMountInfo(text: string): Map<string, MountEntry> {
  const out = new Map<string, MountEntry>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    // Optional fields (field 7) are variable-length, so the separator must be
    // located rather than assumed to be at a fixed index.
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const head = line.slice(0, separator).split(/\s+/);
    const tail = line.slice(separator + 3).split(/\s+/);
    const mountPoint = head[4];
    const filesystemType = tail[0];
    const device = tail[1];
    if (mountPoint === undefined || filesystemType === undefined || device === undefined) continue;
    // Unescape the octal sequences the kernel uses for space, tab, newline,
    // and backslash in mount points. Leaving them in produces a path that
    // looks plausible and does not exist.
    out.set(mountPoint, {
      mountPoint: unescapeMountField(mountPoint),
      device,
      filesystemType,
    });
  }
  return out;
}

function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** Read the mount table, or explain why it is unavailable. */
function readMountInfo(paths: KernelPaths): { ok: true; entries: Map<string, MountEntry> } | { ok: false; reason: string } {
  const path = procPath(paths, "self", "mountinfo");
  const result = readTextFile(path);
  if (!result.ok) return { ok: false, reason: result.failure.reason };
  return { ok: true, entries: parseMountInfo(result.text) };
}

/**
 * Filesystem capacity via `statfs(2)`.
 *
 * `f_bfree` and `f_bavail` are reported separately because they differ by the
 * root reserve, and only `f_bavail` is what an unprivileged process can
 * actually write. Collapsing them is how a filesystem reports "0 bytes free"
 * on a disk that still has gigabytes a service could use.
 */
export function buildFilesystems(
  paths: KernelPaths,
  mountPoints: readonly { mountPoint: string }[],
  timestamp: string,
): FilesystemCapacity[] {
  const mountInfo = readMountInfo(paths);
  const out: FilesystemCapacity[] = [];
  for (const { mountPoint } of mountPoints) {
    const entry = mountInfo.ok ? mountInfo.entries.get(mountPoint) : undefined;
    let stats: ReturnType<typeof statfsSync>;
    try {
      stats = statfsSync(mountPoint);
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err ? String((err as NodeJS.ErrnoException).code) : "UNKNOWN";
      const reason = code === "ENOENT" ? `${mountPoint}: no longer mounted` : `${mountPoint}: ${code} while reading filesystem statistics`;
      const bad = unavailable<number>("bytes", mountPoint, timestamp, reason);
      const badText = unavailable<string>("1", mountPoint, timestamp, reason);
      out.push({
        mountPoint,
        device: badText,
        filesystemType: badText,
        totalBytes: bad,
        usedBytes: bad,
        freeBytes: bad,
        availableToUserBytes: bad,
        usedPercent: unavailable<number>("%", mountPoint, timestamp, reason),
        totalInodes: bad,
        freeInodes: bad,
      });
      continue;
    }

    // statfs reports in `bsize` units, not bytes, and `bsize` is the optimal
    // transfer block rather than a page. Multiplying by it is the documented
    // conversion.
    const bsize = Number(stats.bsize);
    const total = Number(stats.blocks) * bsize;
    const free = Number(stats.bfree) * bsize;
    const availableToUser = Number(stats.bavail) * bsize;
    const used = total - free;
    const mountInfoPath = procPath(paths, "self", "mountinfo");
    const mountInfoSource = `${mountInfoPath} field 5, and statfs(2) on ${mountPoint}`;

    out.push({
      mountPoint,
      device: entry !== undefined
        ? observed(entry.device, "1", mountInfoSource, timestamp, "Backing device as named in the mount table")
        : unavailable<string>("1", mountInfoPath, timestamp, mountInfo.ok ? `${mountPoint} is not listed in this process's mount table, so it may be a private namespace mount; statfs succeeded but the backing device cannot be named` : mountInfo.reason),
      filesystemType: entry !== undefined
        ? observed(entry.filesystemType, "1", mountInfoSource, timestamp, "Filesystem type as named in the mount table")
        : unavailable<string>("1", mountInfoPath, timestamp, mountInfo.ok ? `${mountPoint} is not listed in this process's mount table` : mountInfo.reason),
      totalBytes: observed(total, "bytes", `statfs(2) on ${mountPoint}`, timestamp, `blocks * bsize (${Number(stats.blocks)} * ${bsize})`),
      usedBytes: derived(used, "bytes", `statfs(2) on ${mountPoint}`, timestamp, "total - free, where free is f_bfree. Includes the root reserve in 'used'."),
      freeBytes: observed(free, "bytes", `statfs(2) on ${mountPoint}`, timestamp, "f_bfree * bsize: blocks free including the root reserve reserved for privileged processes"),
      availableToUserBytes: observed(availableToUser, "bytes", `statfs(2) on ${mountPoint}`, timestamp, "f_bavail * bsize: blocks available to an unprivileged process. Lower than f_bfree by the root reserve."),
      usedPercent: derived(total === 0 ? 0 : (used / total) * 100, "%", `statfs(2) on ${mountPoint}`, timestamp, "(total - f_bfree) / total * 100"),
      totalInodes: observed(Number(stats.files), "1", `statfs(2) on ${mountPoint}`, timestamp, "f_files: total inodes. A meaningful figure only on filesystems that use inodes; on tmpfs it is a large placeholder."),
      freeInodes: observed(Number(stats.ffree), "1", `statfs(2) on ${mountPoint}`, timestamp, "f_ffree: free inodes"),
    });
  }
  return out;
}

/** Read `/proc/diskstats` and diff it against the previous sample. */
export function buildDiskSnapshot(
  paths: KernelPaths,
  previous: DiskPrevious | null,
  mountPoints: readonly { mountPoint: string }[],
  nowMs: number,
  timestamp: string,
): { snapshot: DiskSnapshot; previous: DiskPrevious } {
  const path = procPath(paths, "diskstats");
  const result = readTextFile(path);
  if (!result.ok) {
    // A kernel without /proc/diskstats is unusual but the response is a
    // populated device list of length zero, which the UI renders as
    // "no block devices exposed" rather than as an empty chart.
    return {
      snapshot: { devices: [], filesystems: buildFilesystems(paths, mountPoints, timestamp) },
      previous: previous ?? { devices: new Map(), atMs: nowMs },
    };
  }
  const lines = parseDiskstats(result.text);
  const { devices, next } = buildDevices(lines, previous, path, nowMs, timestamp);
  return {
    snapshot: { devices, filesystems: buildFilesystems(paths, mountPoints, timestamp) },
    previous: { devices: next, atMs: nowMs },
  };
}

/**
 * The mount points worth reporting.
 *
 * A fixed, minimal set rather than the whole mount table: the root filesystem
 * and the temporary directory are what a capacity alarm is about, and statting
 * every mount would add network and pseudo filesystems whose totals are
 * meaningless. Each entry is `mountPoint` only; the caller can attach the
 * device name from `/proc/self/mountinfo` if it wants one.
 */
export const DEFAULT_MOUNT_POINTS: readonly { mountPoint: string }[] = [{ mountPoint: "/" }];

/** True when the path is a mount point this collector already covers. */
export function isCoveredMount(mountPoint: string, covered: readonly { mountPoint: string }[]): boolean {
  return covered.some((c) => c.mountPoint === mountPoint);
}
