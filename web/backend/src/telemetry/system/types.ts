/**
 * Host telemetry contract.
 *
 * SCOPE AND WHY IT IS SEPARATE FROM `../types.js`
 * ----------------------------------------------
 * The process microscope already has a `Metric<T>` carrying
 * value/provenance/source/reason. That shape is correct for a *process*
 * sample, where one gateway wall clock stamps the whole payload. Host metrics
 * have two requirements the process shape does not satisfy:
 *
 *   1. Every metric carries its own **unit**. A system collector mixes
 *      bytes, percent, millidegrees, hertz, and dimensionless ratios in one
 *      snapshot. A consumer that has to remember which is which will eventually
 *      render a byte count as a percentage.
 *   2. Every metric carries its own **timestamp**. Host counters are sampled
 *      in layers on different cadences (see `cadence.ts`), so the honest
 *      statement is "this value was read at T", not "the snapshot is from T".
 *
 * The provenance vocabulary is deliberately *not* extended with a fourth class.
 * Instead `SystemMetric.estimate` marks a value that the kernel itself
 * describes as an approximation. `MemAvailable` is the canonical case: the
 * kernel computes it and `proc_meminfo(5)` calls it an estimate. Reporting it
 * as `OBSERVED` with `estimate: true` is truthful and displayable as
 * "OBSERVED - kernel estimate". Inventing a "KERNEL_ESTIMATE" provenance class
 * would force every existing consumer to learn a fourth state for one metric.
 *
 * THE ONE INVARIANT THAT MATTERS
 * ------------------------------
 * `UNAVAILABLE` means `value === null`. A collector that does not have a real
 * reading MUST NOT produce `0`, because `0` is a claim: "the kernel reported
 * zero, or this really is zero." On a machine with no thermal sensor, zero
 * degrees is a fabrication and 0% CPU is a lie. `unavailable()` is the only
 * sanctioned way to express absence, and every collector in this directory
 * routes through it.
 */

export type Provenance = "OBSERVED" | "DERIVED" | "UNAVAILABLE";

/** Every host metric, without exception. */
export interface SystemMetric<T> {
  /**
   * The reading, or `null` when `provenance === "UNAVAILABLE"`.
   * `null` is never interchangeable with `0`.
   */
  value: T | null;
  /** Display unit. `"1"` for a dimensionless ratio, `"%"` for a percentage. */
  unit: string;
  /** Where the value came from, precisely enough to be re-read by hand. */
  source: string;
  /** When this value was read, not when the enclosing snapshot was built. */
  timestamp: string;
  provenance: Provenance;
  /**
   * Present and `true` when the kernel documents the value as an
   * approximation rather than a direct reading. The UI renders these with a
   * "kernel estimate" marker so a modelled figure is never presented as exact.
   */
  estimate?: boolean;
  /** Why the value is missing, or what a derived value was derived from. */
  reason?: string;
}

/** Build an OBSERVED metric. `estimate` must be justified by the caller. */
export function observed<T>(
  value: T,
  unit: string,
  source: string,
  timestamp: string,
  reason?: string,
): SystemMetric<T> {
  return { value, unit, source, timestamp, provenance: "OBSERVED", ...(reason ? { reason } : {}) };
}

/**
 * Build a DERIVED metric.
 *
 * `reason` is mandatory here, not optional: a derived number is only
 * defensible if the formula and the inputs are recorded with it. "DERIVED"
 * without a stated derivation is indistinguishable from a guess.
 */
export function derived<T>(
  value: T,
  unit: string,
  source: string,
  timestamp: string,
  reason: string,
): SystemMetric<T> {
  return { value, unit, source, timestamp, provenance: "DERIVED", reason };
}

/**
 * Build an UNAVAILABLE metric.
 *
 * `reason` is mandatory. "UNAVAILABLE" without a reason is indistinguishable
 * from a collector that silently gave up, and the UI has nothing to show the
 * user.
 */
export function unavailable<T>(unit: string, source: string, timestamp: string, reason: string): SystemMetric<T> {
  return { value: null, unit, source, timestamp, provenance: "UNAVAILABLE", reason };
}

