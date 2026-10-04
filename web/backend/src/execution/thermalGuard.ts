/**
 * Thermal guard.
 *
 * WHAT THIS IS
 * ------------
 * An admission check that runs *before* a CAPS-owned workload is allowed to
 * start, comparing a real thermal sensor reading against configured thresholds
 * and, if necessary, refusing or terminating the workload.
 *
 * WHAT THIS IS NOT, AND WHY THAT MATTERS MORE
 * ------------------------------------------
 * It is not a thermal management system, and it deliberately has no ability to
 * become one. Specifically it never:
 *
 *   - writes to /sys/class/thermal, so it cannot lower a trip point;
 *   - writes to /sys/class/hwmon, so it cannot set a fan curve;
 *   - touches MSRs, so it cannot reprogram voltage or frequency limits;
 *   - signals any process it did not spawn, so it cannot "cool the machine"
 *     by killing someone else's work;
 *   - fabricates a temperature when no sensor exists.
 *
 * That last one is the constraint that shapes the whole module. A guard whose
 * input may be invented is not a guard. So discovery runs first and its result
 * is authoritative: on a machine with no sensor the guard reports UNAVAILABLE
 * with the reason, and it does not admit the workload *on the strength of an
 * absent reading*. Whether that refusal is the configured behaviour is a
 * config decision, stated plainly, never an implicit assumption.
 *
 * SCOPE
 * -----
 * The guard applies only to CAPS-owned workloads. It is an admission control
 * on work this gateway chose to start, so that a deliberate, attributable
 * decision exists before load is added. It is never a response to an
 * unrelated process's behaviour.
 *
 * UNITS AND PROVENANCE
 * --------------------
 * sysfs publishes temperatures in millidegrees. The raw value is what is read
 * and compared; the Celsius figure exists for thresholds and display. Every
 * decision record carries the sensor path it came from, the raw value, the
 * timestamp, the threshold crossed, and the action taken, so a decision can be
 * re-checked against the kernel by hand.
 */

import { discoverThermal, THERMAL_ABSENT_REASON } from "../telemetry/system/thermal.js";
import { readTrimmed, sysPath, type KernelPaths } from "../telemetry/system/read.js";
import type { ThermalSensor } from "../telemetry/system/types.js";
import { logger } from "../utils/logger.js";

/** What the guard does when a threshold is crossed. */
export type ThermalAction = "WARN" | "TERM" | "TERM_THEN_KILL";

export type GuardAvailability = "AVAILABLE" | "UNAVAILABLE";

/** Which sensor the operator selected. */
export type SensorSelector =
  | { readonly kind: "auto" }
  /** Match a kernel-reported sensor name exactly. */
  | { readonly kind: "name"; readonly name: string }
  /** Match a specific sysfs path, for an operator who knows the hardware. */
  | { readonly kind: "path"; readonly path: string }
  /** Only a sensor the kernel identifies as package-level. */
  | { readonly kind: "package" };

export interface ThermalGuardConfig {
  /** Explicit opt-in. The guard never protects anything unless asked. */
  enabled: boolean;
  sensor: SensorSelector;
  /** Celsius. At or above this, the action applies. */
  warningC: number;
  /** Celsius. At or above this, the action applies regardless of warningC. */
  criticalC: number;
  action: ThermalAction;
  /** Grace period between TERM and KILL for TERM_THEN_KILL, in ms. */
  termGraceMs: number;
}

export const DEFAULT_THERMAL_GUARD: ThermalGuardConfig = {
  // Off by default. A guard that silently alters what a workload does, on a
  // machine whose sensor may not exist, is a surprise rather than a safety
  // feature. Enabling it is a decision the operator makes with the thresholds.
  enabled: false,
  sensor: { kind: "auto" },
  warningC: 80,
  criticalC: 95,
  action: "WARN",
  termGraceMs: 2_000,
};

