/**
 * Thermal guard: thresholds, sensor selection, and the admission decision.
 *
 * These are failure-mode tests first. The decision table has exactly one
 * interesting axis -- what the sensor says -- and every branch of it is a case
 * where a plausible-looking implementation would lie. The tests exist to pin
 * each of those lies shut:
 *
 *   - a missing sensor must not read as a cool machine
 *   - a malformed reading must not read as 0 °C
 *   - a sensor that vanished between discovery and decision must not read as a
 *     threshold evaluation that succeeded
 *   - WARN must be reported as WARN, not quietly upgraded to a refusal
 *
 * Where the host has no thermal sensor -- which under WSL2 is the normal case
 * -- the assertions run against injected readings and an injected sysfs tree, so
 * they hold on a laptop and in CI alike. The tests never require the machine to
 * be hot.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_THERMAL_GUARD,
  evaluateThermalGuard,
  inspectThermalGuard,
  readSensorMilliCelsius,
  selectSensor,
  validateThermalGuardConfig,
  type GuardReading,
  type GuardSensor,
  type ThermalGuardConfig,
} from "../../src/execution/thermalGuard.js";
import type { KernelPaths } from "../../src/telemetry/system/read.js";
import type { ThermalSensor } from "../../src/telemetry/system/types.js";

const roots: string[] = [];

/**
 * Build a synthetic sysfs tree.
 *
 * A fixture rather than the real /sys because the machine's sensors are not the
 * machine under test: this suite asserts behaviour at 40 °C and at 120 °C,
 * neither of which anyone can arrange on demand.
 */
function fakeSys(sensors: Array<{ zone: string; type?: string; milliCelsius: string }>): KernelPaths {
  const root = mkdtempSync(join(tmpdir(), "caps-thermal-"));
  roots.push(root);
  const sys = join(root, "sys");
  mkdirSync(join(sys, "class", "thermal"), { recursive: true });
  mkdirSync(join(sys, "class", "hwmon"), { recursive: true });

  sensors.forEach((s, i) => {
    const dir = join(sys, "class", "thermal", `thermal_zone${i}`);
    mkdirSync(dir, { recursive: true });
    if (s.type !== undefined) writeFileSync(join(dir, "type"), `${s.type}\n`);
    writeFileSync(join(dir, "temp"), `${s.milliCelsius}\n`);
    writeFileSync(join(dir, "max"), "100000\n");
  });
  return { proc: join(root, "proc"), sys };
}

/*
 * The two shared fixtures are built in `beforeAll` and removed in `afterAll`.
 *
 * Built at module scope and cleaned in `afterEach` -- which is the obvious
 * arrangement -- they are deleted by the end of the first test, so every
 * subsequent test silently sees an empty sysfs and every decision comes back
 * UNAVAILABLE. That failure mode is genuinely misleading: the suite reports a
 * thermal guard that cannot read any sensor, when the real problem is that the
 * test removed its own fixture.
 */
let COOL: KernelPaths;
let EMPTY: KernelPaths;

beforeAll(() => {
  COOL = fakeSys([{ zone: "0", type: "x86_pkg_temp", milliCelsius: "40000" }]);
  EMPTY = fakeSys([]);
});

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function config(overrides: Partial<ThermalGuardConfig> = {}): ThermalGuardConfig {
  return { ...DEFAULT_THERMAL_GUARD, enabled: true, warningC: 80, criticalC: 95, action: "WARN", ...overrides };
}

const SENSOR_X86: GuardSensor = {
  name: "x86_pkg_temp",
  path: "/sys/class/thermal/thermal_zone0/temp",
  sourceClass: "thermal_zone",
  isPackage: true,
  selectionReason: "test fixture",
};

/**
 * A reading at an exact temperature.
 *
 * The timestamp is a parameter rather than a constant because one audit test
 * asserts that the decision's timestamp -- the moment of the decision, passed
 * in as `now` -- is what appears on the record. A reader that stamps its own
 * constant would satisfy a weaker assertion and hide a real defect, where the
 * record's time and the decision's time disagree.
 */
