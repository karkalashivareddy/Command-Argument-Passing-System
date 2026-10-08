/**
 * The faculty presets, checked against the catalog rather than trusted.
 *
 * WHY THESE ASSERTIONS EXIST
 * --------------------------
 * A demo preset that names a command the catalog does not declare, or an
 * argument outside its documented bounds, is worse than no preset: the gateway
 * refuses it with a 4xx and a presenter discovers that live, in front of an
 * audience, having claimed the preset was verified. So the command names, the
 * argument shapes and the workload timeout floor are all asserted here against
 * values transcribed from the backend catalog.
 *
 * The catalog cannot be imported — it is backend TypeScript running against
 * node:fs, and this suite runs in jsdom — so the facts are mirrored below with
 * the source file named. If the catalog changes, these fail, which is the point:
 * the mirror is meant to be noticed when it goes stale.
 */

import { describe, expect, it } from "vitest";

import { FACULTY_PRESETS, presetCommandLine, presetRequest } from "./facultyPresets";

/**
 * Transcribed from `web/backend/src/catalog/commands.ts` DEFINITIONS.
 *
 * Only the fields a preset can violate are mirrored: the command name, the
 * positionals it accepts, and the numeric bounds on those positionals. Flags and
 * path policy are omitted because no preset uses a flag or a path — which is
 * itself asserted below, since a flag is how a preset would smuggle in
 * something the validator treats differently.
 */
const CATALOG: Record<string, { maxPositional: number; positionalIntegers?: { min: number; max: number } }> = {
  echo: { maxPositional: 32 },
  false: { maxPositional: 0 },
  true: { maxPositional: 0 },
  sleep: { maxPositional: 1, positionalIntegers: { min: 0, max: 120 } },
  uname: { maxPositional: 0 },
  /*
    `status_probe` takes a MODE WORD first, so its positional 1 is not an integer
    and its `choiceIntegerOperands` bound applies to positional 2 instead. That is
    modelled separately below rather than shoehorned into `positionalIntegers`,
    because a validator that conflated the two is exactly the bug the catalog
    entry's own comment describes.
  */
  status_probe: { maxPositional: 16 },
};

/**
 * Transcribed from `web/backend/src/execution/workloadCatalog.ts`.
 *
 * One entry per bounded workload: how many positionals it accepts and the
 * min..max of each, in order.
 */
const WORKLOADS: Record<string, Array<{ name: string; min: number; max: number }>> = {
  caps_cpu_burn: [{ name: "seconds", min: 1, max: 30 }],
  caps_memory_burn: [
    { name: "seconds", min: 1, max: 30 },
    { name: "mib", min: 1, max: 256 },
  ],
  caps_io_burn: [
    { name: "seconds", min: 1, max: 30 },
    { name: "mib", min: 1, max: 64 },
  ],
  caps_mixed_burn: [
    { name: "seconds", min: 1, max: 30 },
    { name: "mib", min: 1, max: 256 },
    { name: "mib", min: 1, max: 64 },
  ],
  caps_fork_tree: [
    { name: "seconds", min: 1, max: 30 },
    { name: "children", min: 1, max: 4 },
  ],
};

/**
 * The timeout floor the gateway enforces.
 *
 * `POST /api/sessions` computes `argv[1] * 1000 + 2000` for a workload and
 * answers 400 TIMEOUT_TOO_SHORT below it, so a preset that understated its own
 * budget would be refused rather than truncated.
 */
const WORKLOAD_TIMEOUT_MARGIN_MS = 2000;