/** Where a reading came from, with enough precision to re-read it by hand. */
export interface GuardSensor {
  /** Kernel-reported sensor name, never invented. */
  name: string;
  /** Absolute sysfs path the value was read from. */
  path: string;
  sourceClass: "thermal_zone" | "hwmon";
  /** True only when the kernel's own metadata identifies a package sensor. */
  isPackage: boolean;
  /** Why this sensor was chosen, including how `auto` resolved. */
  selectionReason: string;
}

/** One reading, with every field needed to audit the decision. */
export interface GuardReading {
  /** Raw millidegrees exactly as sysfs published them. */
  rawMilliCelsius: number | null;
  celsius: number | null;
  timestamp: string;
  source: string;
  provenance: "OBSERVED" | "UNAVAILABLE";
  /** Present when the reading is UNAVAILABLE. Never empty. */
  reason?: string;
}

export type GuardDecision =
  | "ALLOW"
  | "WARN_ONLY"
  | "REFUSE_TERM"
  | "REFUSE_KILL"
  | "UNAVAILABLE_ALLOW"
  | "UNAVAILABLE_REFUSE"
  | "DISABLED";

/**
 * A complete, auditable record of one admission decision.
 *
 * Every field is populated even when the decision is trivially ALLOW, because
 * "nothing happened and here is why" is itself information an operator needs
 * when they ask why a workload started at all.
 */
export interface ThermalDecisionRecord {
  decision: GuardDecision;
  action: ThermalAction;
  /** Which threshold was crossed, or null when none was. */
  threshold: { kind: "warning" | "critical"; celsius: number } | null;
  sensor: GuardSensor | null;
  reading: GuardReading;
  timestamp: string;
  /** The workload this decision was about. */
  target: { kind: "CAPS_WORKLOAD"; workloadId: string | null; sessionId: string | null };
  /** What the guard actually did. `none` for ALLOW and for WARN_ONLY. */
  result: "NONE" | "WARNING_ISSUED" | "TERM_SENT" | "TERM_THEN_KILL_SENT";
  /** Always present. Explains the decision in one sentence. */
  reason: string;
}

export interface GuardState {
  availability: GuardAvailability;
  /** Present when UNAVAILABLE. Explains why no sensor can be used. */
  unavailableReason: string | null;
  /** Every sensor the kernel exposes, so the operator can see what exists. */
  discovered: Array<{ name: string; path: string; celsius: number | null; reason: string | null }>;
  selected: GuardSensor | null;
  config: ThermalGuardConfig;
}

/** Config problems that must refuse startup rather than be silently coerced. */
export function validateThermalGuardConfig(config: ThermalGuardConfig): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(config.warningC)) problems.push("warningC must be a finite number of degrees Celsius");
  if (!Number.isFinite(config.criticalC)) problems.push("criticalC must be a finite number of degrees Celsius");
  if (Number.isFinite(config.warningC) && Number.isFinite(config.criticalC) && config.warningC >= config.criticalC) {
    problems.push(
      `warningC (${config.warningC}) must be below criticalC (${config.criticalC}); otherwise every reading at or above the warning temperature is also critical and the warning threshold can never be observed in isolation`,
    );
  }
  if (config.warningC <= -273.15) problems.push("warningC is below absolute zero, which no sensor can report");
  if (config.termGraceMs < 0) problems.push("termGraceMs must not be negative");
  if (config.action === "TERM_THEN_KILL" && config.termGraceMs === 0) {
    problems.push(
      "TERM_THEN_KILL with termGraceMs 0 sends SIGTERM and SIGKILL with no interval, which is not a graceful termination; use TERM, or give the workload time to exit",
    );
  }
  return problems;
}

/**
 * Choose the sensor the guard will read.
 *
 * `auto` deliberately prefers a package sensor and falls back to the hottest
 * readable sensor. The preference is stated in the reason string rather than
 * applied silently, because "the hottest thing on the die" and "the package
 * sensor" are different questions and an operator deserves to know which one
 * they are getting.
 */
