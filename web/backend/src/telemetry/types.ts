/**
 * Canonical telemetry contract for the process microscope.
 *
 * The `process.snapshot` payload is defined here and nowhere else: the
 * procfs collector fills it, the sampler derives the cross-sample rate
 * metrics, and /api/capabilities reports exactly the keys this file lists so
 * the API can never advertise a metric the collector does not produce.
 *
 * Every metric carries its own provenance, so a missing or rejected value is
 * reported as UNAVAILABLE with a reason instead of a fabricated number.
 */

export type Provenance = "OBSERVED" | "DERIVED" | "UNAVAILABLE";

export interface Metric<T> {
  value: T | null;
  provenance: Provenance;
  source: string;
  reason?: string;
}

export interface ProcessSnapshot {
  /** Gateway sample wall clock. The single timestamp for every field below. */
  timestamp: string;

  /** Identity and scheduling metadata */
  pid: Metric<number>;
  capsEnginePid: Metric<number>;
  command: Metric<string>;
  ppid: Metric<number>;
  processGroupId: Metric<number>;
  sessionId: Metric<number>;
  state: Metric<string>;

  /** Kernel-derived time base */
  startTime: Metric<string>;
  elapsedMs: Metric<number>;

  /** CPU: absolute time is derived from procfs ticks, utilization from two samples */
  cpuUserMs: Metric<number>;
  cpuSystemMs: Metric<number>;
  /** user + system CPU time of this same sample */
  cpuTimeMs: Metric<number>;
  /** % of one core, DERIVED from two valid samples */
  cpuPercent: Metric<number>;

  /** Memory */
  rssBytes: Metric<number>;
  virtualMemoryBytes: Metric<number>;

  /** Threads and context switches */
  threadCount: Metric<number>;
  voluntaryContextSwitches: Metric<number>;
  nonVoluntaryContextSwitches: Metric<number>;

  /** Page faults: cumulative kernel counters plus per-second rates */
  minorFaults: Metric<number>;
  majorFaults: Metric<number>;
  minorFaultsPerSec: Metric<number>;
  majorFaultsPerSec: Metric<number>;

  /**
   * /proc/<pid>/io. rchar/wchar count bytes moved through the syscall
   * layer (any file, socket, or pipe); read_bytes/write_bytes count bytes
   * that actually reached a block device and legitimately stay 0 while the
   * page cache absorbs the write. Both are reported; neither is synthesised.
   */
  rcharBytes: Metric<number>;
  wcharBytes: Metric<number>;
  readBytes: Metric<number>;
  writeBytes: Metric<number>;
  rcharBytesPerSec: Metric<number>;
  wcharBytesPerSec: Metric<number>;
  readBytesPerSec: Metric<number>;
  writeBytesPerSec: Metric<number>;

  /** Internal identity token; never persisted in the event payload. */
  identityStartTicks: number | null;
}

export type SnapshotMetricKey = Exclude<keyof ProcessSnapshot, "timestamp" | "identityStartTicks">;

/**
 * Every metric key carried in a persisted process.snapshot payload.
 * `timestamp` and the internal `identityStartTicks` are deliberately absent.
 */
export const SNAPSHOT_METRIC_KEYS = [
  "pid",
  "capsEnginePid",
  "command",
  "ppid",
  "processGroupId",
  "sessionId",
  "state",
  "startTime",
  "elapsedMs",
  "cpuUserMs",
  "cpuSystemMs",
  "cpuTimeMs",
  "cpuPercent",
  "rssBytes",
  "virtualMemoryBytes",
  "threadCount",
  "voluntaryContextSwitches",
  "nonVoluntaryContextSwitches",
  "minorFaults",
  "majorFaults",
  "minorFaultsPerSec",
  "majorFaultsPerSec",
  "rcharBytes",
  "wcharBytes",
  "readBytes",
  "writeBytes",
  "rcharBytesPerSec",
  "wcharBytesPerSec",
  "readBytesPerSec",
  "writeBytesPerSec",
] as const satisfies readonly SnapshotMetricKey[];

/** Keys the gateway fills in from its own child process handle, not from procfs. */
export const GATEWAY_METRIC_KEYS = ["capsEnginePid"] as const;

/** The procfs-collected subset: what the collector is responsible for. */
export const COLLECTED_METRIC_KEYS: readonly SnapshotMetricKey[] = SNAPSHOT_METRIC_KEYS.filter(
  (key) => !(GATEWAY_METRIC_KEYS as readonly string[]).includes(key),
);

/** Metrics that require two valid samples separated by a measured interval. */
export const RATE_METRIC_KEYS = [
  "cpuPercent",
  "minorFaultsPerSec",
  "majorFaultsPerSec",
  "rcharBytesPerSec",
  "wcharBytesPerSec",
  "readBytesPerSec",
  "writeBytesPerSec",
] as const satisfies readonly SnapshotMetricKey[];