function reading(celsius: number, sensor: GuardSensor = SENSOR_X86, timestamp = "2026-01-01T00:00:00.000Z"): GuardReading {
  const milli = Math.round(celsius * 1000);
  return { rawMilliCelsius: milli, celsius, timestamp, source: sensor.path, provenance: "OBSERVED" };
}

describe("thermal guard configuration is validated, not coerced", () => {
  it("accepts the shipped defaults", () => {
    expect(validateThermalGuardConfig(DEFAULT_THERMAL_GUARD)).toEqual([]);
  });

  it("refuses a warning threshold at or above critical", () => {
    // Otherwise every reading at the warning temperature is also critical, so
    // the warning branch is dead code and an operator tuning WARN would never
    // see the warning they configured.
    expect(validateThermalGuardConfig(config({ warningC: 95, criticalC: 95 }))).toContainEqual(
      expect.stringContaining("must be below criticalC"),
    );
  });

  it("refuses a below-absolute-zero threshold", () => {
    expect(validateThermalGuardConfig(config({ warningC: -400 }))).toContainEqual(
      expect.stringContaining("absolute zero"),
    );
  });

  it("refuses a non-finite threshold rather than comparing against NaN", () => {
    // NaN comparisons are always false, so a NaN threshold would silently make
    // every decision ALLOW.
    expect(validateThermalGuardConfig(config({ warningC: Number.NaN }))).toContainEqual(
      expect.stringContaining("finite"),
    );
  });

  it("refuses TERM_THEN_KILL with no grace period", () => {
    expect(validateThermalGuardConfig(config({ action: "TERM_THEN_KILL", termGraceMs: 0 }))).toContainEqual(
      expect.stringContaining("not a graceful termination"),
    );
  });

  it("is disabled by default, so nothing is protected unless asked", () => {
    // A guard that silently changes what a workload does, on a machine whose
    // sensor may not exist, is a surprise rather than a safety feature.
    expect(DEFAULT_THERMAL_GUARD.enabled).toBe(false);
  });
});

describe("sensor selection states which sensor it chose and why", () => {
  const sensor = (name: string, milli: number, isPackage: boolean, path = `/sys/x/${name}`): ThermalSensor =>
    ({
      name,
      rawMilliCelsius: { value: milli, unit: "m°C", source: path, timestamp: "t", provenance: "OBSERVED" },
      celsius: { value: milli / 1000, unit: "°C", source: path, timestamp: "t", provenance: "OBSERVED" },
      kind: { value: name, unit: "1", source: path, timestamp: "t", provenance: "OBSERVED" },
      sourceClass: "thermal_zone",
      path,
      maxCelsius: { value: null, unit: "°C", source: path, timestamp: "t", provenance: "UNAVAILABLE", reason: "none" },
      criticalCelsius: { value: null, unit: "°C", source: path, timestamp: "t", provenance: "UNAVAILABLE", reason: "none" },
      emergencyCelsius: { value: null, unit: "°C", source: path, timestamp: "t", provenance: "UNAVAILABLE", reason: "none" },
      isPackage: {
        value: isPackage,
        unit: "1",
        source: path,
        timestamp: "t",
        provenance: "OBSERVED",
        reason: isPackage ? "kernel metadata" : "not a package sensor",
      },
    }) as ThermalSensor;

  it("auto prefers a package sensor over a hotter non-package sensor", () => {
    const { sensor: chosen } = selectSensor(
      [sensor("acpitz", 90000, false), sensor("x86_pkg_temp", 50000, true)],
      { kind: "auto" },
      "t",
    );
    expect(chosen?.name).toBe("x86_pkg_temp");
    // The fallback to "hottest" is only correct because it is stated.
    expect(chosen?.selectionReason).toMatch(/package sensor/i);
  });

  it("auto says plainly when it fell back to the hottest sensor", () => {
    const { sensor: chosen, reason } = selectSensor(
      [sensor("acpitz", 70000, false), sensor("acpitz2", 90000, false)],
      { kind: "auto" },
      "t",
    );
    expect(chosen?.name).toBe("acpitz2");
    expect(chosen?.isPackage).toBe(false);
    // Without this sentence a reader would assume "CPU temperature".
    expect(reason).toMatch(/not necessarily the CPU package/i);
  });

  it("auto on a host with no readable sensor selects nothing", () => {
    const { sensor: chosen, reason } = selectSensor([], { kind: "auto" }, "t");
    expect(chosen).toBeNull();
    expect(reason).toMatch(/no readable temperature sensor/i);
  });

  it("refuses a selector naming a sensor that does not exist", () => {
    const { sensor: chosen, reason } = selectSensor([sensor("acpitz", 40000, false)], { kind: "name", name: "k10temp" }, "t");
    expect(chosen).toBeNull();
    expect(reason).toMatch(/no sensor named "k10temp"/);
    // The reason lists what does exist, so the operator can fix the config.
    expect(reason).toContain("acpitz");
  });

  it("refuses an ambiguous name rather than picking one arbitrarily", () => {
    const { sensor: chosen, reason } = selectSensor(
      [sensor("core", 40000, false, "/sys/a"), sensor("core", 50000, false, "/sys/b")],
      { kind: "name", name: "core" },
      "t",
    );
    expect(chosen).toBeNull();
    expect(reason).toMatch(/does not identify one of them/);
  });

  it("refuses a package selector when nothing identifies as package", () => {
    const { sensor: chosen, reason } = selectSensor([sensor("acpitz", 40000, false)], { kind: "package" }, "t");
    expect(chosen).toBeNull();
    expect(reason).toMatch(/none of the 1 discovered sensor/i);
  });
});

