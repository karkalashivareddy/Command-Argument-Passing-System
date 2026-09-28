/**
 * Canonical observability event contract shared by the gateway, the SSE
 * stream, the store, and the UI. The frontend mirrors these shapes under
 * web/frontend/src/types/observability.ts (kept in lockstep).
 */

/** Which layer produced the event. */
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

export interface CanonicalEvent<T = Record<string, unknown>> {
  id: string;
  sessionId: string;
  sequence: number;
  type: CanonicalEventType;
  source: EventSource;
  timestamp: string; // ISO-8601 (gateway receives it; display tz is per-browser)
  monotonicMs: number | null; // real elapsed ms (from CLOCK_MONOTONIC, caps) or null
  pid: number | null;
  payload: T;
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
    /** Page faults, averaged per observed sample */
    averageMinorFaults: number | null;
    averageMajorFaults: number | null;
    majorFaultSamples: number;
    maxMajorFaults: number | null;
    /** Syscall-layer character I/O rates (not disk throughput) */
    averageRcharBytesPerSec: number | null;
    averageWcharBytesPerSec: number | null;
    maxRcharBytesPerSec: number | null;
    maxWcharBytesPerSec: number | null;
    ioRateSamples: number;
  };
}

/** A runtime peak/moment pinned to a real persisted sample. */
export interface RuntimePeakPoint {
  value: number;
  /** milliseconds after the session's first event timestamp */
  atTimeMs: number;
  atTimestamp: string;
}

/** Per-execution telemetry summary derived only from persisted process.snapshot events. */
export interface RuntimePeaks {
  sampleCount: number;
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  minElapsedMs: number | null;
  maxElapsedMs: number | null;
  peakRssBytes: RuntimePeakPoint | null;
  medianRssBytes: number | null;
  peakCpuPercent: RuntimePeakPoint | null;
  /** user + system CPU time from the final persisted sample */
  cpuTimeMs: number | null;
  peakMinorFaults: RuntimePeakPoint | null;
  peakMajorFaults: RuntimePeakPoint | null;
  peakMinorFaultsPerSec: RuntimePeakPoint | null;
  peakMajorFaultsPerSec: RuntimePeakPoint | null;
  /**
   * Cumulative counters: the last valid observed value of each /proc/<pid>/io
   * counter in the session, which is the total the process moved.
   */
  totalRcharBytes: number | null;
  totalWcharBytes: number | null;
  totalReadBytes: number | null;
  totalWriteBytes: number | null;
  peakRcharBytesPerSec: RuntimePeakPoint | null;
  peakWcharBytesPerSec: RuntimePeakPoint | null;
}

/** Command-level profile built from terminal sessions of that command. */
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

/** One side of an execution comparison. */
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
    minorFaultsDelta: number | null;
    majorFaultsDelta: number | null;
    rcharDeltaBytes: number | null;
    wcharDeltaBytes: number | null;
  };
}

// Type-safe payloads for key events (informational; the event row also
// keeps a copy of the raw payload as JSON).
export interface ProcessStartedPayload { label: string; }
export interface ProcessExitedPayload { label: string; exitCode: number; durationMs: number; }
export interface SignalReceivedPayload { label: string; signal: number; }
export interface SummaryPayload {
  commands: number;
  succeeded: number;
  failed: number;
  signals: number;
  timed: number;
  averageDurationMs: number;
}
export interface ExecErrorPayload { label: string; }