export type RateMetricKey = (typeof RATE_METRIC_KEYS)[number];

/** Cumulative counters that feed a per-second rate, with their displayed unit. */
export const COUNTER_RATES = [
  { key: "minorFaults", rate: "minorFaultsPerSec", unit: "faults/s" },
  { key: "majorFaults", rate: "majorFaultsPerSec", unit: "faults/s" },
  { key: "rcharBytes", rate: "rcharBytesPerSec", unit: "bytes/s" },
  { key: "wcharBytes", rate: "wcharBytesPerSec", unit: "bytes/s" },
  { key: "readBytes", rate: "readBytesPerSec", unit: "bytes/s" },
  { key: "writeBytes", rate: "writeBytesPerSec", unit: "bytes/s" },
] as const satisfies ReadonlyArray<{ key: SnapshotMetricKey; rate: RateMetricKey; unit: string }>;

export type CounterRateKey = (typeof COUNTER_RATES)[number]["key"];

/** Default sampling cadence shared by the sampler and the capabilities report. */
export const TELEMETRY_SAMPLE_INTERVAL_MS = 500;

/**
 * Capability categories. The union of `metrics` must equal SNAPSHOT_METRIC_KEYS
 * exactly; a unit test enforces that so the API and the collector cannot drift.
 */
export interface TelemetryCategory {
  id: string;
  label: string;
  metrics: readonly SnapshotMetricKey[];
  /** Human-readable statement of what these metrics actually are. */
  detail: string;
}

export const TELEMETRY_CATEGORIES: readonly TelemetryCategory[] = [
  {
    id: "cpu",
    label: "CPU",
    metrics: ["cpuUserMs", "cpuSystemMs", "cpuTimeMs", "cpuPercent"],
    detail: "User, system, and total CPU time from /proc/<pid>/stat ticks; utilization is a two-sample rate of one core, so it can exceed 100% for a multithreaded process. This is process CPU, never system-wide CPU.",
  },
  {
    id: "memory",
    label: "Memory",
    metrics: ["rssBytes", "virtualMemoryBytes"],
    detail: "VmRSS (resident) and VmSize (virtual) from /proc/<pid>/status. They are different address-space properties and are not interchangeable.",
  },
  {
    id: "pageFaults",
    label: "Page faults",
    metrics: ["minorFaults", "majorFaults", "minorFaultsPerSec", "majorFaultsPerSec"],
    detail: "minflt and majflt from /proc/<pid>/stat. Minor faults are usually first-touch or copy-on-write mappings; major faults required real I/O and are the ones that indicate disk paging.",
  },
  {
    id: "io",
    label: "I/O",
    metrics: [
      "rcharBytes", "wcharBytes", "readBytes", "writeBytes",
      "rcharBytesPerSec", "wcharBytesPerSec", "readBytesPerSec", "writeBytesPerSec",
    ],
    detail: "rchar/wchar count bytes moved through the syscall layer; read_bytes/write_bytes count bytes that reached a block device. Character counters are not disk throughput.",
  },
  {
    id: "threads",
    label: "Threads",
    metrics: ["threadCount"],
    detail: "Thread count from /proc/<pid>/status, falling back to the stat thread field.",
  },
  {
    id: "contextSwitches",
    label: "Context switches",
    metrics: ["voluntaryContextSwitches", "nonVoluntaryContextSwitches"],
    detail: "voluntary_ctxt_switches and nonvoluntary_ctxt_switches from /proc/<pid>/status: how often the kernel switched this process in or away.",
  },
  {
    id: "identity",
    label: "Process identity",
    metrics: ["pid", "capsEnginePid", "ppid", "processGroupId", "sessionId", "state", "command", "startTime", "elapsedMs"],
    detail: "Identity and lifecycle attributes used to prove that a sampled PID is a CAPS-reported direct child: PPID, start ticks, and the process state letter from procfs. capsEnginePid is the gateway's own child-process PID, not a procfs read.",
  },
];

/**
 * Telemetry the gateway does not collect. Listed explicitly with a reason so
 * no view can imply coverage that does not exist.
 */
export const UNSUPPORTED_TELEMETRY_CATEGORIES: ReadonlyArray<{ id: string; label: string; reason: string }> = [
  { id: "syscallTracing", label: "Syscall tracing", reason: "No ptrace/strace. Only kernel-exposed procfs counters are read." },
  { id: "ebpf", label: "eBPF", reason: "No eBPF probe attachment; the gateway only reads procfs." },
  { id: "cgroups", label: "cgroup accounting", reason: "No cgroup hierarchy is created or read for tracked children." },
  { id: "networkIo", label: "Network I/O", reason: "/proc/<pid>/io is not per-device; socket counters are not collected." },
  { id: "fileDescriptors", label: "File descriptor counts", reason: "Only the descriptor fields the workload catalog needs are tracked, not a full fd table census." },
];
