/* Mirror of web/backend/src/types/observability.ts (kept in lockstep). */

export type EventSource = "caps" | "gateway";

export type CanonicalEventType =
  | "execution.created"
  | "execution.started"
  | "execution.completed"
  | "execution.failed"
  | "execution.timeout"
  | "command.received"
  | "command.parsed"
  | "command.parse_error"
  | "redirection.opened"
  | "redirection.failed"
  | "process.started"
  | "process.snapshot"
  | "process.exited"
  | "process.exec_error"
  | "signal.received"
  | "session.summary";

export interface CanonicalEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: CanonicalEventType;
  source: EventSource;
  timestamp: string;
  monotonicMs: number | null;
  pid: number | null;
  payload: Record<string, unknown>;
}

export type TelemetryProvenance = "OBSERVED" | "DERIVED" | "UNAVAILABLE";
export interface TelemetryMetric<T> {
  value: T | null;
  provenance: TelemetryProvenance;
  source: string;
  reason?: string;
}
export interface ProcessSnapshot {
  timestamp: string;
  capsEnginePid: TelemetryMetric<number>;
  pid: TelemetryMetric<number>;
  command: TelemetryMetric<string>;
  ppid: TelemetryMetric<number>;
  processGroupId: TelemetryMetric<number>;
  sessionId: TelemetryMetric<number>;
  state: TelemetryMetric<string>;
  startTime: TelemetryMetric<string>;
  elapsedMs: TelemetryMetric<number>;
  cpuUserMs: TelemetryMetric<number>;
  cpuSystemMs: TelemetryMetric<number>;
  /** cpuUserMs + cpuSystemMs; OBSERVED total CPU time of the process. */
  cpuTimeMs: TelemetryMetric<number>;
  /** Process CPU utilization as a percentage of one CPU core. */
  cpuPercent: TelemetryMetric<number>;
  rssBytes: TelemetryMetric<number>;
  virtualMemoryBytes: TelemetryMetric<number>;
  threadCount: TelemetryMetric<number>;
  voluntaryContextSwitches: TelemetryMetric<number>;
  nonVoluntaryContextSwitches: TelemetryMetric<number>;
  minorFaults: TelemetryMetric<number>;
  majorFaults: TelemetryMetric<number>;
  minorFaultsPerSec: TelemetryMetric<number>;
  majorFaultsPerSec: TelemetryMetric<number>;
  /** Block-device read bytes; not a measure of all I/O. */
  readBytes: TelemetryMetric<number>;
  /** Block-device write bytes; not a measure of all I/O. */
  writeBytes: TelemetryMetric<number>;
  /** Characters read by read()/pread() including page cache; not disk throughput. */
  rcharBytes: TelemetryMetric<number>;
  /** Characters written by write()/pwrite() including page cache; not disk throughput. */
  wcharBytes: TelemetryMetric<number>;
  readBytesPerSec: TelemetryMetric<number>;
  writeBytesPerSec: TelemetryMetric<number>;
  rcharBytesPerSec: TelemetryMetric<number>;
  wcharBytesPerSec: TelemetryMetric<number>;
}

export type SessionStatus =
  | "CREATED"
  | "STARTING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

export interface RedirectionSpec {
  in?: string;
  out?: string;
  append?: string;
}

export interface SessionRecord {
  id: string;
  command: string;
  args: string[];
  argv: string[];
  redirections: RedirectionSpec;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  signal: number | null;
  isSuccess: boolean | null;
  pid: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  timeoutMs: number | null;
  eventCount: number;
}

export interface ProcessRecord {
  sessionId: string;
  pid: number | null;
  command: string;
  argv: string[];
  state: "STARTING" | "RUNNING" | "WAITING" | "EXITED" | "SIGNALED" | "FAILED";
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  signal: number | null;
}

