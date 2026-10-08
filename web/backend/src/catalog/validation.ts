/**
 * Argument validation and command help, both derived from the catalog.
 *
 * NOTHING HERE RE-DEFINES A RULE
 * ------------------------------
 * The catalog entry is the only place a flag, a bound, or a path policy is
 * stated.  This module reads it and enforces it.  That is why there is no
 * per-command `if` anywhere below: adding a flag means editing the catalog
 * entry and nothing else, so a flag can never be accepted by the validator
 * while being absent from the help the user read.
 *
 * WHY VALIDATION IS WORTH HAVING FOR A SHIPPING BINARY
 * ---------------------------------------------------
 * The executables are allowlisted and the argv is passed as a vector rather
 * than a shell string, so the classic injection routes are already closed.
 * What is left is argument abuse: `head -c 100000000000` allocating a buffer
 * that size, or `cat ../../etc/shadow` reading outside the workspace.  Both are
 * refused here, with the specific rule that refused them named in the error.
 */

import { probeCommand, type ArgumentSchema, type ProbedCommand } from "./commands.js";
import type { CapsConfig } from "../config/env.js";
import { assertReadableFileInWorkspace, RedirectionPolicyError } from "../security/policy.js";
import { findAwkProgramViolations, findSedScriptViolations } from "./programPolicy.js";

export class ArgumentError extends Error {
  override name = "ArgumentError";
  readonly code = "ARGUMENT_REJECTED";
  /** The catalog rule that refused this argument, quoted for the user. */
  readonly rule: string;

  constructor(message: string, rule: string) {
    super(message);
    this.rule = rule;
  }
}

/**
 * Enforce one command's argument schema.
 *
 * Returns the argument list unchanged on success so callers can use the result
 * directly.  Throws `ArgumentError` with the specific rule on the first
 * violation, because a list of every problem in a 40-argument request is not
 * more useful than the first one.
 */
