/**
 * Thermal discovery from `/sys/class/thermal` and `/sys/class/hwmon`.
 *
 * WHAT THIS MODULE WILL NOT DO
 * ---------------------------
 * It will not invent a CPU temperature. There is no default, no fallback, and
 * no synthetic curve. A machine that exposes no temperature sensor produces
 * `sensors: []`, an UNAVAILABLE `highestCelsius`, and an explicit
 * `availability` sentence, and the UI renders that sentence instead of a chart.
 *
 * The failure mode this prevents is the one that makes dashboards untrustworthy:
 * a graph that starts at a plausible 45 degrees and rises with CPU load. It
 * looks exactly like a real thermal trace, and it is fabricated, and nobody can
 * tell by looking. Under WSL2, inside most VMs, and on a great deal of embedded
 * hardware, no such sensor exists and the correct answer is to say so.
 *
 * NAMING RULES
 * ------------
 * A sensor is labelled with what the kernel calls it: `x86_pkg_temp`,
 * `Core 0`, `acpitz`, `thermal_zone3`, or a hwmon `tempN_label`. The label
 * "CPU Temperature" is only used when the kernel's own metadata identifies the
 * sensor as a package sensor, and even then `isPackage` is a derived judgement
 * that says so in its reason string.
 *
 * UNITS
 * -----
 * Every reading is stored raw in millidegrees exactly as sysfs publishes it
 * (`47000`), and converted to Celsius exactly once, in `celsius`, at the edge
 * of the payload. Nothing downstream divides by 1000 again.
 */

import { readTrimmed, readUintFile, readIntFile, listMatching, sysPath, type KernelPaths } from "./read.js";
import { derived, observed, unavailable, type SystemMetric, type ThermalSensor, type ThermalSnapshot, type ThermalTripPoint } from "./types.js";

/** Why a machine may expose no usable temperature, stated for the UI. */
export const THERMAL_ABSENT_REASON =
  "No supported temperature sensor is exposed by this Linux environment. /sys/class/thermal contains no thermal zones and /sys/class/hwmon exposes no temperature inputs. This is the expected result under WSL2, inside most virtual machines, and on hardware whose driver does not publish a thermal sensor. CAPS does not synthesise a temperature from CPU load, because such a curve would be indistinguishable from a measurement while being entirely invented.";

/** sysfs reports Celsius in thousandths of a degree. */
const MILLIDEGREES = 1000;

/**
 * hwmon attribute suffixes this module understands, in the order Linux
 * conventionally numbers them. `label` is absent on drivers that do not name
 * their inputs, in which case the index plus the hwmon `name` is the identity.
 */
const HW_TEMP_SUFFIXES = ["input", "max", "crit", "emergency", "label"] as const;

/** Read a millidegree file into a Celsius metric, or explain the absence. */
function milliToCelsius(raw: number | null, path: string, timestamp: string, what: string): SystemMetric<number> {
  if (raw === null) {
    return unavailable<number>(
      "°C",
      path,
      timestamp,
      `${what}: this sysfs file could not be read as a millidegree value (missing, unreadable, or not an integer)`,
    );
  }
  return derived(
    raw / MILLIDEGREES,
    "°C",
    path,
    timestamp,
    `${raw} millidegrees Celsius as published by sysfs, divided by 1000 for display. The raw value is retained in rawMilliCelsius.`,
  );
}

/**
 * `type` values Linux uses that identify a package (whole-chip) sensor.
 *
 * Used only to populate `isPackage`, and only as a judgement with a stated
 * reason. A sensor that matches none of these is not assumed to be a package
 * sensor; it is reported under its own name and `isPackage` is false.
 */
const PACKAGE_TYPE_PATTERNS: readonly RegExp[] = [
  /^x86_pkg_temp$/i,
  /^coretemp$/i,
  /^k10temp$/i,
  /^k8temp$/i,
  /^zenpower$/i,
  /^cpu_thermal$/i,
  /^soc_thermal$/i,
  /^package[ _-]?id[ _-]?\d*$/i,
  /^tdie$/i,
  /^cpus$/i,
];