export interface AnalyticsOverview {
  totalExecutions: number;
  successful: number;
  failed: number;
  signalled: number;
  running: number;
  avgDurationMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  byExitCode: Record<string, number>;
  bySignal: Record<string, number>;
  byCommand: Record<string, number>;
  redirectionUsage: Record<string, number>;
  byDay: Array<{ date: string; count: number; success: number }>;
  processTelemetry: {
    sampleCount: number;
    executionsSampled: number;
    averageRssBytes: number | null;
    maxRssBytes: number | null;
    rssSamples: number;
    averageCpuTimeMs: number | null;
    cpuTimeExecutions: number;
    averageCpuPercent: number | null;
    cpuPercentSamples: number;
    averageMinorFaults: number | null;
    averageMajorFaults: number | null;
    maxMajorFaults: number | null;
    majorFaultSamples: number;
    averageRcharBytesPerSec: number | null;
    maxRcharBytesPerSec: number | null;
    averageWcharBytesPerSec: number | null;
    maxWcharBytesPerSec: number | null;
    ioRateSamples: number;
  };
}

export interface HealthResponse {
  status: "ok";
  engine: { available: boolean; path: string };
  version: string;
  platform: string;
}

export interface WorkloadArgSpec {
  name: string;
  min: number;
  max: number;
  default: number;
  unit: string;
  description: string;
}

export interface WorkloadProfileCapability {
  id: string;
  label: string;
  description: string;
  observes: string[];
  args: WorkloadArgSpec[];
  executablePath: string;
  executableRelativePath: string;
  /** Probed on the server, never assumed by the client. */
  available: boolean;
  availabilityProvenance: "OBSERVED";
  unavailableReason: string | null;
}

export interface CapabilitiesResponse {
  platform: string;
  engineAvailable: boolean;
  capsPath: string;
  allowlist: string[];
  limits: { maxConcurrent: number; defaultTimeoutMs: number; maxTimeoutMs: number; maxOutputBytes: number };
  workspace: string;
  redirection: { supported: boolean; modes: string[] };
  signals: { supported: boolean };
  workloads: {
    count: number;
    available: number;
    profiles: WorkloadProfileCapability[];
    limits: { maxDurationS: number; maxMemoryMib: number; maxIoMib: number; maxForkChildren: number };
  };
  telemetry: {
    enabled: boolean;
    intervalMs: number;
    source: string;
    /** Every metric key a persisted process.snapshot can carry. */
    metrics: string[];
    perMetricProvenance: string;
    /** Collected elsewhere or not at all. The UI must not imply coverage. */
    notCollected: string[];
    /** Metric keys the collector actually reads out of procfs. */
    collectedMetrics: string[];
    /** Metric keys derived by differencing two valid samples. */
    derivedRateMetrics: string[];
    firstSampleRule: string;
    identityVerification: string;
    categories: TelemetryCategoryCapability[];
    unsupported: TelemetryCategoryCapability[];
  };
  bind: string;
}

export interface TelemetryCategoryCapability {
  id: string;
  label: string;
  detail: string;
  supported: boolean;
  metrics: string[];
  reason?: string;
}

export interface CreateSessionRequest {
  command: string;
  args: string[];
  redirections?: RedirectionSpec;
  timeoutMs?: number;
}

export interface CreateSessionResponse {
  sessionId: string;
  status: SessionStatus;
  eventsUrl: string;
  argvPreview: string[];
}

export interface ReplayResponse {
  sessionId: string;
  command: string;
  argv: string[];
  startedAt: string;
  status: SessionStatus;
  events: CanonicalEvent[];
  result: {
    exitCode: number | null;
    signal: number | null;
    durationMs: number | null;
    isSuccess: boolean | null;
    status: SessionStatus;
  };
}

export interface ProcessInfo {
  sessionId: string;
  pid: number | null;
  command: string;
  argv: string[];
  state: ProcessRecord["state"];
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  signal: number | null;
  telemetry: ProcessSnapshot | null;
}

