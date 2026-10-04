/**
 * Terminal rendering: quoting, stage descriptions, and limit checks.
 *
 * These are pure functions over gateway responses, so they are tested directly
 * rather than through a rendered component. The property that matters is
 * losslessness: a rendered argv must show the same boundaries the program
 * receives, because an argv display that drops quoting is how a reader comes to
 * believe `rm -rf "my dir"` was two arguments.
 */

import { describe, expect, it } from "vitest";

import type { GrammarResponse, TerminalValidation, ValidatedStage } from "../src/api/observability";
import {
  describeRedirection,
  describeStdin,
  describeStdout,
  filterCommands,
  formatArgv,
  groupByCategory,
  localLimitWarnings,
  nextCommandIndex,
  quoteArgv,
  renderResolvedLine,
  resolutionDiffers,
  summariseRedirections,
} from "../src/lib/terminal";

/**
 * A validated stage, shaped like the one the gateway actually sends.
 *
 * `resolvedExecutable` is the field name in the API. The fixture previously used
 * `executablePath`, an invention that matched the equally invented field in the
 * declared type -- so the type, the fixture and the component all agreed with
 * each other and none of them agreed with the gateway, and the terminal rendered
 * an empty cell where the resolved path belongs.
 */
function stage(overrides: Partial<ValidatedStage> = {}): ValidatedStage {
  return {
    index: 0,
    command: "seq",
    argv: ["seq", "1", "5"],
    redirections: [],
    stdinSource: "inherit",
    stdoutDest: "inherit",
    resolvedExecutable: "/usr/bin/seq",
    resolutionNote: "resolved from /usr/bin",
    ...overrides,
  };
}

describe("argv rendering is lossless", () => {
  it("leaves a simple argument untouched", () => {
    expect(quoteArgv("hello")).toBe("hello");
    expect(quoteArgv("/usr/bin/seq")).toBe("/usr/bin/seq");
  });

  it("quotes an argument containing a space", () => {
    expect(quoteArgv("my dir")).toBe("'my dir'");
  });

  it("renders an empty argument visibly", () => {
    // An empty argv element is a real argument. Rendering it as a blank would
    // erase it from the display while the program still receives it.
    expect(quoteArgv("")).toBe("''");
  });

  it("quotes a shell metacharacter so the boundary is unambiguous", () => {
    expect(quoteArgv("a|b")).toBe("'a|b'");
    expect(quoteArgv("$HOME")).toBe("'$HOME'");
    expect(quoteArgv("a;b")).toBe("'a;b'");
    expect(quoteArgv("*")).toBe("'*'");
  });

  it("escapes an embedded single quote the shell way", () => {
    // Close the quote, emit an escaped quote, reopen. This is the only
    // portable way to represent a single quote inside single quotes.
    expect(quoteArgv("it's")).toBe(`'it'"'"'s'`);
  });

  it("joins argv with spaces, quoting only what needs it", () => {
    expect(formatArgv(["wc", "-l", "my file.txt"])).toBe("wc -l 'my file.txt'");
  });

  it("preserves an empty argument through a join", () => {
    expect(formatArgv(["echo", "", "x"])).toBe("echo '' x");
  });
});

describe("redirections are named by the descriptor the engine will use", () => {
  it("names stdin, stdout and stderr from the fd", () => {
    expect(describeRedirection(0, "<", "in.txt").stream).toBe("stdin");
    expect(describeRedirection(1, ">", "out.txt").stream).toBe("stdout");
    expect(describeRedirection(2, "2>", "err.txt").stream).toBe("stderr");
  });

  it("keeps `>` and `2>` distinct", () => {
    // Collapsing these into one row would hide exactly the thing that went
    // wrong when a reader is debugging why stderr went to the wrong file.
    const s = stage({
      redirections: [
        { op: ">", fd: 1, target: "out.txt" },
        { op: "2>", fd: 2, target: "err.txt" },
      ],
    });
    const summaries = summariseRedirections(s);
    expect(summaries).toHaveLength(2);
    expect(summaries.map((x) => x.stream)).toEqual(["stdout", "stderr"]);
    expect(summaries[0]!.target).not.toBe(summaries[1]!.target);
  });

  it("reports an fd the operator redirected directly", () => {
    expect(describeRedirection(3, ">", "x").stream).toBe("fd 3");
  });
});

describe("stream endpoints are described from the engine's own words", () => {
  it("says a piped stage reads the previous stage", () => {
    expect(describeStdin(stage({ stdinSource: "pipe" }))).toMatch(/previous stage/);
  });

  it("says a piped stage writes to the next", () => {
    expect(describeStdout(stage({ stdoutDest: "pipe" }))).toMatch(/next stage/);
  });

  it("names the file when a stage reads from one", () => {
    const s = stage({
      stdinSource: "file",
      redirections: [{ op: "<", fd: 0, target: "in.txt" }],
    });
    expect(describeStdin(s)).toContain("in.txt");
  });

  it("names the file when a stage writes to one", () => {
    const s = stage({
      stdoutDest: "file",
      redirections: [{ op: ">", fd: 1, target: "out.txt" }],
    });
    expect(describeStdout(s)).toContain("out.txt");
  });

  it("says stdout is collected by the gateway on the last stage", () => {
    expect(describeStdout(stage({ stdoutDest: "inherit" }))).toMatch(/collected by the gateway/);
  });
});

