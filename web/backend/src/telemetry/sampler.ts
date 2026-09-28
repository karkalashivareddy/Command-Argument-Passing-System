import { performance } from "node:perf_hooks";

import { markUnavailable, readProcessSnapshot } from "./collector.js";
import { deriveRates } from "./derive.js";
import { TELEMETRY_SAMPLE_INTERVAL_MS, type Metric, type ProcessSnapshot } from "./types.js";

/**
 * One process to sample, plus everything needed to prove that a PID we read
 * from procfs really is the child CAPS forked.
 */
export interface TelemetryTarget {
  sessionId: string;
  /** PID reported by the CAPS process.started event. Never user supplied. */
  pid: number;
  /** PID of the gateway-spawned CAPS engine, used to verify lineage. */
  capsEnginePid: number | null;
  /** Timestamp of the CAPS process.started event, used once to detect PID reuse. */
  processStartedAt: string;
  /** True once the execution is finalized: no further snapshot may be emitted. */
  isFinalized: () => boolean;
}

export interface TelemetrySample {
  sessionId: string;
  pid: number;
  snapshot: ProcessSnapshot;
}

export interface TelemetrySamplerOptions {
  intervalMs?: number;
  /** Persistence boundary: the sampler hands a finished snapshot over, it never publishes. */
  emit: (sample: TelemetrySample) => void;
  /** Monotonic clock used to measure the interval between two samples. */
  monotonicNow?: () => number;
  /** Wall clock used for the snapshot timestamp. */
  wallNow?: () => number;
  /** Collector seam. Production reads procfs; tests supply a scripted reader. */
  readSnapshot?: (pid: number, nowMs: number) => ProcessSnapshot;
}

/** How far a procfs start time may sit from the CAPS process-start event. */
export const IDENTITY_START_TOLERANCE_MS = 2000;

interface SessionSampling {
  timer: NodeJS.Timeout | null;
  /** undefined = not verified yet, number = accepted start ticks, null = rejected. */
  identityStartTicks: number | null | undefined;
  lastSnapshot: ProcessSnapshot | null;
  lastSampleMonotonicMs: number | null;
  stopped: boolean;
}

/**
 * Per-execution telemetry sampler.
 *
 * The runner owns process lifecycle; this class owns cadence. Each active
 * execution gets exactly one loop, the first sample is taken immediately so
 * even a very short process is observed once, and every tick reads all
 * supported metrics in a single pass. Sampling stops the moment the process
 * vanishes, its identity stops matching, or the execution is finalized, so a
 * process.snapshot can never appear after the session's terminal event.
 */
export class TelemetrySampler {
  private readonly sessions = new Map<string, SessionSampling>();
  private readonly intervalMs: number;
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => number;
  private readonly readSnapshot: (pid: number, nowMs: number) => ProcessSnapshot;

  constructor(private readonly options: TelemetrySamplerOptions) {
    this.intervalMs = options.intervalMs ?? TELEMETRY_SAMPLE_INTERVAL_MS;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.readSnapshot = options.readSnapshot ?? ((pid, nowMs) => readProcessSnapshot(pid, { nowMs }));
  }

  get activeSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  isSampling(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Begin sampling one execution: one immediate sample, then one loop. */
  start(target: TelemetryTarget): void {
    if (this.sessions.has(target.sessionId)) return;
    const state: SessionSampling = {
      timer: null,
      identityStartTicks: undefined,
      lastSnapshot: null,
      lastSampleMonotonicMs: null,
      stopped: false,
    };
    this.sessions.set(target.sessionId, state);
    this.sample(target, state);
    // A rejected first sample (vanished process, foreign PID) ends sampling.
    if (state.stopped) return;
    const timer = setInterval(() => this.sample(target, state), this.intervalMs);
    timer.unref?.();
    state.timer = timer;
  }

  /** Stop sampling one execution. Idempotent. */
  stop(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) this.halt(sessionId, state);
  }

  /** Stop every loop, e.g. on gateway shutdown. */
  close(): void {
    for (const [sessionId, state] of [...this.sessions]) this.halt(sessionId, state);
  }

  private sample(target: TelemetryTarget, state: SessionSampling): void {
    if (state.stopped) return;
    if (target.isFinalized()) {
      this.halt(target.sessionId, state);
      return;
    }

    const monotonicMs = this.monotonicNow();
    const collected = this.readSnapshot(target.pid, this.wallNow());
    const snapshot: ProcessSnapshot = { ...collected, capsEnginePid: capsEnginePidMetric(target.capsEnginePid) };
    const rejection = verifyIdentity(state, target, snapshot);

    let final: ProcessSnapshot;
    if (rejection !== null) {
      // Identity is not proven: report the real reason for every field and
      // stop. Deriving rates from a rejected sample would be noise.
      final = markUnavailable(snapshot, rejection);
    } else {
      const wallMs = state.lastSampleMonotonicMs === null ? null : monotonicMs - state.lastSampleMonotonicMs;
      final = deriveRates(snapshot, state.lastSnapshot, wallMs);
    }

    this.options.emit({ sessionId: target.sessionId, pid: target.pid, snapshot: final });

    if (rejection !== null || final.identityStartTicks === null) {
      this.halt(target.sessionId, state);
      return;
    }
    state.lastSnapshot = final;
    state.lastSampleMonotonicMs = monotonicMs;
  }

  private halt(sessionId: string, state: SessionSampling): void {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.stopped = true;
    this.sessions.delete(sessionId);
  }
}

function capsEnginePidMetric(capsEnginePid: number | null): Metric<number> {
  return typeof capsEnginePid === "number"
    ? { value: capsEnginePid, provenance: "OBSERVED", source: "gateway child_process.spawn" }
    : {
        value: null,
        provenance: "UNAVAILABLE",
        source: "gateway child_process.spawn",
        reason: "CAPS child PID was not returned by the host runtime",
      };
}

/**
 * Prove that the sampled PID is still the CAPS-owned child. A failure here is
 * permanent for the execution: the sampler emits the rejection reason once and
 * then stops, because a recycled PID must never contribute telemetry.
 */
function verifyIdentity(state: SessionSampling, target: TelemetryTarget, snapshot: ProcessSnapshot): string | null {
  const ticks = snapshot.identityStartTicks;
  if (ticks === null) {
    // The collector already reported why procfs could not be read.
    state.identityStartTicks = null;
    return null;
  }

  if (target.capsEnginePid === null) {
    state.identityStartTicks = null;
    return "The gateway-spawned CAPS process PID is unknown, so the procfs PPID cannot be verified; this sample is not accepted as the tracked child";
  }
  if (snapshot.ppid.value !== target.capsEnginePid) {
    state.identityStartTicks = null;
    return "procfs PPID does not match the gateway-spawned CAPS process; this PID is not accepted as the tracked child";
  }

  const prior = state.identityStartTicks;
  if (prior === undefined) {
    const procStartMs = Date.parse(snapshot.startTime.value ?? "");
    const capsStartMs = Date.parse(target.processStartedAt);
    if (!Number.isFinite(procStartMs) || !Number.isFinite(capsStartMs) || Math.abs(procStartMs - capsStartMs) > IDENTITY_START_TOLERANCE_MS) {
      state.identityStartTicks = null;
      return "The procfs PID start time does not match this CAPS process-start event; possible PID reuse";
    }
    state.identityStartTicks = ticks;
    return null;
  }

  if (prior !== ticks) {
    state.identityStartTicks = null;
    return "The tracked PID identity changed during execution; procfs sampling stopped";
  }
  return null;
}