export interface RuntimePeakPoint {
  value: number;
  atTimeMs: number;
  atTimestamp: string;
}

export interface RuntimePeaks {
  sampleCount: number;
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  minElapsedMs: number | null;
  maxElapsedMs: number | null;
  peakRssBytes: RuntimePeakPoint | null;
  medianRssBytes: number | null;
  peakCpuPercent: RuntimePeakPoint | null;
  cpuTimeMs: number | null;
  peakMinorFaults: RuntimePeakPoint | null;
  peakMajorFaults: RuntimePeakPoint | null;
  peakMinorFaultsPerSec: RuntimePeakPoint | null;
  peakMajorFaultsPerSec: RuntimePeakPoint | null;
  peakRcharBytesPerSec: RuntimePeakPoint | null;
  peakWcharBytesPerSec: RuntimePeakPoint | null;
  /** Cumulative counters: the last valid observation is the session total. */
  totalRcharBytes: number | null;
  totalWcharBytes: number | null;
  totalReadBytes: number | null;
  totalWriteBytes: number | null;
}

export interface CommandProfile {
  command: string;
  runs: number;
  successful: number;
  failed: number;
  signalled: number;
  successRate: number | null;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
  minDurationMs: number | null;
  maxDurationMs: number | null;
  rssSamples: number;
  medianRssBytes: number | null;
  peakRssBytes: number | null;
  lastRunAt: string | null;
}

export interface ComparisonSide {
  sessionId: string;
  command: string;
  args: string[];
  status: SessionStatus;
  exitCode: number | null;
  signal: number | null;
  durationMs: number | null;
  eventCount: number;
  snapshotCount: number;
  peakRssBytes: number | null;
  medianRssBytes: number | null;
  peakCpuPercent: number | null;
  cpuTimeMs: number | null;
  peakMinorFaults: number | null;
  peakMajorFaults: number | null;
  totalRcharBytes: number | null;
  totalWcharBytes: number | null;
  totalReadBytes: number | null;
  totalWriteBytes: number | null;
}

export interface SessionComparison {
  left: ComparisonSide;
  right: ComparisonSide;
  shared: {
    sameCommand: boolean;
    command: string | null;
    sameExit: boolean;
    sameSignal: boolean;
    sameStatus: boolean;
  };
  deltas: {
    durationMs: number | null;
    eventDelta: number;
    snapshotDelta: number;
    peakRssDeltaBytes: number | null;
    cpuTimeDeltaMs: number | null;
    majorFaultsDelta: number | null;
    rcharDeltaBytes: number | null;
    wcharDeltaBytes: number | null;
  };
}

/**
 * Future 3D contract: one frozen, serializable description of a process at a
 * point in execution time. The 3D scene is not implemented yet; this type is
 * the seam it will read, so no 3D code has to invent its own telemetry.
 */
export interface ProcessVisualState {
  sessionId: string;
  sequence: number;
  timestamp: string;
  /** Milliseconds since the first persisted sample of this session. */
  atMs: number;
  pid: number | null;
  capsEnginePid: number | null;
  command: string | null;
  state: string | null;
  /** Normalized 0..1 values, ready to scale geometry without a second parse. */
  cpu: number | null;
  memory: number | null;
  io: number | null;
  faults: number | null;
  /** Raw observed values behind the normalized ones, for labels and tooltips. */
  raw: {
    cpuPercent: number | null;
    rssBytes: number | null;
    rcharBytesPerSec: number | null;
    wcharBytesPerSec: number | null;
    readBytesPerSec: number | null;
    writeBytesPerSec: number | null;
    minorFaults: number | null;
    majorFaults: number | null;
    /** DERIVED per-second rates, the values the fault lens actually reads. */
    minorFaultsPerSec: number | null;
    majorFaultsPerSec: number | null;
    threadCount: number | null;
  };
  /** Why any of the above may be missing, verbatim from the backend. */
  unavailable: Array<{ metric: string; reason: string }>;
}
