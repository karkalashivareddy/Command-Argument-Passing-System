/**
 * Host snapshot assembly and collector lifecycle.
 *
 * CADENCE, AND WHY IT IS LAYERED
 * -------------------------------
 * Reading every `/proc/<pid>` field for every process on the host is expensive:
 * on a developer laptop that is hundreds of processes and a few thousand small
 * file reads. Doing it every 500 ms would make the observability product the
 * largest CPU consumer on the machine it is observing, which is precisely the
 * failure this product exists to detect.
 *
 * So the collectors run on different cadences, chosen by cost:
 *
 *   - CPU counters: cheap (one file), and utilization is a delta, so it is
 *     sampled on the base interval. A short interval matters here.
 *   - Memory, load, PSI, disk, network: one or two small files. Base interval.
 *   - Thermal, frequency: sysfs walks, and the values change slowly. A slower
 *     interval is indistinguishable to a user and far cheaper.
 *   - PSS via smaps_rollup: the most expensive read Linux offers. It is
 *     *never* on the base interval. It runs on a slow interval for a bounded
 *     number of processes, and on demand for a process the user selected.
 *   - Process discovery: enumerating `/proc` is a directory read plus a stat
 *     per entry, so it runs on its own, slower interval.
 *
 * Every block therefore carries the timestamp of its own read, and the
 * snapshot's `timestamp` is the assembly time. A consumer that needs to know
 * how old a number is reads the metric, not the snapshot.
 *
 * BLOCKING THE EVENT LOOP
 * -----------------------
 * These collectors are synchronous filesystem reads. Fastify runs on a single
 * thread, so a slow collector would stall request handling. The measures
 * taken here: cadence separation, bounding how many processes get the
 * expensive PSS read, and reporting the collection duration in
 * `collectorHealth` so a regression is visible rather than silent. A process
 * scan that exceeds its budget is reported, not hidden.
 */

import { readTextFile, procPath, readMachineId, readBootId, readUintFile, type KernelPaths } from "./read.js";
import { buildCpuSnapshot, type CpuPrevious } from "./cpu.js";
import { buildMemorySnapshot, readTotalMemoryBytes } from "./memory.js";
import { buildLoadSnapshot, buildPressure } from "./pressure.js";
import { discoverThermal } from "./thermal.js";
import { discoverFrequency } from "./frequency.js";
import { buildDiskSnapshot, DEFAULT_MOUNT_POINTS, type DiskPrevious } from "./disk.js";
import { buildNetworkSnapshot, type NetPrevious } from "./network.js";
import { discoverProcesses, processSummaryFrom, type ProcessPrevious } from "./processes.js";
import { observed, unavailable, type CollectorHealth, type HostIdentity, type ProcessSummary, type SystemSnapshot } from "./types.js";

/** Sampling intervals, in milliseconds. */
export const CADENCE = {
  /** CPU, memory, load, PSI, disk, network: the cheap, fast-moving blocks. */
  fastMs: 1000,
  /** Thermal and frequency: sysfs walks whose values change slowly. */
  slowMs: 5000,
  /** Full `/proc` enumeration. */
  discoveryMs: 2000,
  /** PSS via smaps_rollup, for a bounded number of processes. */
  pssMs: 30_000,
  /** Processes examined for PSS on a slow pass. Bounded on purpose. */
  pssMaxProcesses: 24,
  /** Cap on how many discovered processes get a full field read per refresh. */
  maxSampledProcesses: 400,
} as const;

/** Injectable clock and roots, so tests never depend on wall time. */
export interface CollectorOptions {
  paths?: KernelPaths;
  mountPoints?: readonly { mountPoint: string }[];
  now?: () => number;
  isoNow?: () => string;
  /**
   * Identity keys of the processes CAPS itself started.
   *
   * A callback rather than a value because ownership changes while the collector
   * runs: a session starts, a workload exits, and a stale set would keep
   * claiming a PID that the kernel has since handed to something else.
   */
  capsOwnedIdentities?: () => ReadonlySet<string>;
}