describe("the decision table", () => {
  it("ALLOWs below the warning threshold", () => {
    const r = evaluateThermalGuard({ config: config(), paths: COOL, readSensor: () => reading(40) });
    expect(r.decision).toBe("ALLOW");
    expect(r.threshold).toBeNull();
    expect(r.result).toBe("NONE");
    expect(r.reading.celsius).toBe(40);
  });

  it("WARNs at exactly the warning threshold", () => {
    // Boundary case: "at or above" is the rule, and 80.0001 would be wrong.
    const r = evaluateThermalGuard({ config: config(), paths: COOL, readSensor: () => reading(80) });
    expect(r.decision).toBe("WARN_ONLY");
    expect(r.threshold).toEqual({ kind: "warning", celsius: 80 });
    expect(r.result).toBe("WARNING_ISSUED");
  });

  it("does not warn one hundredth of a degree below the threshold", () => {
    const r = evaluateThermalGuard({ config: config(), paths: COOL, readSensor: () => reading(79.99) });
    expect(r.decision).toBe("ALLOW");
  });

  it("escalates to the critical threshold and reports it as critical", () => {
    const r = evaluateThermalGuard({ config: config(), paths: COOL, readSensor: () => reading(95) });
    expect(r.decision).toBe("WARN_ONLY");
    // Critical with WARN configured is still only a warning, but the record
    // must name which threshold was crossed.
    expect(r.threshold).toEqual({ kind: "critical", celsius: 95 });
    expect(r.reason).toMatch(/WARN does not prevent a workload from running/);
  });

  it("terminates at the warning threshold when the action is TERM", () => {
    const r = evaluateThermalGuard({
      config: config({ action: "TERM" }),
      paths: COOL,
      readSensor: () => reading(85),
    });
    expect(r.decision).toBe("REFUSE_TERM");
    expect(r.result).toBe("TERM_SENT");
    expect(r.threshold?.kind).toBe("warning");
  });

  it("kills at the critical threshold when the action is TERM_THEN_KILL", () => {
    const r = evaluateThermalGuard({
      config: config({ action: "TERM_THEN_KILL", termGraceMs: 2_000 }),
      paths: COOL,
      readSensor: () => reading(110),
    });
    expect(r.decision).toBe("REFUSE_KILL");
    expect(r.result).toBe("TERM_THEN_KILL_SENT");
    expect(r.threshold?.kind).toBe("critical");
  });
});

