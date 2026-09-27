import { accessSync, constants } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  getWorkloadProfile,
  isWorkloadId,
  materializeWorkloadArgv,
  probeWorkload,
  validateWorkloadArgv,
  workloadCapabilities,
  workloadIds,
  WORKLOAD_LIMITS,
  WorkloadArgumentError,
  WORKLOAD_PROFILES,
} from "./workloadCatalog.js";

describe("workload catalog shape", () => {
  it("describes every first-party workload exactly once", () => {
    const ids = workloadIds();
    expect(ids).toEqual([
      "caps_cpu_burn",
      "caps_memory_burn",
      "caps_io_burn",
      "caps_mixed_burn",
      "caps_fork_tree",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every documented bound identical to the C CAPS_WL_* constants", () => {
    expect(WORKLOAD_LIMITS).toEqual({
      maxDurationS: 30,
      maxMemoryMib: 256,
      maxIoMib: 64,
      maxForkChildren: 4,
    });
    for (const profile of WORKLOAD_PROFILES) {
      expect(profile.args.length).toBeGreaterThan(0);
      expect(profile.args[0]!.name).toBe("seconds");
      expect(profile.args[0]!.min).toBe(1);
      expect(profile.args[0]!.max).toBe(WORKLOAD_LIMITS.maxDurationS);
    }
  });

  it("never names a path outside the repository workload build directory", () => {
    for (const cap of workloadCapabilities()) {
      expect(cap.executablePath.startsWith("/")).toBe(true);
      expect(cap.executableRelativePath.startsWith("..")).toBe(false);
      expect(cap.executableRelativePath).toMatch(/build\/workloads\//);
      // The path is derived from the fixed profile id, not from input.
      expect(cap.executablePath.endsWith(cap.id)).toBe(true);
    }
  });

  it("reports availability as an observed probe result, never a guess", () => {
    for (const cap of workloadCapabilities()) {
      expect(cap.availabilityProvenance).toBe("OBSERVED");
      if (!cap.available) expect(cap.unavailableReason).toBeTruthy();
      else expect(cap.unavailableReason).toBeNull();

      let onDisk = false;
      try {
        accessSync(cap.executablePath, constants.X_OK);
        onDisk = true;
      } catch {
        onDisk = false;
      }
      expect(cap.available).toBe(onDisk);
    }
  });

  it("gives a reason string whenever a workload is unavailable", () => {
    for (const id of workloadIds()) {
      const probe = probeWorkload(id);
      expect(probe.provenance).toBe("OBSERVED");
      if (probe.available) expect(probe.reason).toBeNull();
      else expect(probe.reason).toMatch(/make workloads|not a regular file|stat failed/);
    }
  });
});

describe("workload argument validation", () => {
  it("materializes defaults for omitted trailing arguments", () => {
    expect(materializeWorkloadArgv("caps_cpu_burn", [])).toEqual(["10"]);
    expect(materializeWorkloadArgv("caps_memory_burn", ["3"])).toEqual(["3", "64"]);
    expect(materializeWorkloadArgv("caps_mixed_burn", ["3", "8"])).toEqual(["3", "8", "8"]);
    expect(materializeWorkloadArgv("caps_fork_tree", [])).toEqual(["8", "2"]);
  });

  it("keeps explicit values that are inside the bound", () => {
    expect(materializeWorkloadArgv("caps_cpu_burn", ["1"])).toEqual(["1"]);
    expect(materializeWorkloadArgv("caps_cpu_burn", ["30"])).toEqual(["30"]);
    expect(materializeWorkloadArgv("caps_memory_burn", ["30", "256"])).toEqual(["30", "256"]);
    expect(materializeWorkloadArgv("caps_io_burn", ["1", "64"])).toEqual(["1", "64"]);
    expect(materializeWorkloadArgv("caps_fork_tree", ["30", "4"])).toEqual(["30", "4"]);
  });

  it("rejects every out-of-range value at the documented boundary", () => {
    const cases: Array<[string, string[]]> = [
      ["caps_cpu_burn", ["0"]],
      ["caps_cpu_burn", ["31"]],
      ["caps_memory_burn", ["1", "0"]],
      ["caps_memory_burn", ["1", "257"]],
      ["caps_io_burn", ["1", "0"]],
      ["caps_io_burn", ["1", "65"]],
      ["caps_mixed_burn", ["1", "1", "65"]],
      ["caps_fork_tree", ["1", "0"]],
      ["caps_fork_tree", ["1", "5"]],
    ];
    for (const [id, args] of cases) {
      expect(() => validateWorkloadArgv(id, args), `${id} ${args.join(" ")}`).toThrow(WorkloadArgumentError);
    }
  });

  it("rejects non-integer spellings instead of coercing them", () => {
    for (const raw of ["3.5", "1e3", "0x10", "+3", " 3", "3 ", "3s", "abc", "", " ", "1_000", "99999999999999999999"]) {
      expect(() => validateWorkloadArgv("caps_cpu_burn", [raw]), `should reject ${JSON.stringify(raw)}`).toThrow(
        WorkloadArgumentError,
      );
    }
  });

  it("rejects unknown extra positional arguments", () => {
    expect(() => validateWorkloadArgv("caps_cpu_burn", ["3", "4"])).toThrow(/at most 1 argument/);
    expect(() => validateWorkloadArgv("caps_fork_tree", ["3", "2", "1"])).toThrow(/at most 2 argument/);
    expect(() => validateWorkloadArgv("caps_mixed_burn", ["3", "4", "5", "6"])).toThrow(/Unknown arguments are rejected/);
  });

  it("refuses to validate a command that is not a controlled workload", () => {
    expect(isWorkloadId("echo")).toBe(false);
    expect(getWorkloadProfile("echo")).toBeNull();
    expect(() => validateWorkloadArgv("echo", ["hello"])).toThrow(/not a controlled workload/);
  });

  it("returns the parsed values alongside the argv so the UI can show them", () => {
    const result = validateWorkloadArgv("caps_mixed_burn", ["4", "16"]);
    expect(result.values).toEqual([4, 16, undefined]);
    expect(result.argv).toEqual(["4", "16", "8"]);
    expect(result.profile.id).toBe("caps_mixed_burn");
  });
});
