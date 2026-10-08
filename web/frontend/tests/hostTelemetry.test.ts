/**
 * Host-telemetry rendering and statistics.
 *
 * Every assertion here exists because the alternative produces something that
 * looks correct and is not. Rendering `UNAVAILABLE` as zero yields a chart
 * indistinguishable from a real trace; averaging across missing samples as zeros
 * yields a mean no observation supports.
 */

import { describe, expect, it } from "vitest";

import type { SystemMetric } from "../src/api/observability";
import {
  formatBytes,
  formatCelsius,
  formatCpuTime,
  formatCount,
  formatHertz,
  formatMilliseconds,
  formatMilliCelsius,
  hasValue,
  median,
  percentile,
  provenanceLabel,
  ratePerSecond,
  renderMetric,
  summarise,
  summariseMetric,
} from "../src/lib/hostTelemetry";

/**
 * A metric fixture.
 *
 * The parameter type is deliberately `number` for the numeric cases and the
 * return type is `SystemMetric<T>`: a metric whose declared value type is
 * `number` but whose `value` is `null` is exactly the case under test, and
 * typing the null case as `SystemMetric<null>` would be a different type that
 * the product's own API never produces.
 */
function metric<T>(value: T | null, extra: Partial<SystemMetric<T>> = {}): SystemMetric<T> {
  const provenance = extra.provenance ?? (value === null ? "UNAVAILABLE" : "OBSERVED");
  return {
    value,
    unit: "1",
    source: "/proc/stat",
    timestamp: "2026-01-01T00:00:00.000Z",
    provenance,
    ...(value === null ? { reason: "this host exposes no such sensor" } : {}),
    ...extra,
  };
}

/** A numeric metric, spelled so the absent case keeps the right type. */
const numMetric = (value: number | null, extra: Partial<SystemMetric<number>> = {}): SystemMetric<number> =>
  metric<number>(value, extra);

describe("an unavailable metric renders as a reason, never as a number", () => {
  it("returns null text for an UNAVAILABLE metric", () => {
    const r = renderMetric(numMetric(null), formatCount);
    // The property that matters: not "0", not "—". `text === null` is what
    // stops a caller substituting a zero.
    expect(r.text).toBeNull();
    expect(r.text).not.toBe("0");
    expect(r.reason).toBe("this host exposes no such sensor");
  });

  it("keeps the gateway's reason verbatim", () => {
    const r = renderMetric(numMetric(null, { reason: "CONFIG_PSI is not enabled on this kernel" }), formatCount);
    expect(r.reason).toBe("CONFIG_PSI is not enabled on this kernel");
  });

  it("supplies a reason when the gateway omitted one", () => {
    // UNAVAILABLE with no reason is indistinguishable from a collector that
    // silently gave up, so the rendering says so rather than showing nothing.
    const r = renderMetric(
      { value: null, unit: "B", source: "/x", timestamp: "t", provenance: "UNAVAILABLE" } as SystemMetric<number>,
      formatCount,
    );
    expect(r.reason).toMatch(/no reason/i);
  });

  it("treats a missing metric object the same way", () => {
    expect(renderMetric(null, formatCount).text).toBeNull();
    expect(renderMetric(undefined, formatCount).provenance).toBe("UNAVAILABLE");
  });

  it("renders a DERIVED value with its provenance", () => {
    const r = renderMetric(numMetric(42, { provenance: "DERIVED", reason: "sum of per-core deltas" }), formatCount);
    expect(r.text).toBe("42");
    expect(provenanceLabel(r)).toBe("DERIVED");
    // The derivation is preserved, so the number can be checked.
    expect(r.reason).toBe("sum of per-core deltas");
  });

  it("marks a kernel estimate distinctly", () => {
    // MemAvailable is a kernel estimate; showing it as a plain OBSERVED reading
    // overstates its precision.
    const r = renderMetric(numMetric(1234, { estimate: true }), formatCount);
    expect(provenanceLabel(r)).toBe("OBSERVED (kernel estimate)");
    expect(summariseMetric(r)).toMatch(/kernel estimate/);
  });

  it("summarises an absent metric with its reason in the same place as a present one", () => {
    expect(summariseMetric(renderMetric(numMetric(10), formatCount))).toBe("10 1");
    expect(summariseMetric(renderMetric(numMetric(null), formatCount))).toMatch(/^Unavailable — /);
  });

  it("reports whether a metric is plottable", () => {
    expect(hasValue(renderMetric(numMetric(1), formatCount))).toBe(true);
    expect(hasValue(renderMetric(numMetric(null), formatCount))).toBe(false);
  });
});