function looksLikePackage(typeText: string | null, labelText: string | null): { match: boolean; reason: string } {
  const candidates = [labelText, typeText].filter((v): v is string => v !== null && v.trim() !== "");
  if (candidates.length === 0) {
    return { match: false, reason: "The driver published neither a sensor type nor a label, so there is no kernel metadata identifying this as a package sensor" };
  }
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    for (const pattern of PACKAGE_TYPE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          match: true,
          reason: `The kernel identifies this sensor as a package-level sensor: ${pattern.source} matches "${trimmed}". This is a naming match against sysfs metadata, not a claim about which silicon die was measured.`,
        };
      }
    }
  }
  return {
    match: false,
    reason: `The kernel names this sensor "${candidates[0]}", which does not identify a package sensor. It is reported under its own name and is never relabelled as "CPU Temperature".`,
  };
}

// ---------------------------------------------------------------------------
// hwmon
// ---------------------------------------------------------------------------

interface HwmonSensor {
  name: string;
  label: string | null;
  inputPath: string;
  max: number | null;
  crit: number | null;
  emergency: number | null;
  hwName: string;
}

/** Discover temperature inputs under one `/sys/class/hwmon/hwmonN` directory. */
function discoverHwmonSensors(paths: KernelPaths, hwmonDir: string, timestamp: string): { sensors: HwmonSensor[]; hwName: string | null } {
  const nameResult = readTrimmed(`${hwmonDir}/name`);
  const hwName = nameResult.ok && nameResult.text !== "" ? nameResult.text : null;

  // A driver may publish several inputs: temp1_input, temp2_input, ...
  const inputs = ["temp1", "temp2", "temp3", "temp4", "temp5", "temp6", "temp7", "temp8"];
  const sensors: HwmonSensor[] = [];
  for (const prefix of inputs) {
    const inputPath = `${hwmonDir}/${prefix}_input`;
    const raw = readUintFile(inputPath);
    if (raw === null) continue;

    const labelResult = readTrimmed(`${hwmonDir}/${prefix}_label`);
    const label = labelResult.ok && labelResult.text !== "" ? labelResult.text : null;

    sensors.push({
      // Identity is the label when the driver provides one, else the hwmon
      // name plus the input index. Never a synthesized "CPU temperature".
      name: label ?? (hwName !== null ? `${hwName} ${prefix}` : prefix),
      label,
      inputPath,
      max: readUintFile(`${hwmonDir}/${prefix}_max`),
      crit: readUintFile(`${hwmonDir}/${prefix}_crit`),
      emergency: readUintFile(`${hwmonDir}/${prefix}_emergency`),
      hwName: hwName ?? "",
    });
  }
  return { sensors, hwName };
}

// ---------------------------------------------------------------------------
// thermal zones
// ---------------------------------------------------------------------------

/** Discover the trip points a thermal zone's policy references. */
function discoverTripPoints(zoneDir: string, zone: string, timestamp: string): ThermalTripPoint[] {
  const listed = listMatching(zoneDir, /^trip_point_\d+_type$/);
  if (!listed.ok) return [];

  const points: ThermalTripPoint[] = [];
  for (const entry of listed.entries) {
    const index = Number(/^trip_point_(\d+)_type$/.exec(entry)?.[1]);
    if (!Number.isSafeInteger(index)) continue;

    const typePath = `${zoneDir}/${entry}`;
    const typeResult = readTrimmed(typePath);
    const tempPath = `${zoneDir}/trip_point_${index}_temp`;
    const tempRaw = readUintFile(tempPath);
    const deviceResult = readTrimmed(`${zoneDir}/trip_point_${index}_device`);

    points.push({
      zone,
      index,
      type: typeResult.ok
        ? observed(typeResult.text, "1", typePath, timestamp, "Trip point type as named by the thermal governor")
        : unavailable<string>("1", typePath, timestamp, "Trip point type could not be read"),
      temperatureCelsius:
        tempRaw === null
          ? unavailable<number>("°C", tempPath, timestamp, "Trip point temperature could not be read")
          : derived(tempRaw / MILLIDEGREES, "°C", tempPath, timestamp, `${tempRaw} millidegrees Celsius from sysfs, divided by 1000`),
      device: deviceResult.ok
        ? observed(deviceResult.text, "1", `${zoneDir}/trip_point_${index}_device`, timestamp, "Cooling device the policy uses for this trip point")
        : unavailable<string>("1", `${zoneDir}/trip_point_${index}_device`, timestamp, "This trip point references no cooling device"),
    });
  }
  return points.sort((a, b) => a.index - b.index);
}

/**
 * Discover and read every temperature sensor the kernel exposes.
 *
 * Both classes are read because a driver may appear in only one:
 * `/sys/class/thermal/thermal_zoneN` is the ACPI-style interface, and
 * `/sys/class/hwmon/hwmonN` is what most x86 and ARM drivers use. Reading only
 * one would report "no sensor" on a machine that plainly has one.
 */
