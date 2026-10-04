/**
 * CPU frequency from `/sys/devices/system/cpu/cpufreq`.
 *
 * THE DISTINCTION THIS MODULE IS BUILT AROUND
 * -------------------------------------------
 * None of the values here are a measurement of the clock the silicon actually
 * ran at. `scaling_cur_freq` is what the *governor has requested*. It is
 * maintained in software by the cpufreq driver, it can lag the real frequency
 * by a scheduling interval, and a governor that is not keeping up is a normal
 * condition rather than a bug. `cpuinfo_cur_freq` is the driver's last
 * hardware-reported figure, which is still a driver statement rather than an
 * independent measurement.
 *
 * A true hardware frequency measurement requires reading a performance counter
 * (MSR or APIC) that counts cycles against a reference clock. CAPS does not do
 * that, and `measuredHardwareKhz` in the snapshot says so explicitly instead of
 * letting a policy frequency masquerade as silicon truth. The field names
 * follow the kernel's own attribute names so the distinction is visible in the
 * payload rather than only in prose.
 *
 * Availability is genuinely kernel-dependent. Under WSL2 and inside most VMs
 * the cpufreq sysfs interface is absent entirely, and the correct output is an
 * empty policy list with a stated reason.
 */

import { readTrimmed, readUintFile, readSymlink, listMatching, sysPath, type KernelPaths } from "./read.js";
import { observed, unavailable, type FrequencyPolicy, type FrequencySnapshot, type SystemMetric } from "./types.js";

/** Why cpufreq data may be absent, stated for the UI. */
export const FREQUENCY_ABSENT_REASON =
  "No cpufreq interface is exposed at /sys/devices/system/cpu/cpufreq. This is expected when the CPU is not under cpufreq control: virtual machines and WSL2 guests generally do not expose the interface, and some embedded and modern hybrid CPUs use a different mechanism. CAPS reports the frequency the kernel publishes and does not attempt to measure the silicon clock.";

const KILOHERTZ = 1000;

function khz(raw: number | null, path: string, timestamp: string, what: string): SystemMetric<number> {
  if (raw === null) {
    return unavailable<number>("kHz", path, timestamp, `${what}: this sysfs file is missing, unreadable, or not an integer`);
  }
  return observed(raw, "kHz", path, timestamp, `${what}, as published by the cpufreq driver in kHz. The UI divides by 1000 for MHz; the payload stays in the kernel's own unit.`);
}

function text(
  result: { ok: true; text: string } | { ok: false; failure: { reason: string } },
  path: string,
  timestamp: string,
  what: string,
): SystemMetric<string> {
  if (!result.ok) {
    return unavailable<string>("1", path, timestamp, `${what}: ${result.failure.reason}`);
  }
  if (result.text === "") {
    return unavailable<string>("1", path, timestamp, `${what}: the file is present but empty`);
  }
  return observed(result.text, "1", path, timestamp, `${what}, as published by sysfs`);
}

function booleanText(
  result: { ok: true; text: string } | { ok: false; failure: { reason: string } },
  path: string,
  timestamp: string,
  what: string,
): SystemMetric<boolean> {
  if (!result.ok) {
    return unavailable<boolean>("1", path, timestamp, `${what}: ${result.failure.reason}`);
  }
  const normalised = result.text.trim().toLowerCase();
  // cpufreq writes "1"/"0"; intel_pstate writes "Y"/"N". Both mean the same
  // thing and both are accepted rather than guessing at an unrecognised value.
  if (normalised === "1" || normalised === "y" || normalised === "yes" || normalised === "true") {
    return observed(true, "1", path, timestamp, `${what}, reported as "${result.text.trim()}"`);
  }
  if (normalised === "0" || normalised === "n" || normalised === "no" || normalised === "false") {
    return observed(false, "1", path, timestamp, `${what}, reported as "${result.text.trim()}"`);
  }
  return unavailable<boolean>("1", path, timestamp, `${what}: unrecognised value "${result.text.trim()}"; not interpreted`);
}

