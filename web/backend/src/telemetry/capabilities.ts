import {
  COLLECTED_METRIC_KEYS,
  RATE_METRIC_KEYS,
  SNAPSHOT_METRIC_KEYS,
  TELEMETRY_CATEGORIES,
  TELEMETRY_SAMPLE_INTERVAL_MS,
  UNSUPPORTED_TELEMETRY_CATEGORIES,
  type SnapshotMetricKey,
} from "./types.js";
import { pidfdCapability, type IdentityConfidence } from "../execution/pidfd.js";

/**
 * The capability response is a claim about what the observatory observes, so
 * it must not blur three different things together:
 *
 *   OBSERVED     a value read from procfs on this sample
 *   DERIVED      computed from two or more observations (a delta, a conversion)
 *   UNAVAILABLE  not produced at all, with the reason stated
 *
 * The previous response published a `collectedMetrics` list that was
 * "everything except capsEnginePid", which included seven rate metrics and two
 * time metrics that are computed rather than read, and marked every category
 * `supported: true` with no indication of how its numbers were produced.  A
 * reader could reasonably conclude that `cpuPercent` is a procfs field.  It is
 * not; it is a two-sample delta.
 *
 * The classification below is derived from the collector's own key lists, so it
 * cannot drift from what the collector actually produces.
 */

/** Metrics that are one or more conversions of a procfs counter, not a read. */
const DERIVED_ONLY_METRICS: ReadonlySet<SnapshotMetricKey> = new Set([
  "startTime",
  "elapsedMs",
  "cpuUserMs",
  "cpuSystemMs",
  "cpuTimeMs",
  ...(RATE_METRIC_KEYS as readonly SnapshotMetricKey[]),
]);

/** Metrics the gateway fills from its own child-process handle, not procfs. */
const GATEWAY_METRICS: ReadonlySet<SnapshotMetricKey> = new Set(["capsEnginePid"]);

export type MetricProvenanceClass = "OBSERVED" | "DERIVED" | "GATEWAY";

export function classifyMetric(key: SnapshotMetricKey): MetricProvenanceClass {
  if (GATEWAY_METRICS.has(key)) return "GATEWAY";
  if (DERIVED_ONLY_METRICS.has(key)) return "DERIVED";
  return "OBSERVED";
}

export interface TelemetryCapabilities {
  enabled: boolean;
  intervalMs: number;
  source: string;
  /** Every metric key a persisted process.snapshot payload carries. */
  metrics: readonly string[];
  /** Metrics read directly from procfs on the sample that reports them. */
  observedMetrics: readonly string[];
  /** Metrics computed from observations; never read from a single procfs field. */
  derivedMetrics: readonly string[];
  /** Metrics taken from the gateway's own child-process handle. */
  gatewayMetrics: readonly string[];
  /** Per-metric classification, so a consumer never has to infer it. */
  metricProvenance: Record<string, MetricProvenanceClass>;
  /** Every rate metric, which needs two valid samples separated by a measured interval. */
  derivedRateMetrics: readonly string[];
  categories: Array<{
    id: string;
    label: string;
    supported: true;
    metrics: readonly string[];
    observed: readonly string[];
    derived: readonly string[];
    detail: string;
  }>;
  unsupported: Array<{ id: string; label: string; supported: false; reason: string }>;
  perMetricProvenance: string;
  firstSampleRule: string;
  counterResetRule: string;
  identityVerification: string;
  notCollected: string[];
  /**
   * How strongly the gateway can address a process it is about to signal.
   *
   * Published because the answer changes what a reader should believe about a
   * termination. Under `VERIFIED` the kernel itself guarantees the signal
   * reached the observed process. Under `UNVERIFIED` the guarantee comes from a
   * start-ticks comparison the gateway performed, which is sound but is our
   * check rather than the kernel's. Under `UNAVAILABLE` termination declines
   * rather than guess.
   */
  processIdentity: ProcessIdentityCapability;
}

