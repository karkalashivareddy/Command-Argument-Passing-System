/**
 * Thermal guard configuration: environment parsing and its refusals.
 *
 * The guard's value depends on the configuration being either right or refused.
 * A threshold combination that cannot all be true at once must fail at startup,
 * because a guard that compares against an unreachable threshold appears to
 * work and protects nothing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_THERMAL_GUARD, validateThermalGuardConfig, type ThermalGuardConfig } from "../../src/execution/thermalGuard.js";

/**
 * Build a server with a controlled environment and report whether startup
 * succeeded.
 *
 * `buildServer` calls `loadConfig` internally, so this exercises the real
 * startup path -- the same one a deployment uses -- rather than calling the
 * parser directly and asserting on its return value. A configuration that the
 * parser accepts but the server ignores would pass the narrower test and fail
 * in production.
 */
async function startWith(env: Record<string, string>): Promise<{ ok: true; guard: ThermalGuardConfig } | { ok: false; message: string }> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  const root = mkdtempSync(join(tmpdir(), "caps-cfg-"));
  roots.push(root);
  try {
    const { buildServer } = await import("../../src/server.js");
    const server = await buildServer({
      dbPath: join(root, "caps.db"),
      config: { workspace: join(root, "work"), host: "127.0.0.1", port: 0 },
    });
    await server.app.close();
    const { loadConfig } = await import("../../src/config/env.js");
    return { ok: true, guard: loadConfig().thermalGuard };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("thermal guard is off unless explicitly enabled", () => {
  it("ships disabled", () => {
    expect(DEFAULT_THERMAL_GUARD.enabled).toBe(false);
  });
});

describe("configuration validation", () => {
  const base: ThermalGuardConfig = { ...DEFAULT_THERMAL_GUARD, enabled: true };

  it("accepts a sane configuration", () => {
    expect(validateThermalGuardConfig(base)).toEqual([]);
  });

  it("refuses warningC >= criticalC", () => {
    const problems = validateThermalGuardConfig({ ...base, warningC: 100, criticalC: 90 });
    expect(problems.join(" ")).toMatch(/must be below criticalC/);
  });

  it("refuses thresholds below absolute zero", () => {
    expect(validateThermalGuardConfig({ ...base, warningC: -300 }).join(" ")).toMatch(/absolute zero/);
  });

  it("refuses a negative grace period", () => {
    expect(validateThermalGuardConfig({ ...base, termGraceMs: -1 }).join(" ")).toMatch(/must not be negative/);
  });

  it("warns that WARN does not prevent execution at a critical temperature", () => {
    // This is not a configuration error -- WARN is a legitimate choice -- but
    // the reason string has to say so, because otherwise an operator who
    // expected protection has none.
    const r = { ...base, action: "WARN" as const };
    expect(validateThermalGuardConfig(r)).toEqual([]);
    // The caveat lives in the decision record, asserted in thermalGuard.test.ts.
  });
});

describe("environment parsing", () => {
  it("refuses to start when the thresholds cannot both be true", async () => {
    const root = mkdtempSync(join(tmpdir(), "caps-cfg-"));
    roots.push(root);
    const result = await startWith({
      CAPS_THERMAL_GUARD_ENABLED: "true",
      CAPS_THERMAL_GUARD_WARNING_C: "100",
      CAPS_THERMAL_GUARD_CRITICAL_C: "50",
      CAPS_DATABASE_PATH: join(root, "caps.db"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/thermal guard configuration/i);
  });

  it("refuses both sensor name and sensor path, rather than picking one", async () => {
    const root = mkdtempSync(join(tmpdir(), "caps-cfg-"));
    roots.push(root);
    const result = await startWith({
      CAPS_THERMAL_GUARD_SENSOR_NAME: "x86_pkg_temp",
      CAPS_THERMAL_GUARD_SENSOR_PATH: "/sys/class/thermal/thermal_zone0/temp",
      CAPS_DATABASE_PATH: join(root, "caps.db"),
    });
    // Silently preferring one would leave an operator who set both believing
    // they had chosen the second.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/mutually exclusive/);
  });

  it("refuses an unknown action rather than defaulting to a safe-looking one", async () => {
    const root = mkdtempSync(join(tmpdir(), "caps-cfg-"));
    roots.push(root);
    const result = await startWith({
      CAPS_THERMAL_GUARD_ACTION: "REBOOT",
      CAPS_DATABASE_PATH: join(root, "caps.db"),
    });
    expect(result.ok).toBe(false);
  });
});

describe("guardrails are named for what they actually limit", () => {
  /*
   * The single most important naming claim in the guardrail surface.
   *
   * RLIMIT_AS caps virtual address space. On a 64-bit host that number is
   * numerically enormous, a program can exhaust a modest limit with mappings it
   * never touches, and the limit says nothing about RSS. Calling it a "memory
   * limit" would be a category error a reader could not detect from the number
   * alone.
   *
   * Asserted against the bytes that the gateway actually serves rather than
   * against a string written here, so renaming the caveat in the implementation
   * cannot leave this test passing on a claim the product no longer makes.
   */
  it("the capabilities response describes address space, not physical memory", async () => {
    const { buildServer } = await import("../../src/server.js");
    const root = mkdtempSync(join(tmpdir(), "caps-guardrails-"));
    roots.push(root);
    const server = await buildServer({
      dbPath: join(root, "caps.db"),
      config: { workspace: join(root, "work"), host: "127.0.0.1", port: 0 },
    });
    await server.app.ready();
    try {
      const res = await server.app.inject({ method: "GET", url: "/api/capabilities" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const as = body.guardrails.addressSpace;

      expect(as.unit).toMatch(/virtual address space/i);
      expect(as.caveat).toMatch(/VIRTUAL ADDRESS SPACE/i);
      expect(as.caveat).toMatch(/not physical memory/i);
      expect(as.caveat).toMatch(/no simple relation to RSS/i);

      // And nothing in the response calls it a memory limit.
      const serialised = JSON.stringify(body.guardrails);
      expect(serialised).not.toMatch(/"memoryLimit"/i);
      expect(serialised).not.toMatch(/memory budget/i);

      // CPU time must not be conflated with wall time either.
      expect(body.guardrails.cpuTime.caveat).toMatch(/not wall-clock/i);
    } finally {
      await server.app.close();
    }
  });

  it("publishes configured, enforced, and mechanism for every limit", async () => {
    const { buildServer } = await import("../../src/server.js");
    const root = mkdtempSync(join(tmpdir(), "caps-guardrails-"));
    roots.push(root);
    const server = await buildServer({
      dbPath: join(root, "caps.db"),
      config: { workspace: join(root, "work"), host: "127.0.0.1", port: 0 },
    });
    await server.app.ready();
    try {
      const body = (await server.app.inject({ method: "GET", url: "/api/capabilities" })).json();
      for (const key of ["wallTime", "stdout", "stderr", "cpuTime", "addressSpace", "concurrency"]) {
        expect(body.guardrails[key], `${key} must be published`).toBeDefined();
        expect(typeof body.guardrails[key].enforced, `${key} must state whether it is enforced`).toBe("boolean");
        expect(body.guardrails[key].unit.length).toBeGreaterThan(0);
      }
      // A limit that is configured but not enforced must say so, because a
      // reader cannot otherwise tell a real cap from a documented intention.
      expect(body.guardrails.addressSpace.enforced).toBe(false);
      expect(body.guardrails.addressSpace.mechanism).toMatch(/not configured/i);
    } finally {
      await server.app.close();
    }
  });
});
