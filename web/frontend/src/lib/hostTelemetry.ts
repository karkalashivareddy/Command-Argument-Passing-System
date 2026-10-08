/**
 * Host-observability rendering: how a metric becomes text, and how an absent
 * one becomes a sentence.
 *
 * The central rule, and the reason this module exists separately from the page:
 * an unavailable metric is NEVER rendered as 0, and never silently omitted.
 * It renders as the gateway's own reason string.
 *
 * The failure this prevents is the one that makes dashboards untrustworthy. A
 * chart that begins at a plausible 45 degrees and rises with CPU load looks
 * exactly like a real thermal trace, and it is entirely invented, and nobody can
 * tell by looking. Rendering `UNAVAILABLE` as `0 °C` produces precisely that
 * chart.
 */

import type { SystemMetric } from "../api/observability";

/**
 * A rendered metric, kept structured so a caller cannot accidentally lose the
 * distinction between a number and the reason there is no number.
 */
export interface RenderedMetric {
  /** The value as text, or null when there is none. Never "0" standing in. */
  text: string | null;
  /** The gateway's reason, present whenever `text` is null. */
  reason: string | null;
  unit: string;
  provenance: SystemMetric<unknown>["provenance"];
  /** The exact file the value was read from, for a reader who wants to check. */
  source: string;
  /** True when the kernel documents the value as an approximation. */
  estimate: boolean;
  timestamp: string;
}

/**
 * Render one metric.
 *
 * `format` is supplied by the caller because the right rendering differs by
 * unit -- bytes want binary prefixes, milliseconds want a duration, ratios want
 * a percentage -- and this module must not guess which one a bare number wants.
 */
export function renderMetric<T>(
  metric: SystemMetric<T> | null | undefined,
  format: (value: T) => string,
): RenderedMetric {
  if (metric === null || metric === undefined) {
    return {
      text: null,
      reason: "the gateway did not include this metric in its response",
      unit: "",
      provenance: "UNAVAILABLE",
      source: "",
      estimate: false,
      timestamp: "",
    };
  }

  if (metric.provenance === "UNAVAILABLE" || metric.value === null) {
    // The reason is mandatory here. `UNAVAILABLE` with no reason is
    // indistinguishable from a collector that silently gave up, and the reader
    // has nothing to act on.
    return {
      text: null,
      reason: metric.reason ?? "this metric is unavailable and the gateway gave no reason",
      unit: metric.unit,
      provenance: "UNAVAILABLE",
      source: metric.source,
      estimate: false,
      timestamp: metric.timestamp,
    };
  }

  return {
    text: format(metric.value),
    /*
     * `reason` is carried for DERIVED values as well as UNAVAILABLE ones, and
     * this is why: a derived number is only defensible if its derivation is
     * recorded with it. Dropping it here would leave "42, DERIVED" on screen
     * with no way to check how, which is the same as presenting a guess.
     */
    reason: metric.reason ?? null,
    unit: metric.unit,
    provenance: metric.provenance,
    source: metric.source,
    estimate: metric.estimate === true,
    timestamp: metric.timestamp,
  };
}

/** The provenance label to show. Derived, so a metric's own flag drives it. */
export function provenanceLabel(rendered: RenderedMetric): string {
  switch (rendered.provenance) {
    case "OBSERVED":
      return rendered.estimate ? "OBSERVED (kernel estimate)" : "OBSERVED";
    case "DERIVED":
      return "DERIVED";
    default:
      /*
       * A default arm rather than an exhaustive case, so a provenance class the
       * gateway adds later degrades to the truthful "we cannot read this" instead
       * of falling off the end of the switch and reaching the reader as the
       * literal string "undefined".
       */
      return "UNAVAILABLE";
  }
}

/** Bytes in binary units, matching how procfs itself is conventionally read. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole numbers for bytes, one decimal above: "1.0 MiB" implies a precision
  // that a single procfs sample does not have, but "12 MiB" for 12,500,000
  // bytes would be wrong.
  return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`;
}

/** A signed or unsigned integer count with thousands separators. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}



/**
 * A temperature, rounded to one decimal.
 *
 * `°C` is spelled out rather than approximated with a bare degree sign because
 * the unit is part of the claim, and a temperature without its unit is ambiguous
 * with a ratio on a chart axis.
 */
export function formatCelsius(celsius: number): string {
  return `${celsius.toFixed(1)} °C`;
}

/** Millidegrees exactly as sysfs publishes them, with no conversion applied. */
export function formatMilliCelsius(milli: number): string {
  return `${formatCount(milli)} m°C`;
}

/**
 * Hertz, shown with the unit.
 *
 * Only ever used for a frequency the kernel actually reported. CAPS does not
 * measure hardware frequency, so a caller reaching this function with an
 * unavailable reading has a bug, and `renderMetric` is what prevents it.
 */
