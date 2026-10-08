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
  | "process.wait_failed"
  | "process.launch_failed"
  | "execution.cancelled"
  | "signal.received"
  | "session.summary"
  /*
   * Pipeline envelope events.
   *
   * These describe the pipeline as a whole rather than one stage, and they are
   * NOT terminal session events: a session still ends with execution.completed or
   * execution.failed after every stage has been reaped. Recording them as
   * terminal would end the session at the moment the envelope closed, before the
   * gateway had finalised the record.
   *
   * They carry the declared stage count, which is what lets a reader tell a
   * three-stage pipeline from a two-stage one even when a stage produced no
   * events at all.
   */
  | "pipeline.parsed"
  | "pipeline.started"
  | "pipeline.completed";

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
    /**
     * Minor and major faults are gated on SEPARATE sample counts, so both are
     * published. Collapsing them into one count is what let the UI render a hard
     * `0` for minor faults when only major faults had enough samples.
     */
    averageMinorFaults: number | null;
    averageMajorFaults: number | null;
    maxMajorFaults: number | null;
    minorFaultSamples: number;
    majorFaultSamples: number;
    averageRcharBytesPerSec: number | null;
    maxRcharBytesPerSec: number | null;
    averageWcharBytesPerSec: number | null;
    maxWcharBytesPerSec: number | null;
    ioRateSamples: number;
  };
}

export interface HealthResponse {
  /** Liveness only: the gateway process is running. */
  status: string;
  version: string;
  platform: string;
  uptimeSeconds: number;
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
  version: string;
  platform: string;
  engineAvailable: boolean;
  /** Repository-relative path of the engine binary, when inside the repository. */
  enginePath: string;
  allowlist: string[];
  limits: { maxConcurrent: number; defaultTimeoutMs: number; maxTimeoutMs: number; maxOutputBytes: number };
  workspace: string;
  workspaceAvailable: boolean;
  security: {
    bindMode: "local" | "remote";
    loopbackOnly: boolean;
    authentication: string;
    executableResolution: string;
    redirectionHardening: string;
  };
  redirection: { supported: boolean; modes: string[]; stderr: boolean };
  signals: { supported: string[]; identityVerified: boolean };
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
    /**
     * Metrics read from procfs on the sample that reports them. A rate is NOT
     * here: it is computed from two samples, and the previous single
     * `collectedMetrics` list conflated the two, which let a reader conclude
     * `cpuPercent` was a procfs field.
     */
    observedMetrics: string[];
    /** Metrics computed from observations rather than read. */
    derivedMetrics: string[];
    /** Metrics taken from the gateway's own child-process handle. */
    gatewayMetrics: string[];
    /** Per-metric classification, so nothing has to be inferred client-side. */
    metricProvenance: Record<string, "OBSERVED" | "DERIVED" | "GATEWAY">;
    perMetricProvenance: string;
    /** Collected elsewhere or not at all. The UI must not imply coverage. */
    notCollected: string[];
    /** Metric keys derived by differencing two valid samples. */
    derivedRateMetrics: string[];
    firstSampleRule: string;
    counterResetRule: string;
    identityVerification: string;
    categories: TelemetryCategoryCapability[];
    unsupported: TelemetryCategoryCapability[];
  };
  bind: { mode: string; host: string; port: number };
}

export interface TelemetryCategoryCapability {
  id: string;
  label: string;
  detail: string;
  supported: boolean;
  metrics: string[];
  observed?: string[];
  derived?: string[];
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
    readBytesDelta: number | null;
    writeBytesDelta: number | null;
  };
}

/**
 * One frozen, serializable description of a process at a point in execution
 * time.
 *
 * This is the seam the 3D scene, the process list, the HUD and the tooltip all
 * read, so no consumer has to re-parse telemetry or invent its own
 * normalization. Consumers are components/space/ProcessSpace.tsx and
 * components/space/NodeTooltip.tsx.
 *
 * WHY `raw` IS NOT A BAG OF NUMBERS
 * ---------------------------------
 * It used to be `Record<string, number | null>`. That dropped
 * `TelemetryMetric.provenance` at this boundary: by the time a value reached the
 * 3D node, the HUD, the node table or the tooltip, there was no way to tell an
 * OBSERVED reading from a DERIVED rate, because both had become a bare number.
 * One series is OBSERVED (`rssBytes`, read straight from /proc/<pid>/status) and
 * nine are DERIVED (every per-second rate is a delta of two samples). They were
 * drawn, hovered and labelled identically.
 *
 * So provenance travels WITH the value now. `RawMetric` is a value plus its
 * provenance plus the reason when it is unavailable, and a renderer cannot
 * display one without having been handed the other. This is the mechanism that
 * makes "never present a DERIVED value as OBSERVED" a type-level property
 * rather than a reviewer's memory.
 */
export interface RawMetric {
  /** The number, or null when UNAVAILABLE. Never 0 as a stand-in for absent. */
  readonly value: number | null;
  readonly provenance: TelemetryProvenance;
  /** Present when UNAVAILABLE: why, verbatim from the backend. */
  readonly reason?: string;
  /**
   * What the number counts. Present whenever the unit is not the obvious one,
   * because `rchar`/`wchar` are CHARACTER counters and `read_bytes`/`write_bytes`
   * are storage counters, and labelling either as "bytes" is the mistake this
   * project has already made once.
   */
  readonly unitNote?: string;
  /** The kernel path or backend field this value came from, when known. */
  readonly source?: string;
  /** How a DERIVED value was computed, when the backend stated it. */
  readonly formula?: string;
  /** The backend's own confidence in the value, when it stated one. */
  readonly confidence?: string;
}

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
  /**
   * The recorded values behind the normalized ones, each still carrying its own
   * provenance. Consumers read `.value` for the number and MUST read
   * `.provenance` before presenting it as anything but a number.
   */
  raw: {
    cpuPercent: RawMetric;
    rssBytes: RawMetric;
    rcharBytesPerSec: RawMetric;
    wcharBytesPerSec: RawMetric;
    readBytesPerSec: RawMetric;
    writeBytesPerSec: RawMetric;
    minorFaults: RawMetric;
    majorFaults: RawMetric;
    /** DERIVED per-second rates, the values the fault lens actually reads. */
    minorFaultsPerSec: RawMetric;
    majorFaultsPerSec: RawMetric;
    threadCount: RawMetric;
  };
  /** Why any of the above may be missing, verbatim from the backend. */
  unavailable: Array<{ metric: string; reason: string }>;
}
