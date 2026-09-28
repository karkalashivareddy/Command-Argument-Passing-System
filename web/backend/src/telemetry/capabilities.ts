import {
  COLLECTED_METRIC_KEYS,
  RATE_METRIC_KEYS,
  SNAPSHOT_METRIC_KEYS,
  TELEMETRY_CATEGORIES,
  TELEMETRY_SAMPLE_INTERVAL_MS,
  UNSUPPORTED_TELEMETRY_CATEGORIES,
} from "./types.js";

export interface TelemetryCapabilities {
  enabled: boolean;
  intervalMs: number;
  source: string;
  /** Every metric key a persisted process.snapshot payload carries. */
  metrics: readonly string[];
  /** The procfs-collected subset the collector is responsible for. */
  collectedMetrics: readonly string[];
  /** Metrics that need two valid samples separated by a measured interval. */
  derivedRateMetrics: readonly string[];
  categories: Array<{ id: string; label: string; supported: true; metrics: readonly string[]; detail: string }>;
  unsupported: Array<{ id: string; label: string; supported: false; reason: string }>;
  perMetricProvenance: string;
  firstSampleRule: string;
  identityVerification: string;
  notCollected: string[];
}

/**
 * Build the telemetry half of /api/capabilities straight from the collector's
 * own key list, so the API can never advertise a metric that is not collected
 * or hide one that is.
 */
export function telemetryCapabilities(options: { enabled: boolean; source: string }): TelemetryCapabilities {
  return {
    enabled: options.enabled,
    intervalMs: TELEMETRY_SAMPLE_INTERVAL_MS,
    source: options.source,
    metrics: SNAPSHOT_METRIC_KEYS,
    collectedMetrics: COLLECTED_METRIC_KEYS,
    derivedRateMetrics: RATE_METRIC_KEYS,
    categories: TELEMETRY_CATEGORIES.map((category) => ({
      id: category.id,
      label: category.label,
      supported: true as const,
      metrics: category.metrics,
      detail: category.detail,
    })),
    unsupported: UNSUPPORTED_TELEMETRY_CATEGORIES.map((category) => ({
      id: category.id,
      label: category.label,
      supported: false as const,
      reason: category.reason,
    })),
    perMetricProvenance: "reported per metric in every process.snapshot payload",
    firstSampleRule: "The first sample of a process reports every rate as UNAVAILABLE; a rate is never invented or zero-filled.",
    identityVerification: "A sampled PID is accepted only while its procfs PPID matches the gateway-spawned CAPS process and its start ticks stay constant; otherwise sampling stops for that execution.",
    notCollected: UNSUPPORTED_TELEMETRY_CATEGORIES.map((category) => category.label),
  };
}
