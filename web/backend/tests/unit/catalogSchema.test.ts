import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { validateArguments } from "../../src/catalog/validation.js";
import { COMMAND_DEFINITIONS, probeCommand, resetCatalogProbes } from "../../src/catalog/commands.js";
import type { CapsConfig } from "../../src/config/env.js";

/**
 * The catalog is the single source of truth for argument rules, and its whole
 * value rests on matching the programs it describes. A schema that describes a
 * different interface than the real binary is not a cosmetic defect: the API
 * then refuses the documented invocation, and the API integration suite cannot
 * drive the program at all.
 *
 * `status_probe` had exactly that bug. Its schema claimed "one positional, an
 * integer 0..255", while the helper takes `exit N | signal S | print A B ...`.
 * Every document in this repository drove it the second way. The consequence was
 * three failing integration tests and a playground example that returned 422.
 */

/** status_probe reads no files, so no field of this is reached. */
const config = { workspace: "/tmp", maxArgumentBytes: 1024 } as unknown as CapsConfig;

describe("catalog schema vs the program it describes", () => {
  it("accepts every documented status_probe invocation", () => {
    if (!existsSync(probeCommand("status_probe").resolvedPath ?? "")) {
      // The helper is compiled by the C test harness. Where it is absent the
      // probe honestly reports UNAVAILABLE and there is nothing to check.
      expect(probeCommand("status_probe").availability).not.toBe("AVAILABLE");
      return;
    }
    for (const args of [
      ["exit", "0"],
      ["exit", "127"],
      ["signal", "2"],
      ["print", "alpha", "beta"],
      ["print"],
    ]) {
      expect(() => validateArguments("status_probe", args, config)).not.toThrow();
    }
  });

  it("refuses a mode word that does not exist, and an out-of-range operand", () => {
    if (probeCommand("status_probe").availability !== "AVAILABLE") return;
    expect(() => validateArguments("status_probe", ["exi", "3"], config)).toThrow(/not a mode/);
    expect(() => validateArguments("status_probe", ["exit", "256"], config)).toThrow(/outside the permitted range/);
    expect(() => validateArguments("status_probe", ["exit", "abc"], config)).toThrow(/not a plain non-negative integer/);
  });

  /**
   * `status_probe 7` must NOT validate. The helper answers an unrecognised first
   * word with its unknown-mode status 3, so accepting a bare integer would let
   * a caller believe it produced exit 7 when it produced 3. This is the exact
   * shape the old schema permitted.
   */
  it("refuses a bare integer, which the helper would answer with its unknown-mode status", () => {
    if (probeCommand("status_probe").availability !== "AVAILABLE") return;
    expect(() => validateArguments("status_probe", ["7"], config)).toThrow(/not a mode/);
  });

  /**
   * A schema can only be checked against a running program's interface without
   * filesystem state for commands that take no paths. `cat notes.txt` is a
   * correct example that requires the reader to have created `notes.txt`, so
   * this asserts the invariant where it is decidable, and says so rather than
   * quietly narrowing until it passes.
   */
  it("keeps the catalog's own examples valid for every path-free command", () => {
    resetCatalogProbes();
    for (const entry of COMMAND_DEFINITIONS.values()) {
      if (entry.workspacePolicy !== "no-paths") continue;
      for (const example of entry.examples ?? []) {
        const tokens = example.command.split(/\s+/).filter((t) => t.length > 0);
        expect(tokens[0], `example "${example.command}" names no command`).toBeDefined();
        // A pipeline example (`seq 1 2000 | wc -l`) documents a terminal line.
        // The API validates one command at a time and has no pipe token, so
        // such an example has no single-command form to check here.
        if (tokens.some((t) => t === "|" || t === ">" || t === ">>")) continue;
        if (probeCommand(tokens[0]!).availability !== "AVAILABLE") continue;
        expect(
          () => validateArguments(tokens[0]!, tokens.slice(1), config),
          `catalog example "${example.command}" is rejected by the catalog's own schema`,
        ).not.toThrow();
      }
    }
  });
});