export function discoverThermal(paths: KernelPaths, timestamp: string): ThermalSnapshot {
  const sensors: ThermalSensor[] = [];
  const tripPoints: ThermalTripPoint[] = [];

  // --- thermal zones -------------------------------------------------------
  const zoneRoot = sysPath(paths, "class", "thermal");
  const zones = listMatching(zoneRoot, /^thermal_zone\d+$/);
  if (zones.ok) {
    for (const zone of zones.entries) {
      const zoneDir = `${zoneRoot}/${zone}`;
      const typeResult = readTrimmed(`${zoneDir}/type`);
      const zoneType = typeResult.ok ? typeResult.text : null;
      const tempPath = `${zoneDir}/temp`;
      const raw = readUintFile(tempPath);

      const label = zoneType ?? zone;
      const packageJudgement = looksLikePackage(zoneType, null);

      sensors.push({
        name: label,
        rawMilliCelsius:
          raw === null
            ? unavailable<number>("m°C", tempPath, timestamp, "Zone temperature could not be read")
            : observed(raw, "m°C", tempPath, timestamp, "Raw millidegree value as published by sysfs"),
        celsius: milliToCelsius(raw, tempPath, timestamp, "Zone temperature"),
        kind:
          zoneType !== null
            ? observed(zoneType, "1", `${zoneDir}/type`, timestamp, "Thermal zone type as named by the kernel")
            : unavailable<string>("1", `${zoneDir}/type`, timestamp, "This zone publishes no type file"),
        sourceClass: "thermal_zone",
        path: tempPath,
        maxCelsius: milliToCelsius(readUintFile(`${zoneDir}/max`), `${zoneDir}/max`, timestamp, "Zone maximum"),
        criticalCelsius: unavailable<number>("°C", `${zoneDir}`, timestamp, "thermal_zone directories publish no crit attribute; the trip points carry the critical thresholds"),
        emergencyCelsius: unavailable<number>("°C", `${zoneDir}`, timestamp, "thermal_zone directories publish no emergency attribute"),
        isPackage: packageJudgement.match
          ? observed(true, "1", `${zoneDir}/type`, timestamp, packageJudgement.reason)
          : observed(false, "1", `${zoneDir}/type`, timestamp, packageJudgement.reason),
      });

      tripPoints.push(...discoverTripPoints(zoneDir, zone, timestamp));
    }
  }

  // --- hwmon ---------------------------------------------------------------
  const hwmonRoot = sysPath(paths, "class", "hwmon");
  const hwmons = listMatching(hwmonRoot, /^hwmon\d+$/);
  if (hwmons.ok) {
    for (const hwmon of hwmons.entries) {
      const hwmonDir = `${hwmonRoot}/${hwmon}`;
      const { sensors: hwSensors } = discoverHwmonSensors(paths, hwmonDir, timestamp);
      for (const sensor of hwSensors) {
        const raw = readUintFile(sensor.inputPath);
        const packageJudgement = looksLikePackage(sensor.hwName, sensor.label);
        sensors.push({
          name: sensor.name,
          rawMilliCelsius:
            raw === null
              ? unavailable<number>("m°C", sensor.inputPath, timestamp, "Sensor input could not be read")
              : observed(raw, "m°C", sensor.inputPath, timestamp, "Raw millidegree value as published by sysfs"),
          celsius: milliToCelsius(raw, sensor.inputPath, timestamp, "Sensor reading"),
          kind:
            sensor.hwName !== ""
              ? observed(sensor.hwName, "1", `${hwmonDir}/name`, timestamp, "hwmon driver name as published by the kernel")
              : unavailable<string>("1", `${hwmonDir}/name`, timestamp, "This hwmon device publishes no name attribute"),
          sourceClass: "hwmon",
          path: sensor.inputPath,
          maxCelsius: milliToCelsius(sensor.max, sensor.inputPath.replace("_input", "_max"), timestamp, "Sensor maximum"),
          criticalCelsius: milliToCelsius(sensor.crit, sensor.inputPath.replace("_input", "_crit"), timestamp, "Sensor critical threshold"),
          emergencyCelsius: milliToCelsius(sensor.emergency, sensor.inputPath.replace("_input", "_emergency"), timestamp, "Sensor emergency threshold"),
          isPackage: packageJudgement.match
            ? observed(true, "1", `${hwmonDir}/name`, timestamp, packageJudgement.reason)
            : observed(false, "1", `${hwmonDir}/name`, timestamp, packageJudgement.reason),
        });
      }
    }
  }

  return summarise(sensors, tripPoints, zones.ok, hwmons.ok, timestamp);
}