export function validateArguments(
  command: string,
  args: readonly string[],
  config: CapsConfig,
): readonly string[] {
  const probed = probeCommand(command);

  if (probed.availability === "BLOCKED") {
    throw new ArgumentError(
      `"${command}" is not permitted by policy: ${probed.reason}`,
      "the command must be declared in the catalog",
    );
  }
  if (probed.availability === "UNAVAILABLE") {
    // Deliberately a distinct error from BLOCKED. "This host does not have
    // lsblk" and "you may not run this" are different facts and the user can
    // act on only one of them.
    throw new ArgumentError(
      `"${command}" is not available on this host: ${probed.reason}`,
      "the executable must exist in a trusted directory and be executable",
    );
  }

  const schema = probed.argumentSchema;
  let positional = 0;

  /*
   * Walk the argument vector once, classifying each token, so the path check
   * below can use the same classification.
   *
   * Doing this twice was the bug: the first pass counted positionals correctly
   * and skipped flag values, while the second pass re-walked the raw argv and
   * treated everything non-dash-prefixed as a file. So `head -c 99999999 f`
   * reported "file argument must be an existing workspace file" about the
   * number 99999999, naming a completely unrelated rule.
   */
  interface Classified {
    readonly index: number;
    readonly value: string;
    readonly isPath: boolean;
  }
  const pathsToCheck: Classified[] = [];
  let pendingFlagTakesValue = false;
  let positionalSeen = 0;
  /** Positional 1, when the schema has a leading mode word. */
  let leadingChoice: string | null = null;
  const leadingPatterns = schema.leadingPatternPositionals ?? 0;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;

    if (arg.length > schema.maxArgumentBytes) {
      throw new ArgumentError(
        `argument for "${command}" is ${arg.length} bytes, over the ${schema.maxArgumentBytes} byte limit`,
        `each argument must be at most ${schema.maxArgumentBytes} bytes`,
      );
    }
    if (arg.includes("\0")) {
      throw new ArgumentError(`argument for "${command}" contains a NUL byte`, "arguments may not contain NUL");
    }

    // A value belonging to the preceding flag is neither a flag nor a
    // positional, and must not be path-checked. `head -c 999999999` is a
    // count, not a file name.
    if (pendingFlagTakesValue) {
      pendingFlagTakesValue = false;
      if (schema.positionalIntegers !== undefined) {
        assertIntegerInRange(command, arg, schema.positionalIntegers);
      }
      continue;
    }

    if (arg.startsWith("-") && arg !== "-") {
      /*
       * POSIX short options compose. A literal-string allowlist cannot express
       * that, and refusing it makes the tool unusable in the forms people
       * actually type: `du -sh`, `ss -ltn`, `cut -d:`, `grep -i pattern`.
       *
       * So a short option is walked character by character, which is what
       * getopt(3) does:
       *
       *   -sh      two flags, neither taking a value
       *   -d:      `-d` with its value glued on
       *   -n5      `-n` with its value glued on
       *   -ltnp    three flags, the last taking the next token
       *
       * A cluster is accepted only if EVERY character is individually
       * allowed, so composition widens nothing: it cannot be used to smuggle
       * in a flag the catalog does not declare.
       */
      const numeric = schema.numericCountFlag;
      if (numeric !== undefined && /^-[0-9]{1,10}$/.test(arg)) {
        assertIntegerInRange(command, arg.slice(1), numeric);
        continue;
      }

      if (arg.startsWith("--")) {
        // A long option is a name, never a cluster. Accepted only if the
        // catalog lists it verbatim.
        if (!schema.flags.includes(arg)) {
          throw new ArgumentError(unknownFlagMessage(command, arg, schema), "only the flags listed in the catalog entry are accepted, and short options may only combine flags it lists");
        }
        continue;
      }

      /*
       * An exact match wins before any decomposition.
       *
       * Some entries list a multi-character flag on purpose -- `ip -br` is one
       * flag meaning "brief", not `-b` followed by `-r`. Decomposing it would
       * read it as a cluster and refuse a flag the catalog deliberately
       * allows, so the literal list is consulted first.
       */
      if (schema.flags.includes(arg)) {
        pendingFlagTakesValue = takesValue(schema, arg);
        continue;
      }

      for (let k = 1; k < arg.length; k += 1) {
        const flag = `-${arg[k]!}`;
        if (!schema.flags.includes(flag)) {
          throw new ArgumentError(unknownFlagMessage(command, arg, schema), "only the flags listed in the catalog entry are accepted, and short options may only combine flags it lists");
        }
        if (takesValue(schema, flag)) {
          const glued = arg.slice(k + 1);
          if (glued.length > 0) {
            /*
             * The attached value is bounded exactly as the separated form
             * would be, so gluing is not a way around a limit. It checks
             * `positionalIntegers` first because that is the command's declared
             * numeric bound, and falls back to `numericCountFlag` so a command
             * that declares a short-form count bounds the glued spelling too.
             */
            if (schema.positionalIntegers !== undefined) {
              assertIntegerInRange(command, glued, schema.positionalIntegers);
            } else if (schema.numericCountFlag !== undefined && /^\d{1,10}$/.test(glued)) {
              assertIntegerInRange(command, glued, schema.numericCountFlag);
            }
            break;
          }
          pendingFlagTakesValue = true;
          break;
        }
      }
      continue;
    }

    positional += 1;
    if (positional > schema.maxPositional) {
      throw new ArgumentError(
        `"${command}" accepts at most ${schema.maxPositional} positional argument(s), got ${positional}`,
        `at most ${schema.maxPositional} positional arguments`,
      );
    }
    if (schema.positionalIntegers !== undefined) {
      assertIntegerInRange(command, arg, schema.positionalIntegers);
    }

    /*
     * A leading mode word, and the operand type it implies.
     *
     * Enforced in the catalog's terms rather than per command: positional 1 must
     * be one of `leadingChoices`, and positional 2 is checked as an integer only
     * when the chosen mode is one of `choiceIntegerOperands.for`. `status_probe
     * print alpha beta` has to stay legal, which is why the integer rule is
     * conditional instead of a flat `positionalIntegers`.
     */
    if (positional === 1 && schema.leadingChoices !== undefined) {
      if (!schema.leadingChoices.includes(arg)) {
        throw new ArgumentError(
          `"${arg}" is not a mode of "${command}"`,
          `the first argument must be one of ${schema.leadingChoices.map((c) => `"${c}"`).join(", ")}`,
        );
      }
      leadingChoice = arg;
    } else if (positional === 2 && leadingChoice !== null && schema.choiceIntegerOperands !== undefined) {
      if (schema.choiceIntegerOperands.for.includes(leadingChoice)) {
        assertIntegerInRange(command, arg, {
          min: schema.choiceIntegerOperands.min,
          max: schema.choiceIntegerOperands.max,
        });
      }
    }

    /*
     * A leading pattern is data, not a path -- but only if it LOOKS like data.
     *
     * `leadingPatternPositionals` says "the first N positionals are the
     * grep/awk/sed pattern". Taking that unconditionally was unsound: GNU head and
     * tail accept a bare FILE in operand 1, so `head /etc/hostname` was exempt
     * from the workspace policy and returned the contents of a file outside the
     * workspace, while `wc /etc/passwd` -- one command over, with no leading
     * pattern -- was correctly refused.
     *
     * A pattern operand is also constrained by its own schema (a regular
     * expression, a shell fragment), so a candidate that clearly is not one is
     * treated as a path. `head 5` stays a count; `head /etc/hostname` becomes a
     * path and is checked.
     */
    const isLeadingPattern = positionalSeen < leadingPatterns && !looksLikePath(arg);
    positionalSeen += 1;

    /*
     * A leading operand that is an EXECUTED PROGRAM is checked separately from
     * the path policy, because the path policy cannot see what the program does.
     *
     * The exemption below is what makes `awk PROGRAM FILE` and `sed SCRIPT FILE`
     * usable at all, and it is exactly why the program needs its own rule: an awk
     * program can call a shell, read a file outside the workspace, or write one,
     * none of which any argument-shape rule can intercept. Without this the
     * gateway accepts and runs
     *
     *   awk 'BEGIN{system("id > /tmp/x")}'
     *
     * which is the capability CAPS refuses python, perl, node, ruby, php, gcc
     * and make for. See catalog/programPolicy.ts for the scanner and the
     * reasoning behind each refusal.
     */
    if (schema.programOperand !== undefined && positionalSeen === 1) {
      assertProgramOperand(command, schema.programOperand, arg);
    }

    const isPath = schema.positionalArePaths && !isLeadingPattern;
    pathsToCheck.push({ index: i, value: arg, isPath });
  }

  for (const candidate of pathsToCheck) {
    if (!candidate.isPath) continue;
    try {
      assertReadableFileInWorkspace(config, candidate.value);
    } catch (err) {
      const reason = err instanceof RedirectionPolicyError ? err.message : String(err);
      throw new ArgumentError(
        `"${candidate.value}" (argument ${candidate.index + 1}) was refused by the workspace path policy: ${reason}`,
        "file arguments must name an existing regular file inside the CAPS workspace",
      );
    }
  }

  return args;
}