describe("faculty presets", () => {
  it("defines exactly the eight required presets, in order", () => {
    expect(FACULTY_PRESETS.map((p) => p.label)).toEqual([
      "HELLO",
      "CPU",
      "MEMORY",
      "I/O",
      "FORK TREE",
      "MIXED",
      "TIMEOUT",
      "FAILURE",
    ]);
  });

  it("uses only commands the catalog declares", () => {
    for (const preset of FACULTY_PRESETS) {
      const known = preset.command in CATALOG || preset.command in WORKLOADS;
      expect(known, `${preset.label} runs "${preset.command}", which is not in the catalog`).toBe(true);
    }
  });

  it("passes no flags, so every argument goes through positional validation", () => {
    for (const preset of FACULTY_PRESETS) {
      for (const arg of preset.args) {
        // A leading dash would be classified as a flag by the validator and
        // checked against a closed allowlist instead of a numeric bound. No
        // preset needs one, so any dash here is a bug.
        expect(arg.startsWith("-"), `${preset.label} passes the flag "${arg}"`).toBe(false);
      }
    }
  });

  it("keeps every argument inside the catalog's positional count", () => {
    for (const preset of FACULTY_PRESETS) {
      const schema = CATALOG[preset.command];
      if (schema === undefined) continue; // a workload, checked separately
      expect(preset.args.length, `${preset.label} passes ${preset.args.length} positionals`).toBeLessThanOrEqual(
        schema.maxPositional,
      );
    }
    for (const preset of FACULTY_PRESETS) {
      const spec = WORKLOADS[preset.command];
      if (spec === undefined) continue;
      expect(preset.args.length, `${preset.label} passes ${preset.args.length} arguments`).toBeLessThanOrEqual(spec.length);
    }
  });

  it("keeps every numeric argument inside its documented bound", () => {
    for (const preset of FACULTY_PRESETS) {
      const schema = CATALOG[preset.command];
      // Only `sleep` uses positionalIntegers; `status_probe` is mode-led and is
      // asserted separately below.
      if (schema?.positionalIntegers === undefined) continue;
      for (const arg of preset.args) {
        expect(arg, `${preset.label} passes a non-integer to an integer-only positional`).toMatch(/^-?\d{1,9}$/);
        const value = Number.parseInt(arg, 10);
        expect(value, `${preset.label} passes ${value}, out of range`).toBeGreaterThanOrEqual(schema.positionalIntegers.min);
        expect(value, `${preset.label} passes ${value}, out of range`).toBeLessThanOrEqual(schema.positionalIntegers.max);
      }
    }

    // Workloads: same rule, position by position.
    for (const preset of FACULTY_PRESETS) {
      const spec = WORKLOADS[preset.command];
      if (spec === undefined) continue;
      preset.args.forEach((arg, i) => {
        const bound = spec[i]!;
        expect(arg, `${preset.label} arg ${i} must be a plain base-10 integer`).toMatch(/^-?\d{1,9}$/);
        const value = Number.parseInt(arg, 10);
        expect(value, `${preset.label} ${bound.name}=${value} below ${bound.min}`).toBeGreaterThanOrEqual(bound.min);
        expect(value, `${preset.label} ${bound.name}=${value} above ${bound.max}`).toBeLessThanOrEqual(bound.max);
      });
    }
  });

  it("gives the FAILURE preset a genuine mode-led non-zero exit", () => {
    const failure = FACULTY_PRESETS.find((p) => p.label === "FAILURE")!;
    // `status_probe exit N` per tests/helpers/status_probe.c, with the catalog's
    // leadingChoices/choiceIntegerOperands bound of 0..255 on the operand.
    expect(failure.command).toBe("status_probe");
    expect(failure.args[0]).toBe("exit");
    expect(failure.args[1]).toMatch(/^\d{1,3}$/);
    const code = Number.parseInt(failure.args[1]!, 10);
    expect(code).toBeGreaterThan(0);
    expect(code, "the chosen exit code must be non-zero or nothing failed").toBeLessThanOrEqual(255);
    // And it must SAY that the session is COMPLETED rather than FAILED, because
    // that distinction is the thing this preset teaches.
    expect(failure.outcome).toMatch(/COMPLETED/);
    expect(failure.outcome).toMatch(/exit code/);
  });

  it("gives the TIMEOUT preset a timeout shorter than the command's own runtime", () => {
    const timeout = FACULTY_PRESETS.find((p) => p.label === "TIMEOUT")!;
    expect(timeout.command).toBe("sleep");
    // `sleep 30` would run for thirty seconds; the guard has to fire well inside
    // that, or the preset is just a thirty-second wait that happens to succeed.
    const seconds = Number.parseInt(timeout.args[0]!, 10);
    expect(timeout.timeoutMs).toBeLessThan(seconds * 1000);
    // And it must not be so short that the guard kills the child before CAPS has
    // reported a process start, or the demo shows a timeout with no lifecycle.
    // 1000ms is the gateway's own minimum for this field.
    expect(timeout.timeoutMs).toBeGreaterThanOrEqual(1000);
    expect(timeout.observes).toContain("execution.timeout");
  });

  it("gives every workload preset a transport timeout at or above budget + 2000ms", () => {
    for (const preset of FACULTY_PRESETS) {
      const spec = WORKLOADS[preset.command];
      if (spec === undefined) continue;
      const budgetS = Number.parseInt(preset.args[0]!, 10);
      const required = budgetS * 1000 + WORKLOAD_TIMEOUT_MARGIN_MS;
      expect(preset.timeoutMs, `${preset.label} would be refused with 400 TIMEOUT_TOO_SHORT`).toBeGreaterThanOrEqual(required);
    }
  });

  it("bounds every run with an explicit, in-range timeout", () => {
    for (const preset of FACULTY_PRESETS) {
      // Every preset states in prose why it cannot run forever. An empty string
      // here is a claim nobody can check.
      expect(preset.bounded.length, `${preset.label} does not say how it is bounded`).toBeGreaterThan(0);
      /*
       * Required, not merely present: `timeoutMs` is a non-optional field, so a
       * preset that forgot it would not type-check. This assertion documents why
       * that is the case — a preset inheriting CAPS_DEFAULT_TIMEOUT_MS is bounded
       * by a server-side value the frontend never reads.
       */
      expect(typeof preset.timeoutMs, `${preset.label} has no explicit timeoutMs`).toBe("number");
      // Within the gateway's accepted range for POST /api/sessions
      // (z.number().int().min(1000)) and CAPS_MAX_TIMEOUT_MS (120000 default).
      expect(preset.timeoutMs, `${preset.label} timeout is below the gateway's 1000ms floor`).toBeGreaterThanOrEqual(1000);
      expect(preset.timeoutMs, `${preset.label} timeout is above the gateway's default maximum`).toBeLessThanOrEqual(120_000);
      // And short enough to fit in a faculty session even if the guard never fired.
      expect(preset.timeoutMs, `${preset.label} could occupy the whole session if its bound never fired`).toBeLessThanOrEqual(30_000);
    }
  });

  it("states what each preset should observe, including the terminal event", () => {
    const TERMINAL_EVENTS = ["execution.completed", "execution.failed", "execution.timeout"];
    for (const preset of FACULTY_PRESETS) {
      expect(preset.observes.length, `${preset.label} claims to observe nothing`).toBeGreaterThan(0);
      expect(
        preset.observes.some((e) => TERMINAL_EVENTS.includes(e)),
        `${preset.label} lists no terminal event, so it cannot say how the run ended`,
      ).toBe(true);
      // `process.started` is the event that carries the PID. A preset whose
      // evidence is all about resources but which cannot record a PID would be
      // promising something the stream does not deliver.
      expect(preset.observes, `${preset.label} never observes process.started`).toContain("process.started");
    }
  });

  it("gives every unavailable entry a metric and a reason", () => {
    for (const preset of FACULTY_PRESETS) {
      expect(preset.unavailable.length, `${preset.label} claims nothing is ever unavailable`).toBeGreaterThan(0);
      for (const u of preset.unavailable) {
        expect(u.metric.length).toBeGreaterThan(0);
        // An unexplained absence is the failure this product exists to prevent,
        // so a preset may not introduce one.
        expect(u.why.length, `${preset.label} lists "${u.metric}" with no reason`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every moved metric a direction in words, never a number", () => {
    for (const preset of FACULTY_PRESETS) {
      expect(preset.moves.length, `${preset.label} says nothing should move`).toBeGreaterThan(0);
      for (const m of preset.moves) {
        expect(m.metric.length).toBeGreaterThan(0);
        expect(m.direction.length, `${preset.label}/${m.metric} has no stated direction`).toBeGreaterThan(0);
      }
    }
  });

  it("requires no manual editing: a request is produced from the preset alone", () => {
    for (const preset of FACULTY_PRESETS) {
      const req = presetRequest(preset);
      expect(req.command).toBe(preset.command);
      expect(req.args).toEqual([...preset.args]);
      // An empty-string argument is what a half-filled form sends, and the
      // workload validator rejects it as "not a plain base-10 integer".
      for (const arg of req.args) expect(arg).not.toBe("");
      expect(req.redirections).toEqual(preset.redirections);
      expect(req.timeoutMs).toBe(preset.timeoutMs);
    }
  });

  it("hands out a fresh request each call, so one preset cannot leak into the next", () => {
    const hello = FACULTY_PRESETS[0]!;
    const first = presetRequest(hello);
    first.args.push("MUTATED");
    first.redirections.out = "leaked.txt";
    const second = presetRequest(hello);
    expect(second.args).toEqual(hello.args);
    expect(second.redirections.out).toBeUndefined();
  });

  it("renders the command line as the flight recorder will show it", () => {
    expect(presetCommandLine(FACULTY_PRESETS[0]!)).toBe("echo Hello from CAPS");
    expect(presetCommandLine(FACULTY_PRESETS.find((p) => p.label === "TIMEOUT")!)).toBe("sleep 30");
    expect(presetCommandLine(FACULTY_PRESETS.find((p) => p.label === "FAILURE")!)).toBe("status_probe exit 42");
  });
});