describe("an absent sensor is never reported as a cool machine", () => {

  it("reports UNAVAILABLE and admits the workload without claiming cool", () => {
    const r = evaluateThermalGuard({ config: config(), paths: EMPTY });
    expect(r.decision).toBe("UNAVAILABLE_ALLOW");
    expect(r.reading.provenance).toBe("UNAVAILABLE");
    expect(r.reading.celsius).toBeNull();
    // Null, never 0. Zero degrees is a claim.
    expect(r.reading.celsius).not.toBe(0);
    expect(r.threshold).toBeNull();
    // The refusal to claim is stated explicitly, because this is the case a
    // naive implementation turns into "0 °C, therefore fine".
    expect(r.reason).toMatch(/NO thermal justification/i);
    expect(r.reading.reason?.length).toBeGreaterThan(20);
  });

  it("explains WSL2 and VMs as expected rather than as a fault", () => {
    const r = evaluateThermalGuard({ config: config(), paths: EMPTY });
    expect(r.reading.reason).toMatch(/WSL2|virtual/i);
  });

  it("a disabled guard reads no sensor at all", () => {
    const r = evaluateThermalGuard({ config: config({ enabled: false }), paths: COOL });
    expect(r.decision).toBe("DISABLED");
    expect(r.sensor).toBeNull();
    expect(r.reading.celsius).toBeNull();
    // And it says that not-cool is not established.
    expect(r.reason).toMatch(/not evidence that the machine was cool/i);
  });

  it("a sensor that exists but cannot be read is treated as unavailable", () => {
    // The driver unloaded, or the container lost the mount, between discovery
    // and the decision. Pretending a threshold was evaluated hides it.
    const paths = fakeSys([{ zone: "0", type: "x86_pkg_temp", milliCelsius: "40000" }]);
    const r = evaluateThermalGuard({
      config: config(),
      paths,
      readSensor: () => ({
        rawMilliCelsius: null,
        celsius: null,
        timestamp: "t",
        source: SENSOR_X86.path,
        provenance: "UNAVAILABLE",
        reason: "the sensor file was removed between discovery and the decision",
      }),
    });
    expect(r.decision).toBe("UNAVAILABLE_ALLOW");
    expect(r.threshold).toBeNull();
    expect(r.reason).toMatch(/no threshold was evaluated/i);
  });

  it("a sensor whose file is nonsense is discovered but not usable", () => {
    /*
     * The zone exists and the kernel publishes a type, so discovery reports it.
     * The value, though, is not a number, so no temperature can be stated.
     *
     * Asserted through the decision rather than through the reader because that
     * is the observable behaviour: no threshold is evaluated, and the admission
     * carries no thermal justification. A guard that quietly treated the bad
     * value as zero would report "ALLOW, the machine is freezing".
     */
    const paths = fakeSys([{ zone: "0", type: "x86_pkg_temp", milliCelsius: "not-a-number" }]);
    const state = inspectThermalGuard(config(), paths);
    expect(state.discovered).toHaveLength(1);
    expect(state.discovered[0]?.celsius).toBeNull();

    const r = evaluateThermalGuard({ config: config(), paths });
    expect(r.decision).toBe("UNAVAILABLE_ALLOW");
    expect(r.reading.provenance).toBe("UNAVAILABLE");
    expect(r.reading.celsius).toBeNull();
    expect(r.threshold).toBeNull();
    expect(r.reason).toMatch(/no thermal justification/i);
  });
});