export function selectSensor(
  sensors: readonly ThermalSensor[],
  selector: SensorSelector,
  timestamp: string,
): { sensor: GuardSensor | null; reason: string } {
  const readable = sensors.filter((s) => s.rawMilliCelsius.value !== null);

  if (selector.kind === "path") {
    const match = sensors.find((s) => s.path === selector.path);
    if (match === undefined) {
      return {
        sensor: null,
        reason: `the configured sensor path ${selector.path} does not correspond to any sensor this host exposes. ${sensors.length} sensor(s) were discovered: ${sensors.map((s) => `${s.name} (${s.path})`).join(", ") || "none"}.`,
      };
    }
    return {
      sensor: {
        name: match.name,
        path: match.path,
        sourceClass: match.sourceClass,
        isPackage: match.isPackage.value === true,
        selectionReason: `selected explicitly by path: ${selector.path}`,
      },
      reason: `the sensor at ${selector.path} was selected explicitly by configuration`,
    };
  }

  if (selector.kind === "name") {
    const matches = sensors.filter((s) => s.name === selector.name);
    if (matches.length === 0) {
      return {
        sensor: null,
        reason: `no sensor named "${selector.name}" exists on this host. ${sensors.length} sensor(s) were discovered: ${sensors.map((s) => s.name).join(", ") || "none"}.`,
      };
    }
    if (matches.length > 1) {
      return {
        sensor: null,
        reason:
          `${matches.length} sensors are named "${selector.name}" (${matches.map((s) => s.path).join(", ")}), ` +
          `so the name does not identify one of them. Select by path instead, or by auto.`,
      };
    }
    return {
      sensor: {
        name: matches[0]!.name,
        path: matches[0]!.path,
        sourceClass: matches[0]!.sourceClass,
        isPackage: matches[0]!.isPackage.value === true,
        selectionReason: `selected explicitly by name: "${selector.name}"`,
      },
      reason: `the sensor named "${selector.name}" was selected explicitly by configuration`,
    };
  }

  if (selector.kind === "package") {
    const pkg = readable.filter((s) => s.isPackage.value === true);
    if (pkg.length === 0) {
      return {
        sensor: null,
        reason:
          sensors.length === 0
            ? "this host exposes no temperature sensor at all, so no package sensor can be selected"
            : `none of the ${sensors.length} discovered sensor(s) identifies itself as a package sensor. The kernel publishes: ${sensors.map((s) => `${s.name} (${s.kind.value ?? "untyped"})`).join(", ")}. Select by name or path instead.`,
      };
    }
    // Hottest package sensor, so a multi-socket host uses the worst one.
    const hottest = pkg.reduce((a, b) => (a.rawMilliCelsius.value! >= b.rawMilliCelsius.value! ? a : b));
    return {
      sensor: {
        name: hottest.name,
        path: hottest.path,
        sourceClass: hottest.sourceClass,
        isPackage: true,
        selectionReason: `selected because the kernel identifies "${hottest.name}" as a package sensor; it is the highest of ${pkg.length} package sensor(s)`,
      },
      reason: `a package sensor was required and "${hottest.name}" was the highest of ${pkg.length} available`,
    };
  }

  // auto
  if (readable.length === 0) {
    return {
      sensor: null,
      reason:
        sensors.length === 0
          ? `this host exposes no readable temperature sensor, so the guard has nothing to read. ${THERMAL_ABSENT_REASON}`
          : `all ${sensors.length} discovered sensor(s) exist but none produced a readable value, so the guard has nothing to read. A sensor that is present but unreadable is usually a driver that has unloaded, or a container that exposes a stub file.`,
    };
  }
  const pkg = readable.filter((s) => s.isPackage.value === true);
  if (pkg.length > 0) {
    const hottest = pkg.reduce((a, b) => (a.rawMilliCelsius.value! >= b.rawMilliCelsius.value! ? a : b));
    return {
      sensor: {
        name: hottest.name,
        path: hottest.path,
        sourceClass: hottest.sourceClass,
        isPackage: true,
        selectionReason: `auto-selection preferred the package sensor "${hottest.name}" because the kernel identifies it as package-level; it is the highest of ${pkg.length} package sensor(s)`,
      },
      reason: `auto-selection chose the package sensor "${hottest.name}" in preference to ${readable.length - pkg.length} non-package sensor(s)`,
    };
  }
  const hottest = readable.reduce((a, b) => (a.rawMilliCelsius.value! >= b.rawMilliCelsius.value! ? a : b));
  return {
    sensor: {
      name: hottest.name,
      path: hottest.path,
      sourceClass: hottest.sourceClass,
      isPackage: false,
      selectionReason: `auto-selection fell back to the highest readable sensor, "${hottest.name}", because no sensor on this host identifies itself as a package sensor`,
    },
    reason:
      `auto-selection chose the highest readable sensor, "${hottest.name}" (${hottest.path}). ` +
      `No sensor identifies itself as package-level on this host, so this is the hottest thing that was measured, not necessarily the CPU package.`,
  };
}

