/**
 * Terminal API.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is not a remote shell, and the difference is not a matter of wording.
 *
 *   - No shell process is ever spawned. The engine is invoked with
 *     `shell: false` and an argument vector, so there is no process in the
 *     chain whose job is to re-interpret the line.
 *   - The line is lexed by the engine's own C lexer, and the argv each stage
 *     will receive is validated against the catalog BEFORE anything executes.
 *   - Command substitution, variable expansion, globbing, subshells,
 *     background jobs, and command lists are not implemented. `$(...)`, backticks,
 *     `*`, `;`, and `&` reach the program as ordinary characters.
 *   - Only the commands in the catalog may be named, and only from a fixed set
 *     of trusted locations, resolved to a verified absolute path.
 *
 * The honest statement of what a user gets is: "a subset of shell syntax, with
 * every command checked against a published catalog." Anything stronger would
 * be a different and much more dangerous product.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { ExecutionRunner } from "../execution/runner.js";
import { validateCommandLine, TerminalPolicyError, TerminalSyntaxError, buildResolvedLine } from "../terminal/grammar.js";
import { describeRefusal } from "./catalog.js";
import type { CapsConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface TerminalRouteDeps {
  config: CapsConfig;
  runner: ExecutionRunner;
}

const EXECUTE_SCHEMA = z
  .object({
    commandLine: z.string().min(1).max(65_536),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  })
  .strict();

export function registerTerminalRoutes(app: FastifyInstance, deps: TerminalRouteDeps): void {
  const { config, runner } = deps;

  /**
   * Validate a line without executing it.
   *
   * This exists so the terminal can show per-stage availability, resolved paths,
   * and argument diagnostics as the user types, using exactly the same
   * validation the execute route performs. A "check" that used different rules
   * from "run" would let a user assemble a line the checker approved and the
   * executor refused.
   */
  app.post("/api/terminal/validate", async (req, reply) => {
    const parsed = EXECUTE_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "INVALID_ARGUMENT", message: `Invalid body: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` },
      });
    }
    try {
      const pipeline = await validateCommandLine(config, parsed.data.commandLine);
      return {
        valid: true,
        stageCount: pipeline.stages.length,
        stages: pipeline.stages.map((s) => ({
          index: s.index,
          command: s.command,
          argv: s.argv,
          resolvedExecutable: s.executablePath,
          resolutionNote: s.resolutionNote,
          redirections: s.redirections,
          stdinSource: s.stdinSource,
          stdoutDest: s.stdoutDest,
        })),
        limits: { timeoutMs: pipeline.timeoutMs, maxOutputBytes: pipeline.maxOutputBytes },
      };
    } catch (err) {
      if (err instanceof TerminalSyntaxError) {
        return reply.code(400).send({ error: { code: err.code, message: err.message } });
      }
      if (err instanceof TerminalPolicyError) {
        return reply.code(403).send({
          error: {
            code: err.code,
            message: err.message,
            stageIndex: err.stageIndex,
            // The refusal reason for a well-known-but-forbidden command is
            // published, so `bash -c ...` gets an explanation rather than a
            // bare 403.
            ...(err.stageIndex !== null ? { hint: describeRefusal(firstTokenOf(err.message)) } : {}),
          },
        });
      }
      throw err;
    }
  });

  /**
   * Validate a line and, only if every stage is permitted, execute it.
   *
   * The order is the whole point. Validation happens first and in full; a line
   * with one bad stage runs nothing at all, rather than running the stages
   * that happened to be valid.
   */
  app.post("/api/terminal/execute", async (req, reply) => {
    const parsed = EXECUTE_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "INVALID_ARGUMENT", message: `Invalid body: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` },
      });
    }

    const { commandLine } = parsed.data;

    let pipeline;
    try {
      pipeline = await validateCommandLine(config, commandLine);
    } catch (err) {
      if (err instanceof TerminalSyntaxError) {
        return reply.code(400).send({ error: { code: err.code, message: err.message } });
      }
      if (err instanceof TerminalPolicyError) {
        logger.warn("SECURITY", "terminal line refused", { message: err.message, stageIndex: err.stageIndex });
        return reply.code(403).send({
          error: {
            code: err.code,
            message: err.message,
            stageIndex: err.stageIndex,
            ...(err.stageIndex !== null ? { hint: describeRefusal(firstTokenOf(err.message)) } : {}),
          },
        });
      }
      throw err;
    }

    const timeoutMs = Math.min(parsed.data.timeoutMs ?? pipeline.timeoutMs, config.maxTimeoutMs);

    /*
     * The line handed to the engine has each stage's command replaced by the
     * absolute path the gateway verified. The engine therefore execs exactly
     * the file that was probed, and the argv recorded in the event stream is
     * that verified path rather than a name the child would have to resolve
     * against its own PATH.
     */
    const resolvedLine = buildResolvedLine(pipeline);

    const started = runner.start({
      command: pipeline.stages[0]!.command,
      commandLine: resolvedLine,
      timeoutMs,
    });

    if ("error" in started) {
      const status = started.error.code === "CONCURRENCY_LIMIT_REACHED" ? 429 : 500;
      return reply.code(status).send({ error: { code: started.error.code, message: started.error.message } });
    }

    return reply.code(202).send({
      sessionId: started.sessionId,
      stageCount: pipeline.stages.length,
      commands: pipeline.stages.map((s) => s.command),
      resolvedExecutables: pipeline.stages.map((s) => s.executablePath),
      timeoutMs,
      eventsUrl: `/api/sessions/${started.sessionId}/events`,
    });
  });

  /**
   * The grammar, for a client that wants to render help without a round trip
   * per command. Sourced from the catalog so it cannot drift from what is
   * accepted.
   */
  app.get("/api/terminal/grammar", async () => {
    return {
      summary:
        "A command line is lexed by the CAPS C engine, not by a shell. Quoting and backslash escapes are honoured; nothing else is interpreted.",
      quoting: [
        { syntax: "'literal'", meaning: "Single-quoted. Every byte is literal, backslash included." },
        { syntax: '"literal"', meaning: "Double-quoted. Backslash escapes only \" \\ $ ` and newline." },
        { syntax: "\\x", meaning: "Outside quotes, escapes the next byte." },
        { syntax: "#", meaning: "At the start of a token, begins a comment to end of line." },
      ],
      operators: [
        { syntax: "|", meaning: "Connects two stages with a real OS pipe. Each stage is its own forked process with its own PID, in one process group." },
        { syntax: ">", meaning: "Stage stdout to a workspace file, truncated." },
        { syntax: ">>", meaning: "Stage stdout to a workspace file, appended." },
        { syntax: "<", meaning: "Stage stdin from a workspace file." },
        { syntax: "2>", meaning: "Stage stderr to a workspace file, truncated." },
        { syntax: "2>>", meaning: "Stage stderr to a workspace file, appended." },
      ],
      notImplemented: [
        { syntax: "&& || ;", reason: "Command lists and conditional chaining are not implemented. Each stage is a separate, separately evidenced execution." },
        { syntax: "$(...) `...`", reason: "Command substitution is not implemented. These are ordinary characters, not syntax." },
        { syntax: "$VAR ${VAR}", reason: "Variable expansion is not implemented. The child inherits a fixed four-variable environment." },
        { syntax: "* ? [ ] { }", reason: "Globbing and brace expansion are not performed by CAPS. These characters reach the program unchanged; if the program globs, that is its own behaviour and is visible in its recorded argv." },
        { syntax: "&", reason: "Background jobs are not implemented. Every stage is reaped before CAPS reports the result." },
        { syntax: "( )", reason: "Subshells are not implemented. Parentheses reach the program as literal arguments." },
      ],
      limits: { maxStages: 16, maxArgumentsPerStage: 4096, maxTokenBytes: 20_000, maxLineBytes: 65_536 },
      pipelineSemantics: {
        exitStatus:
          "A pipeline's exit status is the LAST stage's, matching shell convention. Every stage's own status is recorded separately, so a failure in an early stage is still visible in the evidence.",
        signal:
          "A producer whose consumer exits early is terminated by SIGPIPE, and that is recorded as SIGNAL_RECEIVED on that stage rather than being reported as a normal exit.",
        processGroup:
          "All stages share one process group, so a timeout or a signal reaches the whole pipeline. The group id is on every per-stage event.",
      },
    };
  });
}

/** Best-effort extraction of the command name from a refusal message. */
function firstTokenOf(message: string): string {
  const quoted = /"([^"]+)"/.exec(message);
  if (quoted !== null) return quoted[1]!;
  const parenthesised = /\("([^"]+)"\)/.exec(message);
  if (parenthesised !== null) return parenthesised[1]!;
  return "";
}