/**
 * Refuse a program operand that would break out of the no-shell, confined
 * workspace model.
 *
 * The first violation found is reported, with its kind named, because "awk
 * program refused" without saying which construct was seen is not something the
 * user can act on. The message quotes the offending program so the user can see
 * which part of their own input was the problem.
 */
function assertProgramOperand(
  command: string,
  language: NonNullable<ArgumentSchema["programOperand"]>,
  program: string,
): void {
  const violations =
    language === "awk" ? findAwkProgramViolations(program) : findSedScriptViolations(program);
  const first = violations[0];
  if (first === undefined) return;

  const what = language === "awk" ? "awk program" : "sed script";
  throw new ArgumentError(
    `the ${what} "${truncateForMessage(program)}" was refused: ${first.rule}`,
    first.rule,
  );
}

/** Keep a refusal message readable when the operand is at the schema byte limit. */
function truncateForMessage(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

/**
 * True when an argument is unmistakably a filesystem path rather than data.
 *
 * Deliberately conservative and narrow: it fires only on the shapes that cannot
 * be a pattern, a count, or a shell fragment. A relative bare word like `notes`
 * is NOT treated as a path here, because `grep notes file` is a perfectly
 * ordinary search pattern -- treating it as a path would refuse valid commands.
 * The absolute and parent-relative forms are the ones that can escape a
 * workspace, and those are what this catches.
 */
function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value === ".." || value === ".";
}

/** Reject anything that is not a plain decimal integer inside the bounds. */
function assertIntegerInRange(
  command: string,
  value: string,
  bounds: { min: number; max: number },
): void {
  if (!/^\d{1,10}$/.test(value)) {
    throw new ArgumentError(
      `"${value}" is not a plain non-negative integer for "${command}"`,
      "numeric arguments must be plain decimal digits",
    );
  }
  const n = Number(value);
  if (n < bounds.min || n > bounds.max) {
    throw new ArgumentError(
      `${n} is outside the permitted range ${bounds.min}..${bounds.max}`,
      `numeric arguments must be between ${bounds.min} and ${bounds.max}`,
    );
  }
}

/**
 * Flags that take a separate value argument.
 *
 * Only used to keep a value out of the positional count. The value is still
 * validated by the length and content rules above, which is deliberate: a
 * value like `-n`'s count is not a path even when the command is a file
 * reader, and treating it as one would refuse `head -n 5 file`.
 */