export interface ProcessIdentityCapability {
  /** The identity tuple the gateway treats as a process reference. */
  model: string;
  confidence: IdentityConfidence;
  /** Always present. Never empty, and never an invented success. */
  reason: string;
  /** Kernel release the measurement was taken on, or null when unreadable. */
  kernel: string | null;
  /** The mechanism that carries a SIGKILL escalation on this host. */
  terminationMechanism: "pidfd" | "start-ticks" | "unavailable";
  /**
   * The invariant, stated as a claim the implementation must uphold.
   *
   * Exposed as text so a client can display the guarantee rather than
   * re-deriving it, and so the wording can only change with the code.
   */
  invariant: string;
}

export async function processIdentityCapability(): Promise<ProcessIdentityCapability> {
  const cap = await pidfdCapability();
  return {
    model: "(pid, startTicks, bootId)",
    confidence: cap.confidence,
    reason: cap.reason,
    kernel: cap.kernel,
    // UNAVAILABLE means the helper itself is unusable, so no termination
    // mechanism can be exercised at all. UNVERIFIED means pidfd is absent but
    // start-ticks validation still runs, which is a working mechanism with a
    // weaker guarantee. Collapsing the two would misdescribe the host.
    terminationMechanism: cap.available ? "pidfd" : cap.confidence === "UNAVAILABLE" ? "unavailable" : "start-ticks",
    invariant:
      "A signal is never delivered to a bare PID. Where pidfd is available the kernel binds the target, so a recycled PID cannot be signalled. " +
      "Where it is not, the recorded start ticks are compared against /proc/<pid>/stat immediately before the signal, and a mismatch refuses the signal.",
  };
}

export async function telemetryCapabilities(options: { enabled: boolean; source: string }): Promise<TelemetryCapabilities> {
  const metricProvenance: Record<string, MetricProvenanceClass> = {};
  for (const key of SNAPSHOT_METRIC_KEYS) metricProvenance[key] = classifyMetric(key);

  const observed = SNAPSHOT_METRIC_KEYS.filter((k) => metricProvenance[k] === "OBSERVED");
  const derived = SNAPSHOT_METRIC_KEYS.filter((k) => metricProvenance[k] === "DERIVED");
  const gateway = SNAPSHOT_METRIC_KEYS.filter((k) => metricProvenance[k] === "GATEWAY");

  return {
    enabled: options.enabled,
    intervalMs: TELEMETRY_SAMPLE_INTERVAL_MS,
    source: options.source,
    metrics: SNAPSHOT_METRIC_KEYS,
    // Kept as an explicit alias of the procfs-read subset: the previous field
    // name implied "everything the payload carries", which was not true.
    observedMetrics: observed,
    derivedMetrics: derived,
    gatewayMetrics: gateway,
    metricProvenance,
    derivedRateMetrics: RATE_METRIC_KEYS,
    categories: TELEMETRY_CATEGORIES.map((category) => ({
      id: category.id,
      label: category.label,
      supported: true as const,
      metrics: category.metrics,
      observed: category.metrics.filter((m) => metricProvenance[m] === "OBSERVED"),
      derived: category.metrics.filter((m) => metricProvenance[m] === "DERIVED"),
      detail: category.detail,
    })),
    unsupported: UNSUPPORTED_TELEMETRY_CATEGORIES.map((category) => ({
      id: category.id,
      label: category.label,
      supported: false as const,
      reason: category.reason,
    })),
    perMetricProvenance: "Every metric in a process.snapshot payload carries its own provenance: OBSERVED (read from procfs), DERIVED (computed from observations), or UNAVAILABLE (not produced, with a reason).",
    firstSampleRule: "The first sample of a process reports every rate as UNAVAILABLE; a rate is never invented or zero-filled.",
    counterResetRule: "A cumulative counter that decreases between two samples is reported as UNAVAILABLE, never as zero, because a decrease means the identity changed rather than that nothing was measured.",
    identityVerification: "Each CAPS-reported PID is accepted only while its procfs PPID matches the gateway-spawned CAPS process and its start ticks stay constant; otherwise sampling stops for that PID.",
    notCollected: UNSUPPORTED_TELEMETRY_CATEGORIES.map((category) => category.label),
    processIdentity: await processIdentityCapability(),
  };
}

/** Every procfs-read key, exported for tests that assert the classification. */
export const OBSERVED_METRIC_KEYS = COLLECTED_METRIC_KEYS.filter(
  (k) => !DERIVED_ONLY_METRICS.has(k) && !GATEWAY_METRICS.has(k),
);