describe("the raw reader refuses anything that is not a plain integer", () => {
  // Tested directly rather than through the decision path, because this is
  // where malformed kernel input is first handled and the decision tests above
  // would couple every parse rule to discovery.
  const write = (contents: string): string => {
    const root = mkdtempSync(join(tmpdir(), "caps-sensor-"));
    roots.push(root);
    const file = join(root, "temp");
    writeFileSync(file, contents);
    return file;
  };

  it("accepts the millidegree values sysfs actually publishes", () => {
    expect(readSensorMilliCelsius(write("40000\n"))).toBe(40_000);
    expect(readSensorMilliCelsius(write("0\n"))).toBe(0);
    expect(readSensorMilliCelsius(write("0"))).toBe(0);
  });

  it("refuses negative, fractional, empty, and non-decimal input", () => {
    // Each of these is null rather than 0 or NaN. Zero would be the dangerous
    // answer: it is a real temperature reading, and far below any threshold.
    for (const bad of ["-5000", "1.5", "", "   ", "0x20", "4e4", "40000C", "NaN", "Infinity"]) {
      expect(readSensorMilliCelsius(write(bad)), `"${bad}" must not become a temperature`).toBeNull();
    }
  });

  it("refuses a file that does not exist", () => {
    expect(readSensorMilliCelsius(join(tmpdir(), "caps-does-not-exist-thermal"))).toBeNull();
  });

  it("refuses an absurdly long digit string rather than losing precision", () => {
    // Beyond 12 digits the value cannot be represented exactly, so accepting it
    // would silently report a rounded temperature.
    expect(readSensorMilliCelsius(write("9".repeat(20)))).toBeNull();
  });
});

describe("every decision is auditable", () => {
  it("carries the sensor, the raw value, the timestamp and the threshold", () => {
    const r = evaluateThermalGuard({
      config: config({ action: "TERM" }),
      paths: COOL,
      now: "2026-02-03T04:05:06.000Z",
      readSensor: (sensor) => reading(88, sensor, "2026-02-03T04:05:06.000Z"),
      target: { workloadId: "caps_cpu_burn" },
    });
    // Discovery reads the real fixture path, which lives under the temporary
    // sysfs root this suite built. Asserting the structure rather than the
    // literal string keeps the assertion meaningful without pinning a temp name.
    expect(r.sensor?.path).toMatch(/class[/\\]thermal[/\\]thermal_zone0[/\\]temp$/);
    expect(r.sensor?.name).toBe("x86_pkg_temp");
    expect(r.sensor?.isPackage).toBe(true);
    expect(r.reading.rawMilliCelsius).toBe(88_000);
    expect(r.reading.timestamp).toBe("2026-02-03T04:05:06.000Z");
    expect(r.threshold).toEqual({ kind: "warning", celsius: 80 });
    expect(r.target).toEqual({ kind: "CAPS_WORKLOAD", workloadId: "caps_cpu_burn", sessionId: null });
    expect(r.reason.length).toBeGreaterThan(30);
  });

  it("scopes itself to CAPS-owned work", () => {
    const r = evaluateThermalGuard({ config: config(), paths: COOL, readSensor: () => reading(40) });
    // The guard is an admission control on work this gateway spawned. It is
    // never a response to an unrelated process, and the record says so.
    expect(r.target.kind).toBe("CAPS_WORKLOAD");
  });

  it("re-reads the sensor rather than reusing discovery", () => {
    // A guard deciding on input captured when it was constructed is not
    // guarding the moment of admission.
    let reads = 0;
    evaluateThermalGuard({
      config: config(),
      paths: COOL,
      readSensor: () => {
        reads += 1;
        return reading(40);
      },
    });
    expect(reads).toBe(1);
  });
});

describe("host inspection reports state without acting", () => {
  it("reports UNAVAILABLE with the discovered sensors listed on this host", () => {
    const state = inspectThermalGuard(config(), EMPTY);
    expect(state.availability).toBe("UNAVAILABLE");
    expect(state.unavailableReason?.length).toBeGreaterThan(20);
    expect(state.selected).toBeNull();
  });

  it("reports AVAILABLE and names the sensor when one exists", () => {
    const state = inspectThermalGuard(config(), COOL);
    expect(state.availability).toBe("AVAILABLE");
    expect(state.selected?.name).toBe("x86_pkg_temp");
    expect(state.discovered).toHaveLength(1);
    expect(state.discovered[0]?.celsius).toBe(40);
  });
});