/** What the guard can do on this host, before any workload is considered. */
export function inspectThermalGuard(config: ThermalGuardConfig, paths: KernelPaths = { proc: "/proc", sys: "/sys" }): GuardState {
  const timestamp = new Date().toISOString();
  const snapshot = discoverThermal(paths, timestamp);
  const { sensor, reason } = selectSensor(snapshot.sensors, config.sensor, timestamp);

  return {
    availability: sensor === null ? "UNAVAILABLE" : "AVAILABLE",
    unavailableReason: sensor === null ? reason : null,
    discovered: snapshot.sensors.map((s) => ({
      name: s.name,
      path: s.path,
      celsius: s.celsius.value,
      reason: s.celsius.provenance === "UNAVAILABLE" ? (s.celsius.reason ?? "no reason recorded") : null,
    })),
    selected: sensor,
    config,
  };
}

/**
 * Re-read the selected sensor and decide.
 *
 * The read is a fresh sysfs read rather than a reuse of the discovery pass, so
 * a decision reflects the temperature at the moment the workload would start,
 * not at the moment the guard was constructed. Between the two the machine may
 * have warmed considerably, and a guard that decides on stale input is not
 * guarding anything.
 *
 * `now` and `readCelsius` are parameters so the decision table can be tested
 * against exact temperatures without having to heat a machine.
 */