/** OBSERVED, but the kernel documents it as an estimate. */
export function observedEstimate<T>(
  value: T,
  unit: string,
  source: string,
  timestamp: string,
  reason: string,
): SystemMetric<T> {
  return { value, unit, source, timestamp, provenance: "OBSERVED", estimate: true, reason };
}

/** Read the value, or `null` when the metric is unavailable. Never coerces to 0. */
export function valueOf<T>(metric: SystemMetric<T> | null | undefined): T | null {
  return metric && metric.provenance !== "UNAVAILABLE" ? metric.value : null;
}

/**
 * True only when a real reading exists.
 *
 * Views must branch on this rather than on `value !== null`, because a
 * malformed collector could otherwise pair a `null` with `DERIVED`.
 */
export function hasValue<T>(metric: SystemMetric<T> | null | undefined): boolean {
  return metric != null && metric.provenance !== "UNAVAILABLE" && metric.value !== null;
}

/** Short provenance label for a badge: `OBSERVED`, `DERIVED`, or `UNAVAILABLE`. */
export function provenanceLabel<T>(metric: SystemMetric<T> | null | undefined): string {
  if (metric == null) return "UNAVAILABLE";
  return metric.estimate === true ? `${metric.provenance} - kernel estimate` : metric.provenance;
}

// ---------------------------------------------------------------------------
// Host identity
// ---------------------------------------------------------------------------

/**
 * Identity of the running kernel boot and the machine.
 *
 * Every host counter is scoped to a boot: `/proc/stat` totals reset on reboot,
 * `startTicks` only means something relative to one boot, and a counter that
 * appears to go backwards is usually a reboot rather than a fault. The
 * collector therefore records `bootId` on every sample and refuses to compute a
 * rate across a boot change.
 */