/** Reduce a sensor list to the derived figures, without inventing any. */
function summarise(
  sensors: ThermalSensor[],
  tripPoints: ThermalTripPoint[],
  zoneClassReadable: boolean,
  hwmonClassReadable: boolean,
  timestamp: string,
): ThermalSnapshot {
  // Only sensors with a real Celsius reading participate in the maximum. A
  // sensor that exists but could not be read must not drag the maximum down to
  // 0, and must not be silently skipped either: it stays in the list with an
  // UNAVAILABLE reading and the count is reflected in the reason below.
  const readable = sensors.filter((s) => s.celsius.value !== null && s.celsius.provenance !== "UNAVAILABLE");
  const unreadable = sensors.length - readable.length;

  let highestCelsius: SystemMetric<number>;
  let highestSensor: SystemMetric<string>;
  if (readable.length === 0) {
    highestCelsius = unavailable<number>(
      "°C",
      "/sys/class/thermal, /sys/class/hwmon",
      timestamp,
      sensors.length === 0 ? THERMAL_ABSENT_REASON : `${sensors.length} temperature sensor(s) were discovered but none could be read, so no maximum can be stated`,
    );
    highestSensor = unavailable<string>(
      "1",
      "/sys/class/thermal, /sys/class/hwmon",
      timestamp,
      sensors.length === 0 ? THERMAL_ABSENT_REASON : "No sensor produced a readable value, so no sensor can be named as the maximum",
    );
  } else {
    const top = readable.reduce((best, s) => (s.celsius.value! > best.celsius.value! ? s : best));
    highestCelsius = derived(
      top.celsius.value!,
      "°C",
      top.path,
      timestamp,
      `Maximum of ${readable.length} readable sensor(s) discovered on this host. The value is copied from ${top.path}, not computed.${unreadable > 0 ? ` ${unreadable} discovered sensor(s) could not be read and are excluded from this maximum.` : ""}`,
    );
    highestSensor = observed(top.name, "1", top.path, timestamp, "The sensor the maximum was taken from, named as the kernel names it");
  }

  const packageSensors = sensors.filter((s) => s.isPackage.value === true && s.celsius.value !== null);
  const packageCelsius: SystemMetric<number> =
    packageSensors.length === 0
      ? unavailable<number>(
          "°C",
          "/sys/class/thermal, /sys/class/hwmon",
          timestamp,
          sensors.length === 0
            ? THERMAL_ABSENT_REASON
            : `None of the ${sensors.length} discovered sensor(s) identifies itself as a package sensor. Their own names are reported instead. This is common in virtualised and containerised environments, where the host's package sensor is not passed through to the guest.`,
        )
      : observed(
          packageSensors[0]!.celsius.value!,
          "°C",
          packageSensors[0]!.path,
          timestamp,
          `The kernel identifies "${packageSensors[0]!.name}" as a package sensor; this is its current reading`,
        );

  const packageSensor: SystemMetric<string> =
    packageSensors.length === 0
      ? unavailable<string>("1", "/sys/class/thermal, /sys/class/hwmon", timestamp, "No discovered sensor identifies itself as a package sensor")
      : observed(packageSensors[0]!.name, "1", packageSensors[0]!.path, timestamp, "Name the kernel gives the package sensor");

  const availability: SystemMetric<string> =
    sensors.length === 0
      ? observed(
          "UNAVAILABLE",
          "1",
          "/sys/class/thermal, /sys/class/hwmon",
          timestamp,
          `${!zoneClassReadable ? "/sys/class/thermal is not readable. " : ""}${!hwmonClassReadable ? "/sys/class/hwmon is not readable. " : ""}This is a valid, successful observation: the kernel exposes no temperature sensor here.`,
        )
      : observed(
          "AVAILABLE",
          "1",
          "/sys/class/thermal, /sys/class/hwmon",
          timestamp,
          `${sensors.length} temperature sensor(s) discovered (${readable.length} readable) across /sys/class/thermal and /sys/class/hwmon`,
        );

  return { sensors, tripPoints, highestCelsius, highestSensor, packageCelsius, packageSensor, availability };
}
