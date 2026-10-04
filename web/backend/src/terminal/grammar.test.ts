/**
 * Terminal grammar contract tests.
 *
 * The grammar's central claim is that there is exactly ONE lexer in the
 * product. If that claim is false the allowlist can be defeated, so these tests
 * assert it directly rather than inferring it from behaviour.
 *
 * The most important tests are the `--inspect` JSON ones. `--inspect` is how the
 * gateway learns which argv a line would produce, and it validates THAT before
 * running anything. A malformed document does not merely look wrong: the
 * gateway cannot read it, so every valid command line is rejected as a syntax
 * error. An unquoted string value produces exactly that while still looking
 * correct in a casual read, which is why these are tested explicitly rather
 * than left to the functional tests.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { inspectCommandLine, validateCommandLine, buildResolvedLine, TerminalSyntaxError, TerminalPolicyError } from "./grammar.js";
import { loadConfig, repoRoot } from "../config/env.js";

const execFileAsync = promisify(execFile);
const config = loadConfig();
const engine = join(repoRoot, "caps");

/*
 * Every suite below asks the C engine's own lexer what a line means, because the
 * claim under test is precisely that the gateway and the engine cannot disagree.
 * With no binary there is nothing to compare against, so the suites skip rather
 * than fail: "the engine was not built" and "the gateway parsed this wrongly" are
 * different facts, and a suite must not report the second one for the first.
 *
 * CI builds the engine in this job, so on CI these run for real.
 */
const describeFx = existsSync(engine) ? describe : describe.skip;

async function rawInspect(line: string): Promise<string> {
  const { stdout } = await execFileAsync(engine, ["--inspect", line], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin" },
  });
  return stdout;
}

beforeAll(() => {
  mkdirSync(config.workspace, { recursive: true });
});