export function formatHertz(hz: number): string {
  /*
   * Three tiers, each dividing by the correct power of 1000.
   *
   * The one that is easy to get wrong is the middle one: Hz to MHz is 1e6, not
   * 1e3. Dividing by 1e3 renders an 800 MHz clock as "800,000 MHz", which is a
   * thousand-fold overstatement that still looks like a plausible figure.
   *
   * A kHz tier exists because cpufreq publishes kHz, so a sub-megahertz P-state
   * reading is real and rounding it to "1 MHz" would be a fabricated precision
   * in the other direction.
   */
  if (hz >= 1_000_000_000) return `${(hz / 1_000_000_000).toFixed(2)} GHz`;
  if (hz >= 1_000_000) return `${Math.round(hz / 1_000_000).toLocaleString("en-US")} MHz`;
  return `${Math.round(hz / 1_000).toLocaleString("en-US")} kHz`;
}

/** A duration from milliseconds, with the largest unit that stays readable. */
export function formatMilliseconds(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(2)} min`;
  return `${(ms / 3_600_000).toFixed(2)} h`;
}

/** A duration from kernel USER_HZ milliseconds, named as CPU time. */
export function formatCpuTime(ms: number): string {
  // CPU time and wall time are different quantities and the label says so: a
  // process blocked on I/O accrues no CPU time, and showing "0 ms" beside a
  // five-second wall clock reads like a measurement failure rather than an idle
  // process.
  return `${formatMilliseconds(ms)} CPU`;
}

/** True when the metric carries a value worth plotting. */
export function hasValue(rendered: RenderedMetric): boolean {
  return rendered.text !== null;
}

/**
 * A one-line summary for a panel header.
 *
 * States the reason rather than hiding it, so a panel whose data is absent says
 * so in the same place as one whose data is present.
 */
export function summariseMetric(rendered: RenderedMetric): string {
  if (rendered.text === null) return `Unavailable — ${rendered.reason ?? "no reason given"}`;
  return rendered.estimate
    ? `${rendered.text} ${rendered.unit} (kernel estimate)`
    : `${rendered.text} ${rendered.unit}`;
}

/**
 * Rate computation over two cumulative samples.
 *
 * Returns null when a rate cannot be stated, which is the honest answer in three
 * cases the caller must not paper over:
 *
 *   - either sample is missing;
 *   - the interval is not positive;
 *   - the counter went DOWN, which means the identity changed or the counter
 *     was reset. Zero-filling that produces a spike or a lie.
 */
export function ratePerSecond(
  previous: number | null,
  current: number | null,
  intervalMs: number | null,
): { value: number; note: string } | { value: null; note: string } {
  if (previous === null || current === null) {
    return { value: null, note: "a rate needs two valid samples; at least one is unavailable" };
  }
  if (intervalMs === null || intervalMs <= 0) {
    return { value: null, note: "a rate needs a positive interval between the two samples" };
  }
  if (current < previous) {
    // A decreasing cumulative counter means a reset, not a negative rate.
    return {
      value: null,
      note: `the counter decreased from ${previous} to ${current}, which indicates a reset or a different process; no rate is stated`,
    };
  }
  return { value: ((current - previous) / intervalMs) * 1000, note: `difference over ${Math.round(intervalMs)} ms` };
}

/**
 * Median of the values that exist.
 *
 * Returns null when none exist. It does NOT treat missing samples as zero: a
 * median over a set where half the readings are absent is not a median of that
 * population, and reporting it as one is the specific error this function exists
 * to avoid.
 */
export function median(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length === 0) return null;
  const sorted = [...present].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * A percentile by nearest-rank, over the values that exist.
 *
 * Nearest-rank rather than interpolated: with a small number of real samples an
 * interpolated p99 invents a value no observation ever took. `p` is a fraction.
 */
export function percentile(values: readonly (number | null)[], p: number): number | null {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length === 0) return null;
  if (p <= 0) return Math.min(...present);
  if (p >= 1) return Math.max(...present);
  const sorted = [...present].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

/** A statistical summary that always reports how much of the input was missing. */
export interface StatisticalSummary {
  sampleCount: number;
  /** How many inputs were null or non-finite. Reported, never absorbed. */
  missingCount: number;
  min: number | null;
  median: number | null;
  p95: number | null;
  p99: number | null;
  peak: number | null;
  /**
   * A sentence saying the summary covers part of the population.
   *
   * Present whenever anything was missing, because a reader seeing "median 42"
   * with no note has been told a population-level claim about a subset.
   */
  caveat: string | null;
}

export function summarise(values: readonly (number | null)[]): StatisticalSummary {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const missingCount = values.length - present.length;
  const caveat =
    missingCount === 0
      ? null
      : `Computed from ${present.length} of ${values.length} observations. ${missingCount} were unavailable and are excluded rather than counted as zero, so this describes the observed subset only.`;
  return {
    sampleCount: present.length,
    missingCount,
    min: present.length === 0 ? null : Math.min(...present),
    median: median(present),
    p95: percentile(present, 0.95),
    p99: percentile(present, 0.99),
    peak: present.length === 0 ? null : Math.max(...present),
    caveat,
  };
}
