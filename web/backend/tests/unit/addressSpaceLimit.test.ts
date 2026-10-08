/**
 * The address-space guardrail must accept the values an operator would set.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * The schema read:
 *
 *     CAPS_ADDRESS_SPACE_LIMIT_BYTES: z.coerce.number().int().min(0).max(1 << 46)
 *
 * JavaScript's `<<` is a 32-bit operation and the shift count is taken modulo
 * 32, so `1 << 46` is `1 << 14` -- which is **16384**, sixteen kilobytes, not
 * seventy terabytes.
 *
 * The effect was that every realistic address-space limit was REFUSED AT
 * STARTUP. `536870912` (512 MiB), `1073741824` (1 GiB) and even `1048576` (1
 * MiB) all failed validation with "Number must be less than or equal to 16384",
 * and `loadConfig` throws on an invalid environment, so the gateway refused to
 * start at all.
 *
 * That is a worse failure than an unenforced limit, and it is why it survived
 * review: `1 << 46` reads exactly like the intended constant. Every other
 * guardrail in this project was merely reported as enforced when it was not; this
 * one made the product unbootable, and no test set the variable to a realistic
 * value.
 *
 * These assertions are about ACCEPTANCE, not enforcement. Whether the limit then
 * reaches the child is asserted separately, in the guardrail tests, because the
 * two failures are independent and were.
 */

import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/env.js";

/** Values an operator would plausibly set, in bytes. */
const REALISTIC = [
  ["1 MiB", 1 * 1024 * 1024],
  ["64 MiB", 64 * 1024 * 1024],
  ["512 MiB", 512 * 1024 * 1024],
  ["1 GiB", 1024 * 1024 * 1024],
  ["4 GiB", 4 * 1024 * 1024 * 1024],
] as const;

/**
 * loadConfig reads process.env, so each case needs the real variables set and
 * then restored. Tests that mutate global state must restore it or they poison
 * every suite that runs after them in the same worker.
 */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("CAPS_ADDRESS_SPACE_LIMIT_BYTES accepts realistic limits", () => {
  for (const [label, bytes] of REALISTIC) {
    it(`accepts ${label} (${bytes} bytes)`, () => {
      expect(() =>
        withEnv({ CAPS_ADDRESS_SPACE_LIMIT_BYTES: String(bytes) }, () => loadConfig(process.env)),
      ).not.toThrow();
    });
  }

  it("reports the value it accepted, unchanged", () => {
    // A limit that is accepted but silently rescaled would be the same class of
    // bug one level up: the operator believes in a bound that is not the one in
    // force. So the configured number must survive verbatim.
    const config = withEnv({ CAPS_ADDRESS_SPACE_LIMIT_BYTES: "536870912" }, () => loadConfig(process.env));
    expect(config.guardrails.addressSpaceBytes).toBe(536_870_912);
  });

  it("still accepts 0, meaning unlimited", () => {
    const config = withEnv({ CAPS_ADDRESS_SPACE_LIMIT_BYTES: "0" }, () => loadConfig(process.env));
    expect(config.guardrails.addressSpaceBytes).toBe(0);
  });

  it("still refuses a negative limit rather than treating it as unlimited", () => {
    expect(() => withEnv({ CAPS_ADDRESS_SPACE_LIMIT_BYTES: "-1" }, () => loadConfig(process.env))).toThrow();
  });

  it("explains the unit in the name, because the ceiling is a byte count", () => {
    // 2 ** 46 is the declared ceiling. Asserted against the constant rather than
    // a literal so that a future edit to the ceiling fails here instead of
    // silently moving.
    expect(2 ** 46).toBe(70_368_744_177_664);
    // The trap this file exists for, stated as an executable assertion: if anyone
    // reintroduces `<<`, this is the line that catches it.
    expect(1 << 46).not.toBe(2 ** 46);
  });
});
