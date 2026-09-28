import { COUNTER_RATES, RATE_METRIC_KEYS, type Metric, type ProcessSnapshot } from "./types.js";

/**
 * Why a rate is missing when there is nothing to compare against. A rate is a
 * statement about a measured interval, so the very first sample of a process
 * reports no rate at all rather than an invented zero.
 */
export const FIRST_SAMPLE_RATE_REASON =
  "First sample for this process: a rate needs two valid samples separated by a measured interval";

/**
 * Fill every cross-sample rate metric from the previous accepted sample.
 *
 * Rules, all of them observable:
 *  - no previous sample, or no measured interval: UNAVAILABLE (first sample);
 *  - either side of the pair is UNAVAILABLE: UNAVAILABLE (field not observed);
 *  - a cumulative counter that decreased: UNAVAILABLE (counter reset or a
 *    different process), never a negative rate;
 *  - a flat counter is a real measured rate of 0.
 *
 * `wallMs` must come from a monotonic clock measured across the two samples.
 */
export function deriveRates(
  current: ProcessSnapshot,
  previous: ProcessSnapshot | null,
  wallMs: number | null,
): ProcessSnapshot {
  const out: ProcessSnapshot = { ...current };

  if (previous === null || wallMs === null || !(wallMs > 0)) {
    for (const key of RATE_METRIC_KEYS) out[key] = unavailable(current[key], FIRST_SAMPLE_RATE_REASON);
    return out;
  }

  const seconds = wallMs / 1000;
  out.cpuPercent = deriveCpuPercent(current, previous, wallMs);

  for (const { key, rate, unit } of COUNTER_RATES) {
    const now = current[key].value;
    const before = previous[key].value;
    if (now === null || before === null) {
      out[rate] = unavailable(current[rate], `Counter ${key} was unavailable in one of the two samples; no ${unit} rate is reported`);
    } else if (now < before) {
      out[rate] = unavailable(current[rate], `Counter ${key} decreased between samples (${before} then ${now}); no ${unit} rate is reported`);
    } else {
      out[rate] = {
        value: (now - before) / seconds,
        provenance: "DERIVED",
        source: `delta(${current[key].source}) / delta(sample wall time) in ${unit}`,
      };
    }
  }

  return out;
}

/**
 * Process CPU utilization as a percentage of one core. The kernel exposes
 * cumulative user/system time, so utilization only exists between two valid
 * samples; it can exceed 100% for a process running on several threads.
 */
export function deriveCpuPercent(
  current: ProcessSnapshot,
  previous: ProcessSnapshot,
  wallMs: number,
): Metric<number> {
  const user = current.cpuUserMs.value;
  const system = current.cpuSystemMs.value;
  const priorUser = previous.cpuUserMs.value;
  const priorSystem = previous.cpuSystemMs.value;
  if (user === null || system === null || priorUser === null || priorSystem === null) {
    return unavailable(current.cpuPercent, "CPU time was unavailable in one of the two samples; no utilization is reported");
  }
  const deltaMs = user + system - (priorUser + priorSystem);
  return {
    value: Math.max(0, (deltaMs / wallMs) * 100),
    provenance: "DERIVED",
    source: "delta(/proc/<pid>/stat utime+stime) / delta(sample wall time), percent of one core",
  };
}

function unavailable<T>(metric: Metric<T>, reason: string): Metric<T> {
  return { value: null, provenance: "UNAVAILABLE", source: metric.source, reason };
}