export function evaluateThermalGuard(options: {
  config: ThermalGuardConfig;
  paths?: KernelPaths;
  /** Override the clock, for deterministic tests. */
  now?: string;
  /** Override the reading, for deterministic tests. */
  readSensor?: (sensor: GuardSensor, timestamp: string) => GuardReading;
  target?: { workloadId?: string | null; sessionId?: string | null };
}): ThermalDecisionRecord {
  const config = options.config;
  const paths = options.paths ?? { proc: "/proc", sys: "/sys" };
  const timestamp = options.now ?? new Date().toISOString();
  const target = {
    kind: "CAPS_WORKLOAD" as const,
    workloadId: options.target?.workloadId ?? null,
    sessionId: options.target?.sessionId ?? null,
  };

  const unavailableReading = (reason: string, source: string): GuardReading => ({
    rawMilliCelsius: null,
    celsius: null,
    timestamp,
    source,
    provenance: "UNAVAILABLE",
    reason,
  });

  if (!config.enabled) {
    return {
      decision: "DISABLED",
      action: config.action,
      threshold: null,
      sensor: null,
      reading: unavailableReading(
        "the thermal guard is disabled by configuration, so no sensor was read and no threshold was evaluated",
        "configuration",
      ),
      timestamp,
      target,
      result: "NONE",
      reason:
        `The thermal guard is disabled (CAPS_THERMAL_GUARD_ENABLED is false). The configured thresholds were not evaluated and no temperature was read. This decision is not evidence that the machine was cool.`,
    };
  }

  const state = inspectThermalGuard(config, paths);

  if (state.selected === null) {
    /*
     * No sensor. The reading is UNAVAILABLE and the decision is stated as such.
     *
     * The workload is allowed through, because "the guard cannot operate" is
     * not "the machine is too hot", and refusing every workload on a machine
     * with no sensor would make CAPS unusable under WSL2 and inside most VMs --
     * while claiming a safety property it does not have. What is refused is the
     * *claim*: the record says the guard did not operate, so nothing downstream
     * can treat this admission as thermally justified.
     */
    return {
      decision: "UNAVAILABLE_ALLOW",
      action: config.action,
      threshold: null,
      sensor: null,
      reading: unavailableReading(
        state.unavailableReason ?? "no sensor could be selected",
        "/sys/class/thermal, /sys/class/hwmon",
      ),
      timestamp,
      target,
      result: "NONE",
      reason:
        `The thermal guard is enabled but could not operate: ${state.unavailableReason ?? "no sensor could be selected"}. ` +
        `The workload was admitted because an absent sensor is not evidence of a hot machine, but this admission carries NO thermal justification. ` +
        `No temperature was read and none is reported.`,
    };
  }

  const sensor = state.selected;
  const reading = (options.readSensor ?? defaultReadSensor)(sensor, timestamp);

  if (reading.provenance === "UNAVAILABLE" || reading.celsius === null) {
    /*
     * The sensor was discovered but this read failed. Treated exactly like "no
     * sensor": admit, and record that the guard did not operate. A sensor that
     * vanished between discovery and decision is a real condition -- a driver
     * unloading, a container losing the mount -- and pretending a decision was
     * made would hide it.
     */
    return {
      decision: "UNAVAILABLE_ALLOW",
      action: config.action,
      threshold: null,
      sensor,
      reading,
      timestamp,
      target,
      result: "NONE",
      reason:
        `The selected sensor "${sensor.name}" (${sensor.path}) could not be read: ${reading.reason ?? "no reason recorded"}. ` +
        `The workload was admitted, but no threshold was evaluated and this admission carries no thermal justification.`,
    };
  }

  const celsius = reading.celsius;

  if (celsius >= config.criticalC) {
    const decision: GuardDecision = config.action === "WARN" ? "WARN_ONLY" : "REFUSE_KILL";
    return {
      decision,
      action: config.action,
      threshold: { kind: "critical", celsius: config.criticalC },
      sensor,
      reading,
      timestamp,
      target,
      result: config.action === "WARN" ? "WARNING_ISSUED" : "TERM_THEN_KILL_SENT",
      reason:
        `${celsius} °C on "${sensor.name}" (${sensor.path}) is at or above the critical threshold of ${config.criticalC} °C. ` +
        (config.action === "WARN"
          ? `The configured action is WARN, so the workload was allowed and a warning was issued. Note that WARN does not prevent a workload from running on a machine already at its critical temperature; set CAPS_THERMAL_GUARD_ACTION to TERM or TERM_THEN_KILL if that is not the intent.`
          : `The configured action is ${config.action}, so this CAPS-owned workload is not permitted to start and is terminated.`),
    };
  }

  if (celsius >= config.warningC) {
    const decision: GuardDecision = config.action === "WARN" ? "WARN_ONLY" : "REFUSE_TERM";
    return {
      decision,
      action: config.action,
      threshold: { kind: "warning", celsius: config.warningC },
      sensor,
      reading,
      timestamp,
      target,
      result: config.action === "WARN" ? "WARNING_ISSUED" : "TERM_SENT",
      reason:
        `${celsius} °C on "${sensor.name}" (${sensor.path}) is at or above the warning threshold of ${config.warningC} °C ` +
        `and below the critical threshold of ${config.criticalC} °C. ` +
        (config.action === "WARN"
          ? `The configured action is WARN, so the workload was allowed and a warning was issued.`
          : `The configured action is ${config.action}, so this CAPS-owned workload is not permitted to start.`),
    };
  }

  return {
    decision: "ALLOW",
    action: config.action,
    threshold: null,
    sensor,
    reading,
    timestamp,
    target,
    result: "NONE",
    reason:
      `${celsius} °C on "${sensor.name}" (${sensor.path}) is below the warning threshold of ${config.warningC} °C, so the workload was admitted.`,
  };
}

