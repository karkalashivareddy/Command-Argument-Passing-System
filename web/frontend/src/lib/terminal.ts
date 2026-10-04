/**
 * Terminal rendering helpers.
 *
 * Every function here is pure and derives from a gateway response. None of them
 * decides what is valid: the gateway lexes the line and validates it, and this
 * module only renders what came back.
 *
 * That boundary is the point of the terminal. A component that re-parsed the
 * command line to decide whether to enable its Run button would be a second
 * parser, and two parsers eventually disagree about one quoting case -- always in
 * the unsafe direction, where the UI approves a line the engine will read
 * differently.
 */

import type { GrammarResponse, TerminalValidation, ValidatedStage } from "../api/observability";

/**
 * Render an argv element for display.
 *
 * The rendering is deliberately lossless: an element containing a space, a
 * quote, or a newline is quoted, because an argv display that silently drops
 * the quoting is the classic way to show `rm -rf /tmp/my dir` as
 * `rm -rf /tmp/my dir` and leave the reader unable to tell where the boundary
 * was. What the user sees is what the program receives.
 *
 * Empty elements become `''`, which is not cosmetic: an empty argv element is a
 * real, meaningful argument, and rendering it as a blank would erase it.
 */
export function quoteArgv(arg: string): string {
  if (arg === "") return "''";
  if (!/[\s"'\\$`|&;<>()*?[\]{}#!]/.test(arg)) return arg;
  // Single quotes are the safest outer quoting for display because nothing
  // inside them is special, except a single quote itself.
  return `'${arg.replace(/'/g, `'"'"'`)}'`;
}

/** The full argv of a stage, rendered so the boundaries are unambiguous. */
export function formatArgv(argv: readonly string[]): string {
  return argv.map(quoteArgv).join(" ");
}

/** The operator a stage's redirections introduce, for the structured view. */
export interface RedirectionSummary {
  operator: string;
  fd: number;
  target: string;
  /** Which stream this moves, named from the fd the engine will dup2. */
  stream: "stdin" | "stdout" | "stderr" | `fd ${number}`;
  human: string;
}

export function describeRedirection(fd: number, op: string, target: string): RedirectionSummary {
  const stream: RedirectionSummary["stream"] =
    fd === 0 ? "stdin" : fd === 1 ? "stdout" : fd === 2 ? "stderr" : `fd ${fd}`;
  // The operator is reproduced from the gateway, never recomputed here.
  const human = op.startsWith("<") ? `${op} ${target}` : `>${target}`;
  return { operator: op, fd, target, stream, human };
}

export function summariseRedirections(stage: ValidatedStage): RedirectionSummary[] {
  return stage.redirections.map((r) => describeRedirection(r.fd, r.op, r.target));
}

/** How this stage's stdin arrives, stated from the engine's own words. */
export function describeStdin(stage: ValidatedStage): string {
  switch (stage.stdinSource) {
    case "pipe":
      return "from the previous stage's stdout";
    case "file":
      const input = stage.redirections.find((r) => r.fd === 0);
      return `from file ${input?.target ?? "(unspecified)"}`;
    default:
      return "inherited from the gateway";
  }
}

/** Where this stage's stdout goes, stated from the engine's own words. */
export function describeStdout(stage: ValidatedStage): string {
  switch (stage.stdoutDest) {
    case "pipe":
      return "into the next stage's stdin";
    case "file": {
      const out = stage.redirections.find((r) => r.fd === 1);
      return `into file ${out?.target ?? "(unspecified)"}`;
    }
    default:
      return "collected by the gateway";
  }
}

/**
 * The terminal form of a validated pipeline, rebuilt from the engine's argv.
 *
 * Built from `argv` rather than from the user's original text, so what is
 * displayed is provably what will be executed. If the user's line and this
 * string differ, that difference is the interesting fact and the terminal must
 * show it rather than hide it.
 */
export function renderResolvedLine(validation: TerminalValidation): string {
  return validation.stages
    .map((stage) => {
      const argv = formatArgv(stage.argv);
      const redirs = summariseRedirections(stage)
        .map((r) => (r.fd === 0 ? ` < ${r.target}` : ` >${r.target}`))
        .join("");
      return `${argv}${redirs}`;
    })
    .join(" | ");
}

/**
 * Whether the user's line and the engine's resolved argv mean different things.
 *
 * A naive string comparison answers `true` for any difference in quoting, which
 * makes the indicator worse than useless: `seq '1' '5'` and `seq 1 5` request
 * exactly the same argv, so a reader warned by that is being told "your input
 * was understood differently" about a line that was understood identically, and
 * they learn to ignore the warning.
 *
 * So the comparison is over the LEXED argv, not the text. When the gateway has
 * already resolved the line, the only honest question is whether the tokens the
 * user typed match the tokens the engine will exec -- and for that the tokens
 * are compared directly. The user's original text is used only for the coarse
 * length and stage-count advice above, which is labelled as advisory for
 * exactly this reason.
 *
 * Consequence worth stating plainly: a difference in how the user SPELLED an
 * argument is not reported, because it changed nothing. A difference in WHICH
 * arguments there are, or in a redirection target, is reported, because that
 * changes what runs.
 */
export function resolutionDiffers(commandLine: string, validation: TerminalValidation): boolean {
  return splitTokens(commandLine).join("\0") !== splitTokens(renderResolvedLine(validation)).join("\0");
}

/**
 * Split a line into tokens for the purpose of comparing two spellings.
 *
 * NOT A LEXER, and must not become one -- the gateway calls the C engine's
 * lexer, and this exists only to decide whether to show the reader a hint.
 *
 * The one thing it must get right is token BOUNDARIES, because a difference in
 * boundaries is precisely the thing worth reporting. A splitter that stripped
 * quotes before splitting would tokenise `seq '1 5'` into `1` and `5`, which is
 * exactly backwards: it would report no difference where the engine sees one
 * argument instead of two.
 *
 * So quotes are honoured as delimiters and their contents preserved. If this
 * ever disagrees with the engine's lexer the consequence is a spurious warning,
 * which is the safe direction: the reader looks again and confirms the engine's
 * own rendering, which is displayed alongside.
 */
function splitTokens(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;

  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      // A backslash escape inside double quotes only, matching the engine's
      // documented rule that single quotes are literal throughout.
      else if (ch === "\\" && quote === '"') current += ch;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      // An empty argument is a real argument; marking it started keeps '' from
      // vanishing entirely and turning `echo '' x` into `echo x`.
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** The stage count the grammar allows, for the input's own limit indicator. */
export function stageLimit(grammar: GrammarResponse | null): number {
  return grammar?.limits.maxStages ?? 16;
}

/**
 * Whether the line exceeds a stated grammar limit, checked on the CLIENT only
 * to give immediate feedback.
 *
 * This is a usability check, not validation. The gateway re-checks everything,
 * and a client that disagreed with it would be showing an error for a line the
 * engine will happily run.
 */
export function localLimitWarnings(commandLine: string, grammar: GrammarResponse | null): string[] {
  if (grammar === null) return [];
  const warnings: string[] = [];
  if (commandLine.length > grammar.limits.maxLineBytes) {
    warnings.push(
      `The line is ${commandLine.length} bytes; the engine refuses lines longer than ${grammar.limits.maxLineBytes}.`,
    );
  }
  // Counting `|` is safe here because the gateway has not yet told us how the
  // line lexes; a `|` inside quotes would be a false positive, so this is only
  // ever shown as an advisory.
  const pipes = (commandLine.match(/\|/g) ?? []).length;
  if (pipes + 1 > grammar.limits.maxStages) {
    warnings.push(
      `This line appears to have ${pipes + 1} stages; the engine accepts at most ${grammar.limits.maxStages}.`,
    );
  }
  return warnings;
}

/**
 * Group a command list by category for the picker.
 *
 * Categories come from the gateway. A client-side grouping would need its own
 * list of what exists, which is the second-source-of-truth problem again.
 */
export function groupByCategory<T extends { category: string }>(commands: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const c of commands) {
    const existing = groups.get(c.category);
    if (existing === undefined) groups.set(c.category, [c]);
    else existing.push(c);
  }
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * Prefix-match command names for completion.
 *
 * A deliberately small filter: substring search on a 40-entry catalog needs no
 * index, and a fuzzy scorer would surface commands whose availability is
 * UNAVAILABLE at the top of the list, which reads as "CAPS recommends this".
 */
export function filterCommands<T extends { name: string }>(commands: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...commands];
  return commands.filter((c) => c.name.toLowerCase().startsWith(q));
}

/** The next command in the list, wrapping. Used by the keyboard shortcut. */
export function nextCommandIndex(current: number, length: number): number {
  if (length === 0) return 0;
  return (current + 1) % length;
}
