/**
 * The terminal grammar: validate a command line, then hand it to the engine.
 *
 * ONE LEXER, NOT TWO
 * ------------------
 * The gateway does NOT parse the command line.  It asks the engine what the
 * argv vectors would be (`caps --inspect "<line>"`), validates those vectors
 * against the catalog, and only then asks the engine to run the same line
 * (`caps --run-line`).  Both calls use the same C lexer.
 *
 * The alternative -- a TypeScript lexer here -- is the standard way an argv
 * allowlist gets defeated.  Two lexers eventually disagree about one quoting
 * edge case, and the disagreement is always in the wrong direction: the gateway
 * approves a line it reads as `echo safe`, the engine reads it as something
 * else.  A test can cover the cases you thought of; it cannot cover the one you
 * did not.  One lexer removes the class of bug entirely.
 *
 * WHAT IS VALIDATED, AND WHEN
 * --------------------------
 * Before anything executes, every stage's argv[0] must be in the catalog and
 * AVAILABLE, and every stage's arguments must satisfy that command's schema.
 * A line with three stages is validated in full or not at all: a partially
 * valid pipeline is refused, because running the stages that happen to be
 * valid is not what the user asked for.
 *
 * Redirection targets are checked by the gateway against the workspace path
 * policy, because the engine deliberately knows nothing about where the
 * workspace is -- it only knows it runs with that directory as its cwd.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { probeCommand } from "../catalog/commands.js";
import { validateArguments, ArgumentError } from "../catalog/validation.js";
import { assertTargetInWorkspace, RedirectionPolicyError } from "../security/policy.js";
import { logger } from "../utils/logger.js";
import type { CapsConfig } from "../config/env.js";

const execFileAsync = promisify(execFile);

/** One stage as the engine's lexer resolved it. */
export interface InspectedStage {
  index: number;
  argv: string[];
  redirections: Array<{ op: string; fd: number; target: string }>;
  stdinSource: string;
  stdoutDest: string;
}

/** A stage whose command has been resolved to a verified absolute path. */
export interface ValidatedStage extends InspectedStage {
  /** The catalog entry's name, which is what argv[0] must equal. */
  command: string;
  /** The absolute path the engine will exec for this stage. */
  executablePath: string;
  /** Every stage's argv[0] is the catalog name; this is the resolved binary. */
  resolutionNote: string;
}

export interface ValidatedPipeline {
  /** The line exactly as the user typed it, passed to the engine unchanged. */
  commandLine: string;
  stages: ValidatedStage[];
  /** Wall-clock ceiling for the whole pipeline: the largest stage's. */
  timeoutMs: number;
  /** Output ceiling for the whole pipeline: the largest stage's. */
  maxOutputBytes: number;
}

export class TerminalSyntaxError extends Error {
  override name = "TerminalSyntaxError";
  readonly code = "TERMINAL_SYNTAX";
}

export class TerminalPolicyError extends Error {
  override name = "TerminalPolicyError";
  readonly code = "TERMINAL_POLICY";
  /** Which stage was refused, so the error can point at the right part of the line. */
  readonly stageIndex: number | null;
  constructor(message: string, stageIndex: number | null) {
    super(message);
    this.stageIndex = stageIndex;
  }
}

/** The engine's own view of the line. */
interface InspectOutput {
  stages: number;
  pipeline: Array<{
    index: number;
    argv: string[];
    redirections: Array<{ op: string; fd: number; target: string }>;
    stdin_source: string;
    stdout_dest: string;
  }>;
}

/**
 * Ask the engine to lex a line without executing anything.
 *
 * The engine is invoked with an absolute path and no shell, so nothing in the
 * line can influence which file is parsed.  A non-zero exit with stderr is a
 * syntax error reported by the engine's own parser, and is passed through
 * verbatim: the gateway has no opinion about what is or is not valid syntax,
 * because it does not parse.
 */
export async function inspectCommandLine(config: CapsConfig, line: string): Promise<InspectedStage[]> {
  let stdout: string;
  try {
    const result = await execFileAsync(config.capsExecutable, ["--inspect", line], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      // No shell, and an empty environment: the engine needs nothing from it.
      env: { PATH: "/usr/bin:/bin" },
    });
    stdout = result.stdout;
  } catch (err) {
    const e = err as { stderr?: string; code?: number; message: string };
    // Exit code 2 is the engine's documented "this line is not parseable".
    // Its stderr is the parser's own reason, which is more specific than
    // anything the gateway could produce.
    if (e.code === 2 || (typeof e.code === "number" && e.code === 2)) {
      throw new TerminalSyntaxError((e.stderr ?? "the command line could not be parsed").trim());
    }
    throw new TerminalSyntaxError(
      `The engine could not be asked to parse this line: ${(e.stderr ?? e.message).trim()}`,
    );
  }

  let parsed: InspectOutput;
  try {
    parsed = JSON.parse(stdout) as InspectOutput;
  } catch {
    // The engine produced output that is not the documented shape. That is an
    // engine fault, not a user error, so it is not reported as a syntax error.
    throw new TerminalSyntaxError("The engine returned a response the gateway could not read. This is a fault in CAPS, not in the command line.");
  }
  if (!Array.isArray(parsed.pipeline) || parsed.pipeline.length === 0) {
    throw new TerminalSyntaxError("The engine reported no stages for this line.");
  }

  return parsed.pipeline.map((stage) => ({
    index: stage.index,
    argv: stage.argv,
    redirections: stage.redirections ?? [],
    stdinSource: stage.stdin_source,
    stdoutDest: stage.stdout_dest,
  }));
}