/**
 * Read one sysfs temperature file into a raw millidegree value.
 *
 * Exported because the guard's correctness rests entirely on what happens to
 * input the kernel should never produce, and testing that through the whole
 * decision path would couple the malformed-input tests to discovery. A driver
 * bug, a truncated write, or a container that exposes a stub file all arrive
 * here first.
 *
 * Returns `null` for anything that is not a plain non-negative integer. It
 * deliberately does not return 0, and does not clamp, round loosely, or fall
 * back to a previous reading: every one of those would convert "the sensor is
 * not reporting" into "the machine is freezing", which is the one conclusion a
 * thermal guard must never reach on its own.
 */
export function readSensorMilliCelsius(path: string): number | null {
  const raw = readTrimmed(path);
  if (!raw.ok) return null;
  const text = raw.text.trim();
  if (!/^\d{1,12}$/.test(text)) return null;
  const milli = Number(text);
  return Number.isSafeInteger(milli) ? milli : null;
}

/** Read the selected sensor's sysfs file as raw millidegrees. */
function defaultReadSensor(sensor: GuardSensor, timestamp: string): GuardReading {
  const milli = readSensorMilliCelsius(sensor.path);
  if (milli === null) {
    // Distinguish "the file is gone" from "the file is nonsense", because the
    // first is a driver or mount problem and the second is a driver bug, and an
    // operator debugging a guard needs to know which.
    const file = readTrimmed(sensor.path);
    const reason = file.ok
      ? `${sensor.path} contained ${JSON.stringify(file.text.trim().slice(0, 32))}, which is not a plain non-negative millidegree value. The reading is discarded rather than interpreted, because guessing a temperature from malformed input would defeat the purpose of the guard.`
      : `${sensor.path} could not be read: ${file.failure.reason}. The sensor may have been removed, or the driver may have been unloaded, between discovery and this decision.`;
    return {
      rawMilliCelsius: null,
      celsius: null,
      timestamp,
      source: sensor.path,
      provenance: "UNAVAILABLE",
      reason,
    };
  }
  return {
    rawMilliCelsius: milli,
    celsius: milli / 1000,
    timestamp,
    source: sensor.path,
    provenance: "OBSERVED",
  };
}

/** Where a guard decision should be published. Kept here so it cannot drift. */
export function thermalGuardLogFields(record: ThermalDecisionRecord): Record<string, unknown> {
  return {
    decision: record.decision,
    action: record.action,
    threshold: record.threshold === null ? null : `${record.threshold.kind}@${record.threshold.celsius}`,
    sensor: record.sensor === null ? null : `${record.sensor.name} (${record.sensor.path})`,
    celsius: record.reading.celsius,
    rawMilliCelsius: record.reading.rawMilliCelsius,
    target: record.target.workloadId ?? record.target.sessionId,
    result: record.result,
  };
}

/** Log a decision at the severity its outcome warrants. */
export function logThermalDecision(record: ThermalDecisionRecord): void {
  const fields = thermalGuardLogFields(record);
  if (record.decision === "ALLOW" || record.decision === "DISABLED") {
    logger.debug("SYSTEM", "thermal guard decision", fields);
  } else if (record.decision === "WARN_ONLY") {
    logger.warn("SYSTEM", "thermal guard warning", fields);
  } else if (record.decision === "UNAVAILABLE_ALLOW") {
    // Warned, not errored: the workload did start, and the guard did not
    // justify it. That deserves attention precisely because it is not fatal.
    logger.warn("SYSTEM", "thermal guard could not operate; workload admitted without thermal justification", fields);
  } else {
    logger.error("SYSTEM", "thermal guard refused a workload", fields);
  }
}

/** sysfs root the guard reads, exposed so tests can point it at a fixture. */
export function guardSysRoot(paths: KernelPaths): string {
  return sysPath(paths, "class");
}