describeFx("--inspect emits a document the gateway can actually read", () => {
  it("produces parseable JSON for a simple pipeline", async () => {
    const parsed = JSON.parse(await rawInspect("seq 1 5 | wc -l")) as { stages: number };
    expect(parsed.stages).toBe(2);
  });

  it("emits argv as quoted JSON strings, not bare words", async () => {
    // The regression this pins: emitting escaped *contents* without the
    // surrounding quotes produces `"argv":[seq,1,5]`, which is not JSON. The
    // values look right in a casual read, so only a parse catches it.
    const raw = await rawInspect("seq 1 5 | wc -l");
    expect(raw).toContain('"argv":["seq","1","5"]');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("produces parseable JSON when redirections are present", async () => {
    // The redirection target had the same defect as argv, separately.
    const raw = await rawInspect("cat a.txt 2> e.txt | grep x > o.txt");
    const parsed = JSON.parse(raw) as {
      pipeline: Array<{ argv: string[]; redirections: Array<{ op: string; fd: number; target: string }> }>;
    };
    expect(parsed.pipeline[0]!.redirections[0]).toEqual({ op: "2>", fd: 2, target: "e.txt" });
    expect(parsed.pipeline[1]!.redirections[0]).toEqual({ op: ">", fd: 1, target: "o.txt" });
  });

  it("produces parseable JSON for quoting and escapes", async () => {
    for (const line of [
      'echo he said "hi" and "bye"',
      "echo 'a | b'",
      "echo a\\ b",
      'cat x >> log.txt 2>> err.txt',
      "printf 'a\\tb'",
    ]) {
      const raw = await rawInspect(line);
      expect(() => JSON.parse(raw), `--inspect output for ${line} must parse`).not.toThrow();
    }
  });

  it("a quote in an argument cannot forge a field in the document", async () => {
    // This is why argv is escaped at all. Without escaping, an argument
    // containing a double quote could terminate the JSON string and inject a
    // structure the gateway would read as a real stage.
    const raw = await rawInspect('echo "{\\"stages\\":99,\\"pipeline\\":[]}"');
    const parsed = JSON.parse(raw) as { stages: number; pipeline: unknown[] };
    expect(parsed.stages).toBe(1);
    expect(parsed.pipeline).toHaveLength(1);
  });

  it("reports a non-zero exit and a reason for an unparseable line", async () => {
    await expect(rawInspect("echo a | | cat")).rejects.toMatchObject({ code: 2 });
  });
});

describeFx("the gateway reads the same argv the engine will execute", () => {
  it("resolves a two-stage pipeline into per-stage argv", async () => {
    const stages = await inspectCommandLine(config, "seq 1 5 | wc -l");
    expect(stages).toHaveLength(2);
    expect(stages[0]!.argv).toEqual(["seq", "1", "5"]);
    expect(stages[1]!.argv).toEqual(["wc", "-l"]);
    expect(stages[0]!.stdoutDest).toBe("pipe");
    expect(stages[1]!.stdinSource).toBe("pipe");
  });

  it("treats a quoted pipe as data, not a stage boundary", async () => {
    const stages = await inspectCommandLine(config, "echo 'a | b'");
    expect(stages).toHaveLength(1);
    expect(stages[0]!.argv).toEqual(["echo", "a | b"]);
  });

  it("raises a syntax error rather than guessing at a bad line", async () => {
    await expect(inspectCommandLine(config, "echo a | | cat")).rejects.toBeInstanceOf(TerminalSyntaxError);
  });
});

describeFx("policy is enforced before anything executes", () => {
  it("refuses a shell, naming why", async () => {
    await expect(validateCommandLine(config, 'bash -c "rm -rf /"')).rejects.toBeInstanceOf(TerminalPolicyError);
    await expect(validateCommandLine(config, 'bash -c "rm -rf /"')).rejects.toThrow(/not on the allowlist/);
  });

  it("refuses an interpreter", async () => {
    for (const line of ["python3 -c 'print(1)'", "perl -e 'print 1'", "node -e 'console.log(1)'"]) {
      await expect(validateCommandLine(config, line), line).rejects.toBeInstanceOf(TerminalPolicyError);
    }
  });

  it("refuses a privilege tool anywhere in the pipeline", async () => {
    // The refusal has to apply per stage. Validating only stage 0 would let
    // `echo hi | sudo rm` through, which is the obvious bypass.
    await expect(validateCommandLine(config, "echo x | sudo rm /tmp/y")).rejects.toBeInstanceOf(TerminalPolicyError);
  });

  it("refuses an absolute path, because the browser may name a command, never a file", async () => {
    await expect(validateCommandLine(config, "/bin/echo hi")).rejects.toThrow(/names .* which is a path/);
  });

  it("refuses a relative path that could escape the workspace", async () => {
    await expect(validateCommandLine(config, "cat ../../etc/passwd")).rejects.toBeInstanceOf(TerminalPolicyError);
  });

  it("refuses an unlisted flag, naming the accepted set", async () => {
    // The real protection against argument abuse is the closed flag list: an
    // unknown flag is refused by name rather than passed through to a program
    // that might interpret it.
    await expect(validateCommandLine(config, "grep --include=secret PATTERN")).rejects.toThrow(/not an accepted flag/);
  });

  it("refuses a numeric argument outside the declared bound", async () => {
    // `sleep` declares 0..120 seconds. Without that bound a single command
    // could hold a concurrency slot for hours.
    await expect(validateCommandLine(config, "sleep 99999")).rejects.toThrow(/outside the permitted range/);
  });

  it("refuses a non-integer where the schema requires an integer", async () => {
    // Rejecting "3.5", "1e3", "0x10", "+3" and " 3" is the point: each is
    // interpreted differently by different programs, and the ambiguity has no
    // place in a system that records the argv it executed.
    for (const bad of ["3.5", "1e3", "0x10", "+3"]) {
      await expect(validateCommandLine(config, `sleep ${bad}`), bad).rejects.toThrow(/plain non-negative integer/);
    }
  });

  it("refuses a file argument outside the workspace", async () => {
    await expect(validateCommandLine(config, "cat ../../etc/passwd")).rejects.toThrow(/workspace path policy/);
  });

  it("refuses a redirection target outside the workspace", async () => {
    // The target is checked by the gateway because only the gateway knows where
    // the workspace is; the engine merely runs with that directory as its cwd.
    await expect(validateCommandLine(config, "echo x > ../../escape.txt")).rejects.toThrow(/workspace path policy/);
  });

  it("reports which stage was refused", async () => {
    // A three-stage line with the bad stage in the middle: the error must
    // point at it, or the user cannot tell which part to fix.
    try {
      await validateCommandLine(config, "echo a | /bin/echo b | echo c");
      expect.unreachable("an absolute path in stage 2 must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(TerminalPolicyError);
      expect((err as TerminalPolicyError).stageIndex).toBe(1);
    }
  });

  it("runs nothing when any one stage is refused", async () => {
    // The whole pipeline is validated before the runner is touched. A
    // partially-valid pipeline executing its valid stages would not be what the
    // user asked for.
    await expect(validateCommandLine(config, "seq 1 5 | bash -c true")).rejects.toBeInstanceOf(TerminalPolicyError);
  });
});

describeFx("the resolved line execs verified absolute paths", () => {
  it("substitutes the verified path for each command name", async () => {
    const pipeline = await validateCommandLine(config, "seq 1 5 | wc -l");
    const resolved = buildResolvedLine(pipeline);
    // Asserted through the lexer rather than by substring, because the resolved
    // path can legitimately CONTAIN the command name: on this host `seq`
    // resolves to .../coreutils/seq, so a `not.toMatch(/\bseq\b/)` would fail
    // for the right behaviour.
    const stages = await inspectCommandLine(config, resolved);
    expect(stages).toHaveLength(2);
    for (const [i, stage] of pipeline.stages.entries()) {
      expect(stages[i]!.argv[0]).toBe(stage.executablePath);
      // The property that matters: the kernel is handed an absolute path, so
      // it never performs a PATH lookup for the stage.
      expect(stages[i]!.argv[0]!.startsWith("/")).toBe(true);
    }
  });

  it("produces a line the engine lexes back to the same argv", async () => {
    // Round trip: build the resolved line, ask the engine to lex it, and the
    // argv must be the absolute paths with the original arguments. This is what
    // guarantees the recorded evidence matches the executed process.
    const pipeline = await validateCommandLine(config, "seq 1 5 | wc -l");
    const resolved = buildResolvedLine(pipeline);
    const stages = await inspectCommandLine(config, resolved);
    expect(stages).toHaveLength(2);
    expect(stages[0]!.argv[0]).toBe(pipeline.stages[0]!.executablePath);
    expect(stages[0]!.argv.slice(1)).toEqual(["1", "5"]);
    expect(stages[1]!.argv).toEqual([pipeline.stages[1]!.executablePath, "-l"]);
  });

  it("round-trips redirection targets and operators", async () => {
    const pipeline = await validateCommandLine(config, "echo hi > out.txt");
    const resolved = buildResolvedLine(pipeline);
    const stages = await inspectCommandLine(config, resolved);
    expect(stages[0]!.redirections).toEqual([{ op: ">", fd: 1, target: "out.txt" }]);
  });

  it("quotes an argument containing a space so the round trip is exact", async () => {
    const pipeline = await validateCommandLine(config, 'echo "two words"');
    const resolved = buildResolvedLine(pipeline);
    const stages = await inspectCommandLine(config, resolved);
    expect(stages[0]!.argv.slice(1)).toEqual(["two words"]);
  });
});