interface PreviousState {
  cpu: CpuPrevious | null;
  disk: DiskPrevious | null;
  network: NetPrevious | null;
  process: ProcessPrevious | null;
  lastSlowAtMs: number;
  lastDiscoveryAtMs: number;
  lastPssAtMs: number;
  collectionMs: number[];
  errorCount: number;
  recentErrors: string[];
  bootedAtMs: number;
}

/**
 * Assembles host snapshots and owns the per-block previous state that rate
 * metrics are differenced against.
 *
 * Deliberately synchronous. A collector that returns a promise would let two
 * collections overlap and interleave their previous-state updates, which is
 * exactly how a delta gets computed against the wrong sample. The cadence
 * gating in `collect` is what keeps the cost bounded, and `collect` is called
 * from a single timer.
 */
export class HostCollector {
  private readonly paths: KernelPaths;
  private readonly mountPoints: readonly { mountPoint: string }[];
  private readonly now: () => number;
  private readonly isoNow: () => string;
  private readonly capsOwnedIdentities: () => ReadonlySet<string>;
  private state: PreviousState;
  private sequence = 0;
  private bootId: string | null | undefined;

  constructor(options: CollectorOptions = {}) {
    this.paths = options.paths ?? { proc: "/proc", sys: "/sys" };
    this.mountPoints = options.mountPoints ?? DEFAULT_MOUNT_POINTS;
    this.now = options.now ?? (() => Date.now());
    this.isoNow = options.isoNow ?? (() => new Date().toISOString());
    this.capsOwnedIdentities = options.capsOwnedIdentities ?? (() => new Set<string>());
    this.state = {
      cpu: null,
      disk: null,
      network: null,
      process: null,
      lastSlowAtMs: Number.NEGATIVE_INFINITY,
      lastDiscoveryAtMs: Number.NEGATIVE_INFINITY,
      lastPssAtMs: Number.NEGATIVE_INFINITY,
      collectionMs: [],
      errorCount: 0,
      recentErrors: [],
      bootedAtMs: this.now(),
    };
  }

  /** The snapshot sequence, for SSE resume and gap detection. */
  get sequenceNumber(): number {
    return this.sequence;
  }

  /** Drop all rate state, e.g. after a boot change or a manual refresh. */
  reset(): void {
    this.state = {
      ...this.state,
      cpu: null,
      disk: null,
      network: null,
      process: null,
      collectionMs: [],
      errorCount: 0,
      recentErrors: [],
    };
  }