/**
 * Whether this command's flag takes a value.
 *
 * Per command, never global. `-n` is a count for `head` and a boolean for
 * `sort`; `-e` is a script for `sed` and "every process" for `ps`. Treating
 * them uniformly meant `ps -e --anything` validated, because `-e` swallowed the
 * next token as its value and nothing checked it.
 */
function takesValue(schema: ArgumentSchema, flag: string): boolean {
  return (schema.valueFlags ?? []).includes(flag);
}

/**
 * The refusal for an unknown flag, naming what IS accepted.
 *
 * States the numeric short form when the command has one, because otherwise a
 * reader who typed `head -1` is told to use `-n`, which does not explain the
 * rule they are actually hitting.
 */
function unknownFlagMessage(command: string, arg: string, schema: ArgumentSchema): string {
  const numeric = schema.numericCountFlag;
  const numericForm = numeric === undefined ? "" : `, or a count like ${numeric.flag} 5 written as -5`;
  const combinable = schema.flags.filter((f) => f.length === 2).slice(0, 3);
  const clusterForm =
    combinable.length === 0 ? "" : ` Short options combine, so -${combinable.map((f) => f.slice(1)).join("")} means what it would mean in a shell.`;
  return (
    `"${arg}" is not an accepted flag for "${command}". ` +
    `Accepted: ${schema.flags.length === 0 ? "none" : schema.flags.join(", ")}${numericForm}.${clusterForm}`
  );
}

/**
 * The help text for one command, generated from its catalog entry.
 *
 * The frontend never writes this text. It receives it from `/api/catalog`,
 * which builds it here, so the documented argument rules and the enforced
 * argument rules are the same object by construction rather than by review.
 */
export function commandHelp(name: string): {
  name: string;
  availability: ProbedCommand["availability"];
  availabilityReason: string;
  executable: string | null;
  category: string;
  description: string;
  whyAllowed: string;
  safeArguments: string;
  telemetryRelevance: string;
  securityRestrictions: string[];
  examples: readonly { command: string; note: string }[];
} | null {
  const probed = probeCommand(name);
  if (probed.availability === "BLOCKED" && probed.resolvedPath === null && probed.rationale === "None. This command is refused by policy.") {
    return null;
  }
  const definition = probed;

  const restrictions: string[] = [
    "No shell is involved. The argv vector is built from this catalog and passed to execvp() directly, so no quoting, globbing, variable expansion, or command substitution is ever interpreted by CAPS.",
    "The executable is resolved once from a fixed set of trusted directories and pinned to an absolute path. PATH is never consulted, and a symlinked binary is refused.",
    "The browser may name a command from this catalog and its arguments. It may never name a path, and it cannot influence which file is executed.",
  ];
  if (definition.argumentSchema.positionalArePaths) {
    restrictions.push("File arguments are resolved inside the CAPS workspace. Absolute paths, '..', symbolic links, and anything outside the workspace are refused.");
  } else {
    restrictions.push("This command takes no file arguments, so the workspace path policy does not apply to it.");
  }
  if (definition.argumentSchema.flags.length === 0) {
    restrictions.push("No flags are accepted for this command.");
  } else {
    restrictions.push(`Only these flags are accepted: ${definition.argumentSchema.flags.join(", ")}. Everything else is refused by name.`);
  }
  if (definition.argumentSchema.numericCountFlag !== undefined) {
    const n = definition.argumentSchema.numericCountFlag;
    // Stated here because the validator enforces it, and the catalog publishes
    // examples using it. Help that omitted it would send the reader back to the
    // terminal to be refused by the very command being documented.
    restrictions.push(
      `A bare count is also accepted in the POSIX short form: -5 means ${n.flag} 5. The count must be between ${n.min} and ${n.max}.`,
    );
  }
  restrictions.push(
    `Wall time is capped at ${definition.timeoutMs} ms and output at ${definition.maxOutputBytes} bytes per stream.`,
  );
  if (!definition.readOnly) {
    restrictions.push("This command is not read-only. It is a controlled workload that allocates or writes only inside its own workspace and cleans up after itself.");
  }

  return {
    name: definition.name,
    availability: definition.availability,
    availabilityReason: definition.reason,
    executable: definition.resolvedPath,
    category: definition.category,
    description: definition.rationale,
    whyAllowed: definition.rationale,
    safeArguments: definition.argumentSchema.detail,
    telemetryRelevance: definition.telemetryRelevance,
    securityRestrictions: restrictions,
    examples: definition.examples,
  };
}

/** The schema shape, exported for the API's JSON schema output. */
export type { ArgumentSchema };