describe("units are formatted so the number cannot be misread", () => {
  it("uses binary prefixes for bytes, as procfs is conventionally read", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1024 * 1024 * 32)).toBe("32.0 MiB");
  });

  it("does not imply precision the sample does not have", () => {
    // "1.0 KiB" reads as exactly one kibibyte; 1536 bytes is 1.5.
    expect(formatBytes(1536)).toBe("1.5 KiB");
  });

  it("spells out the temperature unit", () => {
    expect(formatCelsius(47.25)).toBe("47.3 °C");
  });

  it("shows millidegrees as the kernel publishes them", () => {
    expect(formatMilliCelsius(47000)).toBe("47,000 m°C");
  });

  it("never mis-scales the unit across three orders of magnitude", () => {
    // Hz to MHz is 1e6, not 1e3. Getting that wrong renders an 800 MHz clock as
    // "800,000 MHz" -- a thousand-fold overstatement that still reads as a
    // plausible figure, so no reader would catch it.
    expect(formatHertz(800_000_000), "800 MHz is 800,000,000 Hz").toBe("800 MHz");
    expect(formatHertz(3_400_000_000)).toBe("3.40 GHz");
    expect(formatHertz(1_000_000_000)).toBe("1.00 GHz");
    // cpufreq publishes kHz, so a sub-megahertz reading is real. Rounding it to
    // "1 MHz" would invent precision; kHz keeps the value honest.
    expect(formatHertz(800_000)).toBe("800 kHz");
    expect(formatHertz(2_400_000)).toBe("2 MHz");
  });

  it("labels CPU time as CPU time, distinct from wall clock", () => {
    // A process blocked on I/O accrues no CPU time. Showing "0 ms" beside a
    // five-second wall clock reads like a failure rather than an idle process.
    expect(formatCpuTime(0)).toBe("0 ms CPU");
    expect(formatCpuTime(1500)).toBe("1.50 s CPU");
  });

  it("picks a readable duration unit", () => {
    expect(formatMilliseconds(250)).toBe("250 ms");
    expect(formatMilliseconds(2_500)).toBe("2.50 s");
    expect(formatMilliseconds(120_000)).toBe("2.00 min");
  });

  /*
   * The old host-telemetry `formatPercent` inferred a unit from the magnitude:
   * `value > 0 && value <= 1 ? value * 100 : value`. procfs publishes CPU
   * utilisation already in percent, so a genuine 0.4% share rendered as "40.0%",
   * an error of two orders of magnitude on the one number the page exists to
   * report honestly. The function and its test are both gone; the app formats
   * percentages through `lib/format.ts`, which takes a percent and says so.
   */
});

describe("a rate is not stated when it cannot be computed honestly", () => {
  it("computes a rate from two valid samples", () => {
    const r = ratePerSecond(100, 300, 1000);
    expect(r.value).toBe(200);
    expect(r.note).toMatch(/1000 ms/);
  });

  it("states nothing when a sample is missing", () => {
    expect(ratePerSecond(null, 300, 1000).value).toBeNull();
    expect(ratePerSecond(100, null, 1000).value).toBeNull();
  });

  it("states nothing for a non-positive interval", () => {
    expect(ratePerSecond(100, 300, 0).value).toBeNull();
    expect(ratePerSecond(100, 300, null).value).toBeNull();
  });

  it("refuses to state a rate across a counter reset", () => {
    // Zero-filling a decrease produces a spike, and the spike is entirely
    // fabricated: it means the counter restarted, not that traffic happened.
    const r = ratePerSecond(500, 100, 1000);
    expect(r.value).toBeNull();
    expect(r.note).toMatch(/reset|different process/);
  });
});

describe("statistics never absorb a missing observation as zero", () => {
  it("computes a median over the values that exist", () => {
    expect(median([1, 2, 3])).toBe(2);
    // Even count: the midpoint, as the median of real observations.
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("excludes nulls rather than treating them as zero", () => {
    // If nulls became zeros, this would be 0. That is the whole error.
    expect(median([1, null, 3])).toBe(2);
  });

  it("returns null when nothing exists", () => {
    expect(median([])).toBeNull();
    expect(median([null, null])).toBeNull();
    expect(percentile([], 0.95)).toBeNull();
  });

  it("computes a percentile by nearest rank, not by interpolation", () => {
    // An interpolated p99 over 10 samples invents a value no sample took.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.95)).toBe(10);
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 1)).toBe(10);
  });

  it("ignores non-finite values", () => {
    // NaN and Infinity are not observations; letting one into a max produces
    // Infinity, which is a value no host reported.
    expect(median([1, Number.NaN, 3])).toBe(2);
    expect(summarise([1, Number.POSITIVE_INFINITY]).peak).toBe(1);
  });

  it("reports how much of the input was missing, and says so in the caveat", () => {
    const s = summarise([10, null, 20, null, 30]);
    expect(s.sampleCount).toBe(3);
    expect(s.missingCount).toBe(2);
    // A reader seeing "median 20" with no note has been given a
    // population-level claim about a subset.
    expect(s.caveat).toMatch(/3 of 5/);
    expect(s.caveat).toMatch(/rather than counted as zero/);
  });

  it("omits the caveat when nothing was missing", () => {
    expect(summarise([1, 2, 3]).caveat).toBeNull();
  });

  it("returns nulls throughout for an entirely unavailable series", () => {
    const s = summarise([null, null]);
    expect(s).toEqual({
      sampleCount: 0,
      missingCount: 2,
      min: null,
      median: null,
      p95: null,
      p99: null,
      peak: null,
      caveat: expect.stringContaining("0 of 2"),
    });
  });

  it("reports min, median, p95, p99 and peak consistently", () => {
    const s = summarise([5, 1, 9, 3, 7]);
    expect(s.min).toBe(1);
    expect(s.median).toBe(5);
    expect(s.peak).toBe(9);
    expect(s.p95).toBe(9);
    expect(s.p99).toBe(9);
  });
});