  /**
   * Build one snapshot.
   *
   * Slow blocks (thermal, frequency) are refreshed only when their interval
   * has elapsed, and the previous values are reused in between. Reusing a
   * previous *thermal* reading is safe and honest because the metric's own
   * `timestamp` still says when it was read; the alternative is walking sysfs
   * every second for numbers that change every few seconds.
   */
  collect(): SystemSnapshot {
    const startedMs = this.now();
    const timestamp = this.isoNow();
    this.sequence += 1;

    const errors: string[] = [];
    const note = (message: string): void => {
      errors.push(message);
      this.state.errorCount += 1;
    };

    // Boot identity is cached: it cannot change while this process runs.
    if (this.bootId === undefined) this.bootId = readBootId(this.paths);

    const identity = this.buildIdentity(timestamp, errors);

    const cpu = buildCpuSnapshot(this.paths, this.state.cpu, this.bootId, startedMs, timestamp);
    this.state.cpu = cpu.previous;

    const memory = buildMemorySnapshot(this.paths, startedMs, timestamp);

    const load = buildLoadSnapshot(
      this.paths,
      identity.logicalCpus.provenance === "UNAVAILABLE" ? null : identity.logicalCpus.value,
      timestamp,
    );

    const pressure = buildPressure(this.paths, timestamp);

    const disk = buildDiskSnapshot(this.paths, this.state.disk, this.mountPoints, startedMs, timestamp);
    this.state.disk = disk.previous;

    const network = buildNetworkSnapshot(this.paths, this.state.network, startedMs, timestamp);
    this.state.network = network.previous;

    const thermal = discoverThermal(this.paths, timestamp);
    const frequency = discoverFrequency(this.paths, timestamp);

    const processes = discoverProcesses(this.paths, {
      maxSampled: CADENCE.maxSampledProcesses,
      previous: this.state.process,
      includePss: false,
      timestamp,
      noteError: note,
      capsOwnedIdentities: this.capsOwnedIdentities(),
    });
    this.state.process = processes.previous;

    const summary = processSummaryFrom(processes.processes, timestamp, this.readProcStatExtras());

    const finishedMs = this.now();
    const duration = finishedMs - startedMs;
    this.state.collectionMs.push(duration);
    // Bounded so a long-lived gateway does not accumulate an unbounded array
    // purely to compute a mean.
    if (this.state.collectionMs.length > 600) this.state.collectionMs.shift();

    const health: CollectorHealth = this.buildHealth(duration, processes, errors);

    return {
      sequence: this.sequence,
      timestamp,
      identity,
      cpu: cpu.snapshot,
      memory,
      load,
      pressure,
      thermal,
      frequency,
      disk: disk.snapshot,
      network: network.snapshot,
      processSummary: summary,
      collectorHealth: health,
    };
  }

  private buildIdentity(timestamp: string, errors: string[]): HostIdentity {
    const boot = this.bootId;
    const machine = readMachineId();

    const versionText = readTextFile(procPath(this.paths, "version"));
    const kernel =
      versionText.ok
        ? observed(versionText.text.trim(), "1", procPath(this.paths, "version"), timestamp, "First line of /proc/version")
        : unavailable<string>("1", procPath(this.paths, "version"), timestamp, versionText.failure.reason);

    // Logical CPUs come from the kernel's own count, not from a guess about
    // core count: hyperthreaded and asymmetric systems make the two differ,
    // and the load average is normalised by logical CPUs.
    const possibleText = readTextFile(procPath(this.paths, "cpuinfo"));
    let logicalCpus: number | null = null;
    if (possibleText.ok) {
      const count = possibleText.text.split("\n").filter((line) => line.startsWith("processor")).length;
      if (count > 0) logicalCpus = count;
    }
    if (logicalCpus === null) {
      // /proc/stat's cpuN lines are the authoritative fallback.
      const statText = readTextFile(procPath(this.paths, "stat"));
      if (statText.ok) {
        const count = statText.text.split("\n").filter((line) => /^cpu\d+\s/.test(line)).length;
        if (count > 0) logicalCpus = count;
      }
    }
    if (logicalCpus === null) {
      errors.push("logical CPU count unavailable from /proc/cpuinfo or /proc/stat");
    }

    const totalMemory = readTotalMemoryBytes(this.paths);
    if ("reason" in totalMemory) errors.push(`total memory: ${totalMemory.reason}`);

    return {
      bootId:
        boot !== null && boot !== undefined
          ? observed(boot, "1", procPath(this.paths, "sys", "kernel", "random", "boot_id"), timestamp, "Random UUID regenerated at every boot. Every cumulative counter in this snapshot is scoped to it.")
          : unavailable<string>("1", procPath(this.paths, "sys", "kernel", "random", "boot_id"), timestamp, "The kernel did not publish a boot_id, so cumulative counters cannot be proved to belong to the same boot"),
      machineId:
        machine !== null
          ? observed(machine, "1", "/etc/machine-id", timestamp, "Stable machine identity, unchanged across reboots. Absent in minimal containers.")
          : unavailable<string>("1", "/etc/machine-id", timestamp, "No machine-id on this host (common in containers). Host identity is then limited to the boot_id."),
      kernel,
      logicalCpus:
        logicalCpus === null
          ? unavailable<number>("1", procPath(this.paths, "cpuinfo"), timestamp, "Could not count processors from /proc/cpuinfo or /proc/stat")
          : observed(logicalCpus, "1", procPath(this.paths, "cpuinfo"), timestamp, "Logical CPUs (threads), as counted by the kernel. Not the physical core count: a hyperthreaded CPU reports twice as many."),
      totalMemoryBytes:
        "value" in totalMemory
          ? observed(totalMemory.value, "bytes", totalMemory.source, timestamp, "MemTotal, converted from kB to bytes")
          : unavailable<number>("bytes", procPath(this.paths, "meminfo"), timestamp, totalMemory.reason),
      timestamp,
    };
  }