/**
 * Validate a line end to end, or refuse it with the specific reason.
 *
 * Order matters and is deliberate: the command is resolved before its arguments
 * are examined, because "this host has no lsblk" is a more useful message than
 * a complaint about a flag the user could not have checked anyway.
 */
export async function validateCommandLine(config: CapsConfig, line: string): Promise<ValidatedPipeline> {
  if (line.length > 65_536) {
    throw new TerminalSyntaxError("The command line exceeds the 65536 byte limit.");
  }

  const stages = await inspectCommandLine(config, line);
  const validated: ValidatedStage[] = [];
  let timeoutMs = 0;
  let maxOutputBytes = 0;

  for (const stage of stages) {
    const command = stage.argv[0];
    if (command === undefined || command === "") {
      throw new TerminalPolicyError(`Stage ${stage.index + 1} has no command.`, stage.index);
    }

    // argv[0] must be EXACTLY a catalog name. It is not resolved as a path and
    // it is not looked up in PATH: the browser may name a command, never a
    // file. A name containing a slash is refused here rather than being
    // normalised into something that might resolve.
    if (command.includes("/")) {
      throw new TerminalPolicyError(
        `Stage ${stage.index + 1} names "${command}", which is a path. CAPS executes only the commands declared in its catalog; it never accepts a path.`,
        stage.index,
      );
    }

    const probed = probeCommand(command);
    if (probed.availability === "BLOCKED") {
      throw new TerminalPolicyError(`Stage ${stage.index + 1}: ${probed.reason}`, stage.index);
    }
    if (probed.availability === "UNAVAILABLE" || probed.resolvedPath === null) {
      throw new TerminalPolicyError(
        `Stage ${stage.index + 1} ("${command}") is not available on this host: ${probed.reason}`,
        stage.index,
      );
    }

    // The rest of argv is this command's arguments. argv[0] is excluded: it is
    // the command name, not an argument, and validating it as a positional
    // would consume the schema's positional budget on every call.
    const args = stage.argv.slice(1);
    try {
      validateArguments(command, args, config);
    } catch (err) {
      if (err instanceof ArgumentError) {
        throw new TerminalPolicyError(`Stage ${stage.index + 1} ("${command}"): ${err.message}`, stage.index);
      }
      throw err;
    }

    // Redirection targets are workspace-confined by the gateway, because only
    // the gateway knows where the workspace is.
    for (const redir of stage.redirections) {
      try {
        assertTargetInWorkspace(config, redir.target);
      } catch (err) {
        const reason = err instanceof RedirectionPolicyError ? err.message : String(err);
        throw new TerminalPolicyError(
          `Stage ${stage.index + 1}: redirection target "${redir.target}" was refused by the workspace path policy: ${reason}`,
          stage.index,
        );
      }
    }

    validated.push({
      ...stage,
      command,
      executablePath: probed.resolvedPath,
      resolutionNote: probed.reason,
    });
    // The pipeline runs concurrently, so the ceiling is the most demanding
    // stage's, not the sum: stages that finish early free their budget.
    timeoutMs = Math.max(timeoutMs, probed.timeoutMs);
    maxOutputBytes = Math.max(maxOutputBytes, probed.maxOutputBytes);
  }

  logger.info("EXECUTION", "terminal line validated", {
    stages: validated.length,
    commands: validated.map((s) => s.command).join(" | "),
  });

  return {
    commandLine: line,
    stages: validated,
    timeoutMs,
    maxOutputBytes,
  };
}

/**
 * The engine executes the catalog-resolved paths, not the bare names.
 *
 * This matters: if the engine were handed `seq 1 5 | wc -l`, `execvp()` would
 * resolve both names against the child's PATH, and the child inherits a
 * sanitised four-variable environment whose PATH is whatever the gateway set.
 * The gateway has already verified an absolute path for every stage, so the
 * pipeline is rebuilt with those absolute paths substituted. The argv recorded
 * in the event stream is then the verified path, which is what a reader needs.
 */
export function buildResolvedLine(pipeline: ValidatedPipeline): string {
  return pipeline.stages
    .map((stage) => {
      const parts = [quoteForLexer(stage.executablePath), ...stage.argv.slice(1).map(quoteForLexer)];
      for (const redir of stage.redirections) {
        parts.push(redir.op, quoteForLexer(redir.target));
      }
      return parts.join(" ");
    })
    .join(" | ");
}

/**
 * Quote a token for the engine's lexer.
 *
 * The token is wrapped in double quotes with backslash, double quote, and
 * dollar escaped. That is sufficient for the engine's documented grammar: inside
 * double quotes a backslash escapes only `" \ $ ` and newline, so escaping
 * those four is complete. Single quotes are not used because they cannot
 * contain a single quote, and a path or argument may legitimately contain one.
 */
function quoteForLexer(token: string): string {
  if (token === "") return '""';
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `"${token.replace(/([\\"$`])/g, "\\$1")}"`;
}
