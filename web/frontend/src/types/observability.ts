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
  cpuPercent: TelemetryMetric<number>;
  rssBytes: TelemetryMetric<number>;
  virtualMemoryBytes: TelemetryMetric<number>;
  threadCount: TelemetryMetric<number>;
  voluntaryContextSwitches: TelemetryMetric<number>;
  nonVoluntaryContextSwitches: TelemetryMetric<number>;
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
  };
}

export interface HealthResponse {
  status: "ok";
  engine: { available: boolean; path: string };
  version: string;
  platform: string;
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
  telemetry: { enabled: boolean; intervalMs: number; source: string; metrics: string[] };
  bind: string;
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
  };
}