/** Read one `policyN` directory into a policy record. */
function readPolicy(policyDir: string, policy: string, timestamp: string): FrequencyPolicy {
  return {
    policy,
    affectedCpus: text(readTrimmed(`${policyDir}/affected_cpus`), `${policyDir}/affected_cpus`, timestamp, "CPUs this policy governs"),
    reportedCurKhz: khz(readUintFile(`${policyDir}/cpuinfo_cur_freq`), `${policyDir}/cpuinfo_cur_freq`, timestamp, "Driver-reported current frequency"),
    requestedKhz: khz(readUintFile(`${policyDir}/scaling_cur_freq`), `${policyDir}/scaling_cur_freq`, timestamp, "Frequency the scaling governor has requested"),
    scalingMinKhz: khz(readUintFile(`${policyDir}/scaling_min_freq`), `${policyDir}/scaling_min_freq`, timestamp, "Minimum scaling frequency"),
    scalingMaxKhz: khz(readUintFile(`${policyDir}/scaling_max_freq`), `${policyDir}/scaling_max_freq`, timestamp, "Maximum scaling frequency"),
    scalingGovernor: text(readTrimmed(`${policyDir}/scaling_governor`), `${policyDir}/scaling_governor`, timestamp, "Active scaling governor"),
    boostEnabled: booleanText(readTrimmed(`${policyDir}/boost`), `${policyDir}/boost`, timestamp, "Turbo boost enable state"),
    energyPerformancePreference: text(
      readTrimmed(`${policyDir}/energy_performance_preference`),
      `${policyDir}/energy_performance_preference`,
      timestamp,
      "Energy/performance hint (intel_pstate only)",
    ),
  };
}

/**
 * Discover every cpufreq policy.
 *
 * Policies are discovered from the policy directory and from the per-CPU
 * `cpufreq` symlinks, because a kernel may publish only one of the two. On a
 * hybrid CPU, several policies can govern disjoint CPU sets and each is
 * reported separately rather than averaged into a single misleading number.
 */
export function discoverFrequency(paths: KernelPaths, timestamp: string): FrequencySnapshot {
  const policyRoot = sysPath(paths, "devices", "system", "cpu", "cpufreq");
  const policies: FrequencyPolicy[] = [];
  const seen = new Set<string>();

  const policyDir = listMatching(policyRoot, /^policy\d+$/);
  if (policyDir.ok) {
    for (const name of policyDir.entries) {
      seen.add(name);
      policies.push(readPolicy(`${policyRoot}/${name}`, name, timestamp));
    }
  }

  // Fallback: cpuN/cpufreq symlinks, which every policy exposes per CPU.
  const cpuRoot = sysPath(paths, "devices", "system", "cpu");
  const cpus = listMatching(cpuRoot, /^cpu\d+$/);
  if (cpus.ok) {
    for (const name of cpus.entries) {
      const linked = policyNameForCpu(policyRoot, `${cpuRoot}/${name}/cpufreq`);      if (linked !== null && !seen.has(linked)) {
        seen.add(linked);
        policies.push(readPolicy(`${policyRoot}/${linked}`, linked, timestamp));
      }
    }
  }

  policies.sort((a, b) => a.policy.localeCompare(b.policy));

  const availability: SystemMetric<string> =
    policies.length === 0
      ? observed(
          "UNAVAILABLE",
          "1",
          policyRoot,
          timestamp,
          !policyDir.ok
            ? FREQUENCY_ABSENT_REASON
            : `${policyRoot} exists but publishes no policyN directory and no cpuN/cpufreq link, so this kernel exposes no frequency policy.`,
        )
      : observed(
          "AVAILABLE",
          "1",
          policyRoot,
          timestamp,
          `${policies.length} frequency polic${policies.length === 1 ? "y" : "ies"} discovered. These are the frequencies the kernel's governors have requested, not an independent measurement of the hardware clock.`,
        );

  return {
    policies,
    // Permanently UNAVAILABLE, and that is a product decision rather than an
    // environmental one: CAPS installs no MSR, APIC, or perf counter access.
    measuredHardwareKhz: unavailable<number>(
      "kHz",
      "none: CAPS does not read performance counters",
      timestamp,
      "CAPS implements no hardware frequency measurement. Reporting the cpufreq policy frequency as a measured clock rate would be a false claim, so this field is UNAVAILABLE by design rather than by environment. A real measurement would require MSR or fixed-performance-counter access.",
    ),
    availability,
  };
}

/** Resolve a per-CPU cpufreq symlink to its policy directory name. */
function policyNameForCpu(_policyRoot: string, perCpuDir: string): string | null {
  const target = readSymlink(perCpuDir);
  if (target === null) return null;
  // Only the link target's final component is trusted, and it must match
  // `policyN` exactly, so a link pointing outside the policy root cannot
  // produce a name that would then be joined back onto it.
  const name = target.split("/").pop() ?? "";
  return /^policy\d+$/.test(name) ? name : null;
}