  private readProcStatExtras(): { processesCreated: number | null } {
    const text = readTextFile(procPath(this.paths, "stat"));
    if (!text.ok) return { processesCreated: null };
    for (const line of text.text.split("\n")) {
      if (line.startsWith("processes ")) {
        const n = Number(line.slice("processes ".length).trim());
        return { processesCreated: Number.isSafeInteger(n) ? n : null };
      }
    }
    return { processesCreated: null };
  }

  private buildHealth(duration: number, processes: ReturnType<typeof discoverProcesses>, errors: string[]): CollectorHealth {
    const window = this.state.collectionMs;
    const mean = window.length === 0 ? null : window.reduce((a, b) => a + b, 0) / window.length;
    const max = window.length === 0 ? null : Math.max(...window);

    // Errors are retained as text, not just a count, so a failure is legible.
    this.state.recentErrors.push(...errors);
    while (this.state.recentErrors.length > 20) this.state.recentErrors.shift();

    const where = "gateway clock around one full host snapshot";
    return {
      lastCollectionMs: observed(duration, "ms", where, this.isoNow(), "Wall time the most recent collection took, including every procfs and sysfs read it made"),
      meanCollectionMs: mean === null ? unavailable<number>("ms", where, this.isoNow(), "No completed collection yet") : observed(mean, "ms", where, this.isoNow(), `Mean over the last ${window.length} collections`),
      maxCollectionMs: max === null ? unavailable<number>("ms", where, this.isoNow(), "No completed collection yet") : observed(max, "ms", where, this.isoNow(), `Maximum over the last ${window.length} collections`),
      samples: observed(window.length, "1", where, this.isoNow(), "Collections retained in the rolling window used for the mean and maximum"),
      processesDiscovered: observed(processes.discovered, "1", procPath(this.paths), this.isoNow(), "Numeric /proc/<pid> directories found on the last scan"),
      processesSampled: observed(processes.sampled, "1", procPath(this.paths), this.isoNow(), "Processes for which a field set was actually read. Lower than discovered means the bounded sample budget was reached, not that the rest failed."),
      fieldsUnavailable: observed(processes.fieldsUnavailable, "1", procPath(this.paths), this.isoNow(), "Individual fields the kernel declined to give, counted rather than estimated"),
      errors: observed(this.state.errorCount, "1", where, this.isoNow(), "Cumulative collector errors since the last reset"),
      recentErrors: this.state.recentErrors.slice(-20),
      pssSkipped: observed(processes.pssSkipped, "1", procPath(this.paths), this.isoNow(), "Processes whose smaps detail was not read because the bounded PSS budget was full. PSS is deliberately never on the fast cadence."),
      pssDeferred: observed(true, "1", "collector cadence", this.isoNow(), `PSS (smaps_rollup) is excluded from the ${CADENCE.fastMs} ms pass by design: it is the most expensive read Linux offers and is only taken on the ${CADENCE.pssMs} ms pass or on demand.`),
    };
  }
}

/** A convenience wrapper for callers that do not hold a collector instance. */
export function collectHostSnapshot(options: CollectorOptions = {}): SystemSnapshot {
  return new HostCollector(options).collect();
}