export interface HostIdentity {
  /** `/proc/sys/kernel/random/boot_id`, or UNAVAILABLE with a reason. */
  bootId: SystemMetric<string>;
  /** `/etc/machine-id` when readable: stable across boots on the same host. */
  machineId: SystemMetric<string>;
  /** `uname -sr`-equivalent from `/proc/version`. */
  kernel: SystemMetric<string>;
  /** Logical CPU count the kernel reports, not the number of cores. */
  logicalCpus: SystemMetric<number>;
  /** Total RAM in bytes, as the kernel reports it. */
  totalMemoryBytes: SystemMetric<number>;
  /** Wall clock of the collection, ISO 8601. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

/**
 * Cumulative CPU time in USER_HZ units, exactly as `/proc/stat` publishes it.
 *
 * These are monotonic within a boot. They are the only trustworthy basis for a
 * utilization figure: a single sample of a cumulative counter cannot produce a
 * rate, which is why `CpuTimes` is an intermediate structure and never an
 * API response field on its own.
 */
export interface CpuTimes {
  /** Field 1: time spent in user mode. */
  user: number;
  /** Field 2: time spent in user mode at low priority (nice). */
  nice: number;
  /** Field 3: time spent in system mode. */
  system: number;
  /** Field 4: time spent idle. */
  idle: number;
  /** Field 5: time spent waiting for block I/O. Counted as idle by the kernel. */
  iowait: number;
  /** Field 6: time spent servicing interrupts. */
  irq: number;
  /** Field 7: time spent servicing softirqs. */
  softirq: number;
  /** Field 8: time stolen by the hypervisor. */
  steal: number;
  /** Field 9: time spent in guest mode (already included in `user`). */
  guest: number;
  /** Field 10: time spent in guest mode at low priority (in `nice`). */
  guestNice: number;
}

/**
 * The subset of `CpuTimes` the API reports.
 *
 * The kernel double-counts guests: `guest` is *already* included in `user` and
 * `guest_nice` in `nice` (see proc_stat(5)). Summing every field would
 * therefore overstate total time. `CpuTimes.sum()` follows the kernel's own
 * definition and is the single place that decision is made.
 */
export type CpuTimeKey = "user" | "nice" | "system" | "idle" | "iowait" | "irq" | "softirq" | "steal";

/** One logical CPU, identified by the kernel's own index. */
export interface CpuCore {
  /** The `cpuN` index from `/proc/stat`, e.g. 0 for `cpu0`. */
  index: number;
  /** Cumulative counters for this core alone. */
  times: CpuTimes;
}

/** One `/proc/stat` parse: the aggregate line plus every enumerated core. */
export interface ProcStatSample {
  /** The `cpu` line. Always present on Linux. */
  total: CpuTimes;
  /**
   * Per-core lines, in the order the kernel lists them.
   *
   * An empty array is meaningful: it means the kernel exposed no `cpuN` lines,
   * which is different from "all cores were busy".
   */
  cores: CpuCore[];
}

/** Occupancy of the CPU set over one measured interval. */
export interface CpuUtilization {
  /** Busy = 100 - idle, where iowait is *not* counted as idle. See cpu.ts. */
  busyPercent: SystemMetric<number>;
  /** Idle share, excluding iowait. */
  idlePercent: SystemMetric<number>;
  /** iowait share. Reported separately because it is a distinct bottleneck. */
  iowaitPercent: SystemMetric<number>;
  userPercent: SystemMetric<number>;
  nicePercent: SystemMetric<number>;
  systemPercent: SystemMetric<number>;
  /** irq + softirq share. */
  irqPercent: SystemMetric<number>;
  /** Hypervisor steal. Non-zero means the hypervisor took the CPU away. */
  stealPercent: SystemMetric<number>;
  /**
   * Busy + iowait. Provided because "how much of the machine is not doing
   * useful work" is a different question from "how much is idle", and a
   * storage-bound host reads as idle under `busyPercent` alone.
   */
  busyPlusIowaitPercent: SystemMetric<number>;
  /** Wall-clock length of the interval these percentages were computed over. */
  intervalMs: SystemMetric<number>;
}

/** The CPU block of a host snapshot. */
export interface CpuSnapshot {
  utilization: CpuUtilization;
  /** Per-core occupancy over the same interval. May be empty; never faked. */
  perCore: CpuCoreUtilization[];
  /** Cumulative totals for the current sample, in USER_HZ. */
  currentTimes: SystemMetric<CpuTimes>;
  /**
   * Cumulative totals from the previous sample, needed to make a DERIVED
   * figure reproducible by a reader. `UNAVAILABLE` on the first sample.
   */
  previousTimes: SystemMetric<CpuTimes>;
  /** Number of cores the kernel enumerated in this sample. */
  coreCount: SystemMetric<number>;
}

/** One core's occupancy, mirroring the aggregate shape. */
export interface CpuCoreUtilization {
  index: number;
  busyPercent: SystemMetric<number>;
  idlePercent: SystemMetric<number>;
  iowaitPercent: SystemMetric<number>;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/** The memory block of a host snapshot. */
export interface MemorySnapshot {
  totalBytes: SystemMetric<number>;
  freeBytes: SystemMetric<number>;
  /**
   * `MemAvailable` from `/proc/meminfo`.
   *
   * NOT the same as free memory. The kernel computes it, weighing reclaimable
   * slab and page cache against the reserve it keeps for atomic allocation, and
   * `proc_meminfo(5)` describes it as an estimate. `used` is therefore derived
   * from `MemAvailable` and never from `MemFree`.
   */
  availableBytes: SystemMetric<number>;
  /** `total - available`. The figure Linux users actually mean by "used". */
  usedBytes: SystemMetric<number>;
  usedPercent: SystemMetric<number>;
  buffersBytes: SystemMetric<number>;
  cachedBytes: SystemMetric<number>;
  reclaimableBytes: SystemMetric<number>;
  /** Anonymous (non-page-cache) memory. */
  anonPagesBytes: SystemMetric<number>;
  sharedBytes: SystemMetric<number>;
  slabBytes: SystemMetric<number>;
  activeBytes: SystemMetric<number>;
  inactiveBytes: SystemMetric<number>;
  dirtyBytes: SystemMetric<number>;
  writebackBytes: SystemMetric<number>;
  swapTotalBytes: SystemMetric<number>;
  swapFreeBytes: SystemMetric<number>;
  swapUsedBytes: SystemMetric<number>;
  /** UNAVAILABLE, not 0, when the kernel reports `SwapTotal: 0`. */
  swapPercent: SystemMetric<number>;
  /** `VmSwap` equivalent for the whole system, when the kernel publishes it. */
  swapCachedBytes: SystemMetric<number>;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/** The load block of a host snapshot. */
export interface LoadSnapshot {
  /** 1-minute exponentially-damped average of runnable+uninterruptible tasks. */
  load1: SystemMetric<number>;
  load5: SystemMetric<number>;
  load15: SystemMetric<number>;
  /**
   * Runnable threads divided by logical CPUs. Derived, and only comparable to
   * load because it shares the same definition.
   */
  load1PerCpu: SystemMetric<number>;
  /** Threads currently runnable, from the `/proc/loadavg` numerator. */
  runnable: SystemMetric<number>;
  /** Threads in the whole system, from the `/proc/loadavg` denominator. */
  totalThreads: SystemMetric<number>;
  /**
   * Most recently allocated PID, from `/proc/loadavg`.
   * A useful sanity check that the collector is reading the live kernel and
   * not a cached copy.
   */
  lastPid: SystemMetric<number>;
}

// ---------------------------------------------------------------------------
// Pressure (PSI)
// ---------------------------------------------------------------------------

/**
 * One pressure-stall information record.
 *
 * PSI is not load and not utilization. It answers a different question: what
 * fraction of wall time did *some* task spend stalled waiting for a resource.
 * A host can be at 5% CPU and 90% memory pressure simultaneously.
 */
export interface PressureRecord {
  resource: "cpu" | "memory" | "io";
  /** Time at least one task was stalled, as a percentage of total time. */
  some: PressureAverages;
  /**
   * Time *every* task was stalled simultaneously. Meaningful for CPU and
   * memory; the kernel omits `full` for I/O, in which case every field here is
   * UNAVAILABLE with the kernel's own reason.
   */
  full: PressureAverages;
}

/** The ten/one-minute/three-minute averages Linux publishes for each window. */
export interface PressureAverages {
  avg10: SystemMetric<number>;
  avg60: SystemMetric<number>;
  avg300: SystemMetric<number>;
}

// ---------------------------------------------------------------------------
// Thermal
// ---------------------------------------------------------------------------

/** One discovered temperature sensor, named by what the kernel calls it. */
export interface ThermalSensor {
  /**
   * The sensor's own identity from sysfs: `x86_pkg_temp`, `Core 0`,
   * `acpitz`, `thermal_zone3`. NEVER a synthesized "CPU Temperature".
   */
  name: string;
  /** Raw millidegree reading straight from the kernel, before conversion. */
  rawMilliCelsius: SystemMetric<number>;
  /** Display value in degrees Celsius. The only place the conversion happens. */
  celsius: SystemMetric<number>;
  /** `type` for a thermal zone, or the hwmon `name` plus `tempN_label`. */
  kind: SystemMetric<string>;
  /** Which sysfs class the sensor was discovered through. */
  sourceClass: "thermal_zone" | "hwmon";
  /** Absolute path this sensor was read from, for hand verification. */
  path: string;
  /** `tempN_max` / a cooling trip point, when the driver publishes one. */
  maxCelsius: SystemMetric<number>;
  /** `tempN_crit`, when published. */
  criticalCelsius: SystemMetric<number>;
  /** `tempN_emergency`, when published. */
  emergencyCelsius: SystemMetric<number>;
  /**
   * Whether this sensor is the one a human would mean by "the CPU
   * temperature". True only when the kernel's own metadata says so.
   */
  isPackage: SystemMetric<boolean>;
}

/** A cooling trip point, from the `trip_point_*` files of a thermal zone. */
export interface ThermalTripPoint {
  zone: string;
  index: number;
  type: SystemMetric<string>;
  temperatureCelsius: SystemMetric<number>;
  /** The zone's active cooling device, when the policy references one. */
  device: SystemMetric<string>;
}

/** The thermal block of a host snapshot. */
export interface ThermalSnapshot {
  /** Every sensor the kernel exposes. Empty is a valid, honest result. */
  sensors: ThermalSensor[];
  tripPoints: ThermalTripPoint[];
  /**
   * Highest Celsius across all sensors.
   * UNAVAILABLE, not 0, when there are no sensors at all.
   */
  highestCelsius: SystemMetric<number>;
  /** Name of the sensor `highestCelsius` came from. */
  highestSensor: SystemMetric<string>;
  /**
   * The sensor a human would call "the CPU", when the kernel identifies one.
   * UNAVAILABLE under WSL and most VMs, and that is the correct answer.
   */
  packageCelsius: SystemMetric<number>;
  packageSensor: SystemMetric<string>;
  /**
   * An explicit statement of what thermal data this machine can provide.
   * Rendered verbatim in the UI so "no sensor" never reads as a broken chart.
   */
  availability: SystemMetric<string>;
}

// ---------------------------------------------------------------------------
// CPU frequency
// ---------------------------------------------------------------------------

/** One cpufreq policy, as the driver describes it. */
export interface FrequencyPolicy {
  /** `policyN` directory name. */
  policy: string;
  /** `affected_cpus`, the CPUs this policy governs. */
  affectedCpus: SystemMetric<string>;
  /**
   * `cpuinfo_cur_freq` in kHz.
   *
   * This is what the driver *reports*, not a measurement made by CAPS. The
   * field is named to keep that distinction visible in the payload.
   */
  reportedCurKhz: SystemMetric<number>;
  /** `scaling_cur_freq` in kHz: the frequency the governor has requested. */
  requestedKhz: SystemMetric<number>;
  scalingMinKhz: SystemMetric<number>;
  scalingMaxKhz: SystemMetric<number>;
  scalingGovernor: SystemMetric<string>;
  /** Present only on drivers that implement it (Intel P-state, AMD P-state). */
  boostEnabled: SystemMetric<boolean>;
  /** Present only on `intel_pstate`, which uses a different mechanism. */
  energyPerformancePreference: SystemMetric<string>;
}

/** The frequency block of a host snapshot. */
export interface FrequencySnapshot {
  policies: FrequencyPolicy[];
  /**
   * Whether a real hardware frequency measurement exists.
   *
   * CAPS does not implement a hardware MSR or APIC-based frequency counter, so
   * this is UNAVAILABLE by design. It exists so the UI can say "policy
   * frequency only" rather than implying the numbers are measured silicon.
   */
  measuredHardwareKhz: SystemMetric<number>;
  availability: SystemMetric<string>;
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

/** One block device's cumulative counters, from `/proc/diskstats`. */
export interface DiskDevice {
  /** Major:minor from the kernel. */
  device: string;
  name: string;
  readsCompleted: SystemMetric<number>;
  writesCompleted: SystemMetric<number>;
  /** 512-byte sectors, as the kernel counts them. */
  sectorsRead: SystemMetric<number>;
  sectorsWritten: SystemMetric<number>;
  readBytes: SystemMetric<number>;
  writeBytes: SystemMetric<number>;
  /** Cumulative milliseconds the device had at least one request in flight. */
  ioMillis: SystemMetric<number>;
  /** Requests in flight at the moment of the read. A gauge, not a counter. */
  inFlight: SystemMetric<number>;
  readBytesPerSec: SystemMetric<number>;
  writeBytesPerSec: SystemMetric<number>;
  readsPerSec: SystemMetric<number>;
  writesPerSec: SystemMetric<number>;
  /** `dd` of `ioMillis` over the interval, as a percent. */
  busyPercent: SystemMetric<number>;
}

/** One mounted filesystem's capacity, from `statfs(2)`. */
export interface FilesystemCapacity {
  mountPoint: string;
  device: SystemMetric<string>;
  filesystemType: SystemMetric<string>;
  totalBytes: SystemMetric<number>;
  usedBytes: SystemMetric<number>;
  freeBytes: SystemMetric<number>;
  /**
   * Bytes available to an unprivileged process, which is `f_bavail` and is
   * legitimately lower than `f_bfree`: the difference is the root reserve.
   */
  availableToUserBytes: SystemMetric<number>;
  usedPercent: SystemMetric<number>;
  /** Non-persistent memory, e.g. tmpfs, where the kernel publishes a total. */
  totalInodes: SystemMetric<number>;
  freeInodes: SystemMetric<number>;
}

/** The disk block of a host snapshot. */
export interface DiskSnapshot {
  devices: DiskDevice[];
  filesystems: FilesystemCapacity[];
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** One network interface's counters, from `/proc/net/dev`. */
export interface NetworkInterface {
  name: string;
  rxBytes: SystemMetric<number>;
  rxPackets: SystemMetric<number>;
  rxErrors: SystemMetric<number>;
  rxDropped: SystemMetric<number>;
  rxBytesPerSec: SystemMetric<number>;
  txBytes: SystemMetric<number>;
  txPackets: SystemMetric<number>;
  txErrors: SystemMetric<number>;
  txDropped: SystemMetric<number>;
  txBytesPerSec: SystemMetric<number>;
  /** Kernel-reported link state, when the driver exposes `operstate`. */
  operState: SystemMetric<string>;
  /** Link speed in Mb/s when the driver reports it. Not a throughput figure. */
  linkSpeedMbps: SystemMetric<number>;
  mtu: SystemMetric<number>;
  operStateSource: SystemMetric<string>;
}

/** The network block of a host snapshot. */
export interface NetworkSnapshot {
  interfaces: NetworkInterface[];
  /**
   * Per-process network accounting.
   *
   * Always UNAVAILABLE. Linux exposes no per-process byte counters in procfs;
   * producing one would require an eBPF probe or a netfilter hook, neither of
   * which this product installs. Stated here so no view can quietly imply it.
   */
  perProcessBytes: SystemMetric<number>;
}

// ---------------------------------------------------------------------------
// Process inventory summary
// ---------------------------------------------------------------------------

/** Aggregate process counts by kernel state letter. */
export interface ProcessSummary {
  total: SystemMetric<number>;
  running: SystemMetric<number>;
  sleeping: SystemMetric<number>;
  /** `T`: stopped by a job-control signal. */
  stopped: SystemMetric<number>;
  /** `Z`: exited but not yet reaped. */
  zombie: SystemMetric<number>;
  /** `D`: uninterruptible sleep, usually block I/O. */
  uninterruptible: SystemMetric<number>;
  /** `R` plus `S` plus `D`: threads the scheduler is actively giving time to. */
  threadsTotal: SystemMetric<number>;
  /** Threads created since boot, from `/proc/stat`'s `processes` field. */
  processesCreated: SystemMetric<number>;
}

// ---------------------------------------------------------------------------
// Collector health
// ---------------------------------------------------------------------------

/**
 * Self-observation of the collectors.
 *
 * A monitoring product that cannot report its own cost is asking to be trusted
 * on faith. These numbers let a reader confirm the observer is not the
 * bottleneck, and they are the first thing to check when a metric looks wrong.
 */
export interface CollectorHealth {
  /** Wall time the last full snapshot took. */
  lastCollectionMs: SystemMetric<number>;
  /** Mean over the retained window, for the stability claim in the docs. */
  meanCollectionMs: SystemMetric<number>;
  maxCollectionMs: SystemMetric<number>;
  samples: SystemMetric<number>;
  /** `/proc/<pid>` entries discovered on the last process scan. */
  processesDiscovered: SystemMetric<number>;
  /** Processes for which a basic field set was actually read. */
  processesSampled: SystemMetric<number>;
  /** Individual fields the kernel would not give us, counted not guessed. */
  fieldsUnavailable: SystemMetric<number>;
  /** Paths the collector tried and could not read, per subsystem. */
  errors: SystemMetric<number>;
  /** Named recent errors, so a failure is legible rather than a bare count. */
  recentErrors: string[];
  /** Processes whose smaps detail was skipped to respect the PSS budget. */
  pssSkipped: SystemMetric<number>;
  /** `true` when PSS is being sampled on the slow cadence, as designed. */
  pssDeferred: SystemMetric<boolean>;
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/**
 * One coherent observation of the host.
 *
 * Every block is independently UNAVAILABLE-capable: a kernel with no PSI, no
 * thermal sensor, and no cpufreq still produces a valid snapshot with those
 * blocks empty or unavailable, and that snapshot is publishable.
 */
export interface SystemSnapshot {
  /** Monotonic per-snapshot sequence, used for SSE resume and gap detection. */
  sequence: number;
  /** When this snapshot was assembled. Individual metrics carry their own. */
  timestamp: string;
  identity: HostIdentity;
  cpu: CpuSnapshot;
  memory: MemorySnapshot;
  load: LoadSnapshot;
  pressure: PressureRecord[];
  thermal: ThermalSnapshot;
  frequency: FrequencySnapshot;
  disk: DiskSnapshot;
  network: NetworkSnapshot;
  processSummary: ProcessSummary;
  collectorHealth: CollectorHealth;
}