describe("the resolved line is built from argv, not from the user's text", () => {
  const twoStages: TerminalValidation = {
    valid: true,
    stageCount: 2,
    stages: [
      stage({ index: 0, command: "seq", argv: ["seq", "1", "5"], stdoutDest: "pipe" }),
      stage({ index: 1, command: "cat", argv: ["cat"], stdinSource: "pipe" }),
    ],
    // The gateway nests the bounds inside `limits`, and does not echo the
    // command line back. The previous fixture put `timeoutMs` and
    // `maxOutputBytes` at the top level and gave `limits` a grammar shape the
    // validate route never returns.
    limits: { timeoutMs: 5000, maxOutputBytes: 65536 },
  };

  it("joins stages with the pipe operator", () => {
    expect(renderResolvedLine(twoStages)).toBe("seq 1 5 | cat");
  });

  it("reports no difference for a line that is already in resolved form", () => {
    expect(resolutionDiffers("seq 1 5 | cat", twoStages)).toBe(false);
  });

  it("reports a difference when the engine read the line differently", () => {
    /*
     * The case the indicator exists for.
     *
     * The user typed `seq '1 5'`, which the engine's lexer reads as ONE
     * argument. The fixture records the argv it would actually exec, which for
     * a user who meant two arguments is wrong -- so the display must differ from
     * the input and the terminal must say so.
     *
     * The comparison is over tokens rather than raw text, so the case that
     * matters is a difference in WHICH tokens there are. Quoting that changes
     * nothing is asserted separately below.
     */
    const engineReadOneArg: TerminalValidation = {
      ...twoStages,
      stages: [{ ...twoStages.stages[0]!, argv: ["seq", "1 5"] }, twoStages.stages[1]!],
    };
    expect(renderResolvedLine(engineReadOneArg)).toBe("seq '1 5' | cat");
    expect(resolutionDiffers("seq 1 5 | cat", engineReadOneArg)).toBe(true);
  });

  it("reports a difference when a redirection target differs", () => {
    // Changing WHERE output goes changes what runs, so it must be surfaced.
    const toOtherFile: TerminalValidation = {
      ...twoStages,
      stages: [
        {
          ...twoStages.stages[0]!,
          argv: ["echo", "hi"],
          command: "echo",
          stdoutDest: "file",
          redirections: [{ op: ">", fd: 1, target: "other.txt" }],
        },
      ],
    };
    expect(resolutionDiffers("echo hi >out.txt", toOtherFile)).toBe(true);
  });

  it("does not flag a difference that is only quoting of the same arguments", () => {
    // `seq '1' '5'` and `seq 1 5` request the identical argv. Treating the
    // quoting difference as a divergence would make the indicator meaningless:
    // a reader who is warned every time they quote correctly stops reading it.
    expect(resolutionDiffers("seq '1' '5' | cat", twoStages)).toBe(false);
  });

  it("does not flag extra internal whitespace", () => {
    expect(resolutionDiffers("  seq   1    5  |  cat ", twoStages)).toBe(false);
  });

  it("appends a redirection to the stage that carries it", () => {
    const redirected: TerminalValidation = {
      ...twoStages,
      stages: [
        {
          ...twoStages.stages[0]!,
          argv: ["echo", "hi"],
          command: "echo",
          stdoutDest: "file",
          redirections: [{ op: ">", fd: 1, target: "out.txt" }],
        },
      ],
    };
    expect(renderResolvedLine(redirected)).toBe("echo hi >out.txt");
  });
});

describe("client-side limit checks are advisory only", () => {
  const grammar: GrammarResponse = {
    summary: "",
    quoting: [],
    operators: [],
    notImplemented: [],
    limits: { maxStages: 3, maxArgumentsPerStage: 10, maxTokenBytes: 100, maxLineBytes: 40 },
    pipelineSemantics: { exitStatus: "", signal: "", processGroup: "" },
  };

  it("warns about an over-long line", () => {
    const warnings = localLimitWarnings("x".repeat(50), grammar);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/40/);
  });

  it("warns about too many apparent stages", () => {
    const warnings = localLimitWarnings("a | b | c | d", grammar);
    expect(warnings.some((w) => /stages/.test(w))).toBe(true);
  });

  it("says nothing for a line within the limits", () => {
    expect(localLimitWarnings("a | b", grammar)).toEqual([]);
  });

  it("produces nothing when the grammar has not loaded", () => {
    // A missing grammar is not a licence to warn about everything.
    expect(localLimitWarnings("a | b | c | d | e", null)).toEqual([]);
  });
});

describe("catalog filtering and grouping", () => {
  it("prefix-matches on the command name", () => {
    const cmds = [{ name: "cat" }, { name: "catx" }, { name: "wc" }];
    expect(filterCommands(cmds, "cat").map((c) => c.name)).toEqual(["cat", "catx"]);
  });

  it("returns everything for an empty query", () => {
    const cmds = [{ name: "wc" }, { name: "cat" }];
    expect(filterCommands(cmds, "  ")).toHaveLength(2);
  });

  it("matches case-insensitively", () => {
    expect(filterCommands([{ name: "Seq" }], "seq")).toHaveLength(1);
  });

  it("groups by the gateway's category and sorts the groups", () => {
    const groups = groupByCategory([
      { name: "wc", category: "file" },
      { name: "ps", category: "process" },
      { name: "cat", category: "file" },
    ]);
    expect([...groups.keys()]).toEqual(["file", "process"]);
    expect(groups.get("file")).toHaveLength(2);
  });

  it("wraps the command cycle", () => {
    expect(nextCommandIndex(0, 3)).toBe(1);
    expect(nextCommandIndex(2, 3)).toBe(0);
    expect(nextCommandIndex(0, 0)).toBe(0);
  });
});
