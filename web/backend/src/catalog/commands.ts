/**
 * The command catalog: one authoritative registry for every command the
 * gateway will execute.
 *
 * WHY THIS FILE IS THE ONLY SOURCE
 * ---------------------------------
 * The previous design kept the allowlist as a bare string array in the
 * security module.  That made four things impossible to answer honestly:
 *
 *   - what a command is *for* (there was nowhere to say so);
 *   - why it is permitted (no recorded justification);
 *   - what arguments it accepts (validation was per-call-site and ad hoc);
 *   - what a user sees when it is missing (an opaque 503).
 *
 * So the catalog is declarative.  Every command carries its purpose, its
 * policy, its argument rules, and its telemetry relevance, and the frontend
 * reads all of it from `/api/catalog` rather than keeping a second list.  There
 * is exactly one list in the product.
 *
 * AVAILABILITY IS PROBED, NEVER ASSUMED
 * -------------------------------------
 * A command being in this file says nothing about whether it exists on the
 * machine that is running.  `ip` is present on most hosts and absent on some
 * minimal images; `lsblk` ships with util-linux but not with busybox.  The
 * static definition therefore contains no availability claim at all, and
 * `probeCatalog()` inspects the real filesystem for each entry.
 *
 * The three availability states are deliberately distinct, because collapsing
 * them produces a confusing product:
 *
 *   AVAILABLE   the binary exists, is a regular file, is executable, and
 *               resolved from a trusted directory.
 *   UNAVAILABLE the binary is not present in any trusted directory, or is not
 *               executable.  Nothing is wrong; the host simply does not have it.
 *   BLOCKED     the binary is present but policy refuses to expose it.  This
 *               state exists so a deliberate security decision is never
 *               reported as a missing file.
 *
 * A command can also be present but non-functional (a stub that exits
 * immediately).  That is discovered by the caller running it, not by
 * stat(2), and the catalog does not pretend otherwise: `runtimeVerified` is
 * recorded separately from `availability` so a "present" file is not reported
 * as a working command.
 */

import { accessSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { repoRoot } from "../config/env.js";
import { isWorkloadId, probeWorkload, workloadExecutablePath, workloadIds } from "../execution/workloadCatalog.js";

export type Availability = "AVAILABLE" | "UNAVAILABLE" | "BLOCKED";

export type CommandCategory =
  | "shell-basic"
  | "file"
  | "text"
  | "system"
  | "process"
  | "network"
  | "demonstration"
  | "workload";

/** How a command treats the filesystem. */
export type WorkspacePolicy =
  /** Positional arguments are workspace-relative file names; nothing else is reachable. */
  | "confined-files"
  /** Takes no path arguments at all. */
  | "no-paths"
  /** The workload creates its own files inside the workspace and cleans up. */
  | "self-managed";

/**
 * Rules for a command's arguments.
 *
 * Deliberately small.  A richer DSL would be a parser to secure, and the
 * security that matters here comes from the closed `flags` set and the
 * numeric bounds, not from expressiveness.
 */
export interface ArgumentSchema {
  /** Exact flags this command accepts. Anything else is refused. */
  readonly flags: readonly string[];
  /**
   * Which of those flags take a value, declared per command.
   *
   * It has to be per command, because the same letter means different things:
   * `head -n 5` takes a count, `sort -n` sorts numerically and takes nothing,
   * `ps -e` shows every process while `ps -p 1` shows one. A single global
   * table of value-taking flags got this wrong in a way that was a security
   * hole rather than a nuisance: because `-e` was treated as value-taking for
   * `ps`, the validator consumed the following token as `-e`'s value, so
   * `ps -e --anything-unknown` validated. Anything after a misclassified flag
   * was unchecked.
   *
   * Defaulting to "no flag takes a value" means a forgotten declaration causes
   * a false refusal, which the tests surface, rather than an unchecked
   * argument, which they do not.
   */
  readonly valueFlags?: readonly string[];
  /** Maximum number of positional (non-flag) arguments. */
  readonly maxPositional: number;
  /** Maximum length of a single argument, in bytes. */
  readonly maxArgumentBytes: number;
  /**
   * When set, every positional argument must be an integer within these
   * bounds. This is how `sleep 300` and `head -c 999999999` are refused.
   */
  readonly positionalIntegers?: { readonly min: number; readonly max: number };
  /** Positional arguments are read as workspace-relative paths. */
  readonly positionalArePaths: boolean;
  /**
   * How many leading positionals are NOT file paths.
   *
   * Needed because several commands take a pattern or a script as their first
   * positional and files after it: `grep PATTERN FILE...`, `sed SCRIPT FILE...`,
   * `awk PROGRAM FILE...`. With a flat `positionalArePaths`, `grep 0` was
   * refused as "file argument must be an existing workspace file" when `0` is
   * the pattern and the command was about to read stdin. `head -n 5 file` has
   * the same shape and the same problem.
   *
   * 0 means every positional is a path.
   */
  readonly leadingPatternPositionals?: number;
  /**
   * A POSIX numeric short form: `-<digits>`, meaning the same as the named
   * count flag. `head -1` is `head -n 1`; `tail -20` is `tail -n 20`.
   *
   * Exists because `head -1` is not an exotic spelling, it is how people
   * write it -- and the catalog publishes `seq 1 100 | head -1` as its
   * headline way to make a producer receive SIGPIPE.  A validator that
   * refused the product's own worked example would be right to be called a bug.
   *
   * The digits are bounded by min/max rather than passed through, so `-999999999`
   * is refused for the same reason `-n 999999999` is.
   */
  readonly numericCountFlag?: {
    /** The named flag this short form stands for, for the error message. */
    readonly flag: string;
    readonly min: number;
    readonly max: number;
  };
  /**
   * Positional 1 must be exactly one of these words.
   *
   * `status_probe` is the case that needs it. The helper's real interface is
   * `status_probe exit N | signal S | print A B ...` -- a mode word followed by
   * operands -- and every document and test in this repository drives it that
   * way. The schema instead declared "one positional, which must be an integer
   * 0..255", which did two wrong things at once: it REFUSED the real usage with
   * `"exit" is not a plain non-negative integer`, and it ACCEPTED a bare
   * `status_probe 7`, which the helper answers with its unknown-mode status 3.
   * So the catalog's own example (`status_probe 3`) worked only by coincidence,
   * and the API integration suite could not drive the helper at all.
   *
   * `positionalIntegers` cannot express this, because the type of positional 2
   * depends on positional 1: an integer for `exit` and `signal`, free text for
   * `print`. That is what `choiceIntegerOperands` is for.
   */
  readonly leadingChoices?: readonly string[];
  /**
   * When positional 1 is one of `for`, positional 2 must be an integer within
   * `min`..`max`. Modes not named here take no numeric operand.
   */
  readonly choiceIntegerOperands?: {
    readonly for: readonly string[];
    readonly min: number;
    readonly max: number;
  };
  /** Human-readable statement of what the arguments mean. */
  readonly detail: string;
}

/** A single catalog entry. Contains no availability claim. */
export interface CommandDefinition {
  readonly name: string;
  readonly category: CommandCategory;
  /**
   * The basename to look for. Resolved only against `trustedDirectories`;
   * PATH is never consulted, because PATH is attacker-influenceable in a
   * compromised environment and using it would undo the pinning.
   */
  readonly executable: string;
  /**
   * Why CAPS permits this command at all.
   *
   * Recorded per command rather than in a general policy document so the
   * justification travels with the rule it justifies.  A command whose reason
   * is "it was on the list" has no reason.
   */
  readonly rationale: string;
  readonly readOnly: boolean;
  readonly workspacePolicy: WorkspacePolicy;
  readonly argumentSchema: ArgumentSchema;
  /** Wall-clock ceiling, in ms. */
  readonly timeoutMs: number;
  /** Output ceiling, in bytes, per stream. */
  readonly maxOutputBytes: number;
  /**
   * What this command's output is useful for observing, and where in the
   * product that shows up.  Empty for a command whose output is only a
   * teaching artifact.
   */
  readonly telemetryRelevance: string;
  readonly examples: readonly { readonly command: string; readonly note: string }[];
}

/** Directories searched for a system command, in order. Never PATH. */
export const TRUSTED_DIRECTORIES: readonly string[] = ["/usr/bin", "/bin", "/usr/local/bin", "/sbin", "/usr/sbin"];

/** First-party helper binaries built by `make`, resolved repository-relative. */
const REPOSITORY_HELPERS: Readonly<Record<string, string>> = {
  status_probe: resolve(repoRoot, "build", "status_probe"),
};

const NO_ARGS: ArgumentSchema = {
  flags: [],
  maxPositional: 0,
  maxArgumentBytes: 64,
  positionalArePaths: false,
  detail: "This command takes no arguments.",
};

const NO_FLAGS_PATHS: ArgumentSchema = {
  flags: [],
  maxPositional: 8,
  maxArgumentBytes: 255,
  positionalArePaths: true,
  detail: "Positional arguments are file names resolved inside the CAPS workspace. No flags are accepted.",
};

/**
 * The registry.
 *
 * Every entry is a real Linux utility that answers an observability question.
 * Nothing is included to make the list look broad: `bash`, `sh`, `python`,
 * `node`, `curl`, `rm`, `chmod`, `mount`, `kill`, and every other command that
 * would turn this into a remote shell are deliberately absent and the reason
 * is recorded in docs/security.md.
 */
const DEFINITIONS: readonly CommandDefinition[] = [
  // ------------------------------------------------------- shell basics
  {
    name: "echo",
    category: "shell-basic",
    executable: "echo",
    rationale: "The smallest possible demonstration that argv reached a real exec'd process.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-n", "-e", "-E"],
      valueFlags: ["-e", "-E"],
      maxPositional: 32,
      maxArgumentBytes: 4096,
      positionalArePaths: false,
      detail: "Any arguments. -n omits the trailing newline, -e interprets backslash escapes, -E disables that interpretation.",
    },
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    telemetryRelevance: "Its PID, exit code, and lifetime are the baseline against which the other workloads are compared.",
    examples: [{ command: "echo hello caps", note: "argv reaches the process unchanged." }],
  },
  {
    name: "printf",
    category: "shell-basic",
    executable: "printf",
    rationale: "Produces output without a trailing newline, which makes format handling visible in a pipeline.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-v"],
      maxPositional: 32,
      maxArgumentBytes: 4096,
      positionalArePaths: false,
      detail: "A format string followed by its arguments. Backslash escapes in the format are interpreted by printf itself, not by CAPS.",
    },
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    telemetryRelevance: "Lets a pipeline produce output whose exact bytes are known, so a downstream count can be checked exactly.",
    examples: [{ command: "printf 'a\\nb\\n'", note: "Two newline-terminated lines for a consumer to count." }],
  },
  {
    name: "pwd",
    category: "shell-basic",
    executable: "pwd",
    rationale: "Shows the working directory the child actually inherited, which is the workspace and not the repository.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: NO_ARGS,
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    telemetryRelevance: "Confirms the workspace confinement actually applied to the child, rather than merely being intended.",
    examples: [{ command: "pwd", note: "Prints the confined workspace path." }],
  },
  {
    name: "true",
    category: "demonstration",
    executable: "true",
    rationale: "A command that always succeeds, for isolating exit-status handling from program behaviour.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: NO_ARGS,
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
    telemetryRelevance: "The zero-exit case for the status model.",
    examples: [{ command: "true", note: "Exits 0 immediately." }],
  },
  {
    name: "false",
    category: "demonstration",
    executable: "false",
    rationale: "A command that always fails, for isolating non-zero status from signal termination.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: NO_ARGS,
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
    telemetryRelevance: "The non-zero-exit case, and the producer side of `false | true`, where the pipeline still succeeds.",
    examples: [{ command: "false", note: "Exits 1 immediately." }],
  },
  {
    name: "sleep",
    category: "demonstration",
    executable: "sleep",
    rationale: "A long-running process with no output, which is how wall-clock limits and signal delivery are exercised.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: [],
      maxPositional: 1,
      maxArgumentBytes: 16,
      positionalIntegers: { min: 0, max: 120 },
      positionalArePaths: false,
      detail: "A single whole or fractional number of seconds, 0 to 120. Fractions require GNU coreutils sleep.",
    },
    timeoutMs: 130_000,
    maxOutputBytes: 1024,
    telemetryRelevance: "Gives the sampler a process to watch accumulate CPU time, memory, and context switches over a known interval. Also the producer in a SIGPIPE demonstration.",
    examples: [{ command: "sleep 3", note: "Three seconds of observable idleness." }],
  },
  {
    name: "status_probe",
    category: "demonstration",
    executable: "status_probe",
    rationale: "A first-party helper that exits with a status the caller chooses, so a specific wait() status can be produced on demand.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: [],
      // `print A B ...` takes any number of trailing words; `exit N` and
      // `signal S` take exactly one numeric operand after the mode.
      maxPositional: 16,
      maxArgumentBytes: 64,
      positionalArePaths: false,
      leadingChoices: ["exit", "signal", "print"],
      choiceIntegerOperands: { for: ["exit", "signal"], min: 0, max: 255 },
      detail:
        "A mode word followed by its operands: `exit N` (0..255), `signal N` (0..255), or `print A B ...` (each word on its own line).",
    },
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
    telemetryRelevance: "Produces a chosen exit code so the status model can be verified against a known answer.",
    examples: [
      { command: "status_probe exit 3", note: "Exits with status 3." },
      { command: "status_probe signal 2", note: "Raises SIGINT on itself." },
    ],
  },

  // ------------------------------------------------------------- files
  {
    name: "cat",
    category: "file",
    executable: "cat",
    rationale: "The producer half of most demonstrations: it reads a workspace file and writes it to a pipe.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-n", "-b", "-A", "-E", "-T", "-s"],
      maxPositional: 16,
      maxArgumentBytes: 255,
      positionalArePaths: true,
      detail: "File names resolved inside the workspace. No absolute paths, no '..', no trailing-slash tricks.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
    telemetryRelevance: "Feeds a real pipe so a pipeline's byte path can be observed end to end.",
    examples: [{ command: "cat notes.txt", note: "Writes a workspace file to stdout." }],
  },
  {
    name: "head",
    category: "file",
    executable: "head",
    rationale: "A consumer that exits early, which is how a producer is observed receiving SIGPIPE.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-n", "-c", "-q", "-v"],
      valueFlags: ["-n", "-c"],
      maxPositional: 16,
      maxArgumentBytes: 255,
      positionalArePaths: true,
      leadingPatternPositionals: 1,
      numericCountFlag: { flag: "-n", min: 1, max: 100_000 },
      detail: "File names resolved inside the workspace. Line and byte counts are bounded.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
    telemetryRelevance: "`head -1` closes its stdin after one line, which is the mechanism that makes the producer's SIGPIPE observable rather than theoretical.",
    examples: [{ command: "seq 1 100 | head -1", note: "The consumer exits early; the producer must be killed by SIGPIPE, not hang." }],
  },
  {
    name: "tail",
    category: "file",
    executable: "tail",
    rationale: "The counterpart to head, and the conventional way to read the end of a log.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      // -f is deliberately absent. It is the flag every implementation of
      // tail accepts, and its absence is the point: -f never returns, so it
      // would hold a concurrency slot and a session open until the wall-clock
      // timeout killed it, which is a denial of service expressed as a
      // convenience flag. The prose below used to claim -f was refused while
      // the flag list still contained it; a catalog test comparing the two now
      // prevents that specific contradiction.
      flags: ["-n", "-c", "-q", "-v"],
      valueFlags: ["-n", "-c"],
      maxPositional: 16,
      maxArgumentBytes: 255,
      positionalArePaths: true,
      leadingPatternPositionals: 1,
      numericCountFlag: { flag: "-n", min: 1, max: 100_000 },
      detail: "File names resolved inside the workspace. -f is refused: it never terminates, so it would hold a concurrency slot until the timeout killed it.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
    telemetryRelevance: "Reads the tail of a workspace file, which is where a pipeline's accumulated output lands.",
    examples: [{ command: "tail -n 5 notes.txt", note: "The last five lines of a workspace file. Create it first with `printf 'a\\nb\\n' > notes.txt`: the workspace policy admits only files that already exist, so a path argument is refused rather than trusted." }],
  },
  {
    name: "wc",
    category: "text",
    executable: "wc",
    rationale: "The canonical consumer: it reduces a stream to a number, so a pipeline's output can be verified exactly.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-l", "-w", "-c", "-m"],
      maxPositional: 16,
      maxArgumentBytes: 255,
      positionalArePaths: true,
      detail: "File names resolved inside the workspace. With no file, counts stdin.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 32 * 1024,
    telemetryRelevance: "Proves the pipe actually carried the bytes: `seq 1 2000 | wc -l` must print exactly 2000, and any number else means the data path is broken.",
    examples: [{ command: "seq 1 2000 | wc -l", note: "Counts 2000 lines produced by a separate process." }],
  },
  {
    name: "stat",
    category: "file",
    executable: "stat",
    rationale: "Reports inode, size, permissions, and timestamps for a workspace file.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-c", "-f", "-L"],
      valueFlags: ["-c", "-f"],
      maxPositional: 16,
      maxArgumentBytes: 255,
      positionalArePaths: true,
      detail: "File names resolved inside the workspace. -L follows symlinks, which is why the path policy refuses them anyway.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 32 * 1024,
    telemetryRelevance: "Gives inode and block counts, which are the filesystem-side counterpart to the byte counters /proc/<pid>/io reports.",
    examples: [{ command: "stat notes.txt", note: "Size, inode, and timestamps of a workspace file. Create it first: only existing files are admitted as path arguments." }],
  },
  {
    name: "file",
    category: "file",
    executable: "file",
    rationale: "Identifies a file's type from its contents rather than its name.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-b", "-i", "-L"],
      maxPositional: 16,
      maxArgumentBytes: 255,
      positionalArePaths: true,
      detail: "File names resolved inside the workspace.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 32 * 1024,
    telemetryRelevance: "Confirms that a redirection target really is a regular file and not a device or FIFO.",
    examples: [{ command: "file notes.txt", note: "Content-based type identification. Create the file first: only existing files are admitted as path arguments." }],
  },
  {
    name: "ls",
    category: "file",
    executable: "ls",
    rationale: "Lists the workspace so a reader can see what the session actually produced.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-l", "-a", "-h", "-1", "-t", "-S", "-r"],
      maxPositional: 16,
      maxArgumentBytes: 255,
      positionalArePaths: true,
      detail: "Path arguments resolved inside the workspace. No recursive flag is accepted, so a large tree cannot be walked.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 128 * 1024,
    telemetryRelevance: "Shows the files a redirection created, which is the observable result of the file-ownership path.",
    examples: [{ command: "ls -l", note: "Lists the workspace with sizes and timestamps." }],
  },

  // -------------------------------------------------------------- text
  {
    name: "grep",
    category: "text",
    executable: "grep",
    rationale: "The canonical filter stage: it selects lines, which is how a three-stage pipeline is demonstrated.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-c", "-i", "-v", "-n", "-q", "-E", "-F", "-l", "-h", "-o", "-w", "-x"],
      maxPositional: 16,
      maxArgumentBytes: 512,
      positionalArePaths: true,
      leadingPatternPositionals: 1,
      detail: "A pattern followed by workspace file names, or nothing but the pattern to read stdin. -r is not accepted, so a pattern cannot be swept across a whole tree.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
    telemetryRelevance: "The middle stage of a three-stage pipeline. `-c` produces a single number, so a downstream count can be checked against a known answer.",
    examples: [{ command: "seq 10 100 | grep 0 | wc -l", note: "Filter then count: 10 matching lines." }],
  },
  {
    name: "sort",
    category: "text",
    executable: "sort",
    rationale: "Orders a stream, which is a consumer whose output depends on having received the whole input.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-n", "-r", "-u", "-h", "-k", "-t"],
      valueFlags: ["-k", "-t"],
      maxPositional: 16,
      maxArgumentBytes: 255,
      positionalArePaths: true,
      detail: "Workspace file names, or stdin when none are given.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
    telemetryRelevance: "Buffers its entire input before emitting, so it is a consumer that only completes when the producer has closed the pipe. That makes it a check that EOF propagates correctly.",
    examples: [{ command: "seq 3 1 | sort -n", note: "Numeric ordering, requires full input." }],
  },
  {
    name: "uniq",
    category: "text",
    executable: "uniq",
    rationale: "Collapses adjacent duplicates, the classic second stage after sort.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-c", "-d", "-u", "-i"],
      maxPositional: 16,
      maxArgumentBytes: 255,
      positionalArePaths: true,
      detail: "At most one input file, resolved inside the workspace, or stdin.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 128 * 1024,
    telemetryRelevance: "Only collapses adjacent duplicates, so it is meaningful after sort. The pairing demonstrates two stages composing.",
    examples: [{ command: "printf 'a\\na\\nb\\n' | sort | uniq -c", note: "Counts each distinct line." }],
  },
  {
    name: "cut",
    category: "text",
    executable: "cut",
    rationale: "Selects fields from a delimited stream.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-d", "-f", "-c", "-s"],
      valueFlags: ["-d", "-f", "-c"],
      maxPositional: 16,
      maxArgumentBytes: 255,
      positionalArePaths: true,
      detail: "A delimiter and field list, then workspace file names or stdin.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 128 * 1024,
    telemetryRelevance: "Reduces columns, which is a realistic observability transform over tabular output.",
    examples: [{ command: "printf 'a 1\\nb 2\\n' | cut -d' ' -f1", note: "Selects the first space-delimited field." }],
  },
  {
    name: "tr",
    category: "text",
    executable: "tr",
    rationale: "Translates or deletes characters, a stream filter that writes no files.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-d", "-s", "-c", "-C"],
      valueFlags: ["-d", "-s", "-c", "-C"],
      maxPositional: 2,
      maxArgumentBytes: 256,
      positionalArePaths: false,
      detail: "One or two character strings. No file arguments: tr reads stdin only.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 128 * 1024,
    telemetryRelevance: "A filter that cannot touch the filesystem at all, so its presence demonstrates the no-paths policy.",
    examples: [{ command: "printf 'abc\\n' | tr a-z A-Z", note: "Upper-cases stdin." }],
  },
  {
    name: "sed",
    category: "text",
    executable: "sed",
    rationale: "Stream-edits lines, the most common pipeline filter in practice.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-n", "-e", "-E", "-r", "-s"],
      valueFlags: ["-e"],
      maxPositional: 16,
      maxArgumentBytes: 1024,
      positionalArePaths: true,
      leadingPatternPositionals: 1,
      detail: "A script followed by workspace file names. In-place editing (-i) is deliberately NOT accepted: it would let a command rewrite a file rather than merely read one, which no other catalog entry can do.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
    telemetryRelevance: "Substitution over a stream, which is a realistic transform in a monitoring pipeline. Refusing -i keeps the whole catalog read-only.",
    examples: [{ command: "printf 'a\\nb\\n' | sed 's/a/A/'", note: "Substitutes on stdin." }],
  },
  {
    name: "awk",
    category: "text",
    executable: "awk",
    rationale: "Field-and-record processing, and the standard way to compute an aggregate over a stream.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-F", "-v"],
      valueFlags: ["-F", "-v"],
      maxPositional: 16,
      maxArgumentBytes: 2048,
      positionalArePaths: true,
      leadingPatternPositionals: 1,
      detail: "A program followed by workspace file names. The program is bounded in length and cannot name a file the path policy would refuse, because getline and redirection inside it operate relative to the child's working directory, which is the workspace.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
    telemetryRelevance: "The most capable stream aggregator available without a shell, so a real per-field aggregate can be computed and then compared against the gateway's own telemetry.",
    examples: [{ command: "seq 1 10 | awk '{s+=$1} END {print s}'", note: "Sums a stream; the answer is checkable by hand." }],
  },

  // ---------------------------------------------------------- system info
  {
    name: "uname",
    category: "system",
    executable: "uname",
    rationale: "Reports the kernel identity the whole product depends on.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-a", "-s", "-n", "-r", "-v", "-m", "-p", "-i", "-o"],
      maxPositional: 0,
      maxArgumentBytes: 16,
      positionalArePaths: false,
      detail: "Flags only, no operands.",
    },
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    telemetryRelevance: "The kernel string, which should agree with the /proc/version the host collector reports. Comparing the two is a cross-check that the observer and the kernel agree.",
    examples: [{ command: "uname -a", note: "Full kernel and machine identification." }],
  },
  {
    name: "hostname",
    category: "system",
    executable: "hostname",
    rationale: "Reports the configured hostname.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: NO_ARGS,
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
    telemetryRelevance: "Host identity, alongside the machine-id and boot-id the collector records.",
    examples: [{ command: "hostname", note: "The configured hostname." }],
  },
  {
    name: "date",
    category: "system",
    executable: "date",
    rationale: "Reports the system clock.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-u", "-R", "-I", "-r"],
      valueFlags: ["-r"],
      maxPositional: 0,
      maxArgumentBytes: 16,
      positionalArePaths: false,
      detail: "Flags only. The argument-taking '+FORMAT' form is refused so the format string cannot become a way to pass arbitrary data to a command line.",
    },
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    telemetryRelevance: "The system clock, which is the reference against which every wall-clock duration in the event stream is interpreted.",
    examples: [{ command: "date -u", note: "UTC, unambiguous regardless of the host's timezone configuration." }],
  },
  {
    name: "uptime",
    category: "system",
    executable: "uptime",
    rationale: "Reports time since boot and the load average.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-p", "-s"],
      maxPositional: 0,
      maxArgumentBytes: 16,
      positionalArePaths: false,
      detail: "Flags only.",
    },
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    telemetryRelevance: "Its load average is the kernel's own, and should match the /proc/loadavg figure the host collector reports. That agreement is a genuine cross-check.",
    examples: [{ command: "uptime", note: "Load average and uptime." }],
  },
  {
    name: "whoami",
    category: "system",
    executable: "whoami",
    rationale: "Reports the effective user, which determines what procfs will let the gateway read.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: NO_ARGS,
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
    telemetryRelevance: "Explains why some host processes are readable and others are PERMISSION_DENIED: a child can only read /proc/<pid>/io for a process it owns or can ptrace.",
    examples: [{ command: "whoami", note: "The effective UID name." }],
  },
  {
    name: "id",
    category: "system",
    executable: "id",
    rationale: "Reports the full identity and group membership of the executing child.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: NO_ARGS,
    timeoutMs: 10_000,
    maxOutputBytes: 2048,
    telemetryRelevance: "The uid/gid the collector reports for its own process rows, so a reader can tell which rows were readable.",
    examples: [{ command: "id", note: "UID, GID, and supplementary groups." }],
  },
  {
    name: "free",
    category: "system",
    executable: "free",
    rationale: "Reports memory and swap usage in the kernel's own terms.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-b", "-k", "-m", "-g", "-h", "-s", "-t", "-c"],
      maxPositional: 0,
      maxArgumentBytes: 16,
      positionalArePaths: false,
      detail: "Flags only.",
    },
    timeoutMs: 10_000,
    maxOutputBytes: 8192,
    telemetryRelevance: "Its 'available' column is the same MemAvailable the collector reads, so the two can be compared. A disagreement means the collector is reading a different field than it claims.",
    examples: [{ command: "free -h", note: "Human-readable memory summary." }],
  },
  {
    name: "df",
    category: "system",
    executable: "df",
    rationale: "Reports filesystem capacity.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-h", "-H", "-T", "-i", "-t", "-x", "-a", "-P"],
      maxPositional: 8,
      maxArgumentBytes: 255,
      positionalArePaths: false,
      detail: "Flags plus optional mount points or device names as plain strings. No path traversal is possible because the flags that would act on files (-x, -t) only take type names.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 32 * 1024,
    telemetryRelevance: "Filesystem capacity from the utility, comparable against the statfs figures the collector reports. These are separate mechanisms, so agreement is meaningful.",
    examples: [{ command: "df -h", note: "Capacity of every mounted filesystem." }],
  },
  {
    name: "du",
    category: "system",
    executable: "du",
    rationale: "Reports disk usage of workspace files.",
    readOnly: true,
    workspacePolicy: "confined-files",
    argumentSchema: {
      flags: ["-s", "-h", "-b", "-k", "-m", "-d"],
      valueFlags: ["-d"],
      maxPositional: 8,
      maxArgumentBytes: 255,
      positionalArePaths: true,
      detail:
        "Paths resolved inside the workspace only, so du cannot be used to walk the host filesystem. -s keeps it to a single total per argument. DIRECTORIES ARE REFUSED: the workspace policy admits regular files only, so `du .` and `du -sh .` are both rejected even though `du` normally defaults to the current directory. Pass the files themselves.",
    },
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    telemetryRelevance: "Byte counts for the workspace, which is where a session's own output accumulates.",
    examples: [{ command: "du -sh output.txt", note: "Size of a workspace file. A directory argument is refused by the file policy." }],
  },
  {
    name: "lscpu",
    category: "system",
    executable: "lscpu",
    rationale: "Reports the processor architecture and topology as the kernel describes it.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-e", "-j", "-p", "-J", "-x", "-a", "-s", "-r", "-t", "-c"],
      maxPositional: 0,
      maxArgumentBytes: 16,
      positionalArePaths: false,
      detail: "Flags only.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
    telemetryRelevance: "Its logical CPU count must equal the cpuN line count in /proc/stat, which is what the collector uses for per-core reporting and for normalising the load average.",
    examples: [{ command: "lscpu", note: "Architecture, cores, and caches." }],
  },
  {
    name: "lsblk",
    category: "system",
    executable: "lsblk",
    rationale: "Reports the block device tree.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-a", "-b", "-d", "-f", "-l", "-n", "-p", "-s", "-S", "-t", "-J", "-o"],
      valueFlags: ["-o"],
      maxPositional: 0,
      maxArgumentBytes: 128,
      positionalArePaths: false,
      detail: "Flags plus an optional column list after -o, which is why maxArgumentBytes is larger than for other commands.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
    telemetryRelevance: "The device names here should match the non-pseudo entries in /proc/diskstats, which is exactly the set the disk collector reports. Comparing the two lists catches a filter that removes the wrong devices.",
    examples: [{ command: "lsblk", note: "Block device hierarchy." }],
  },
  {
    name: "nproc",
    category: "system",
    executable: "nproc",
    rationale: "Reports the number of processors available to the process.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: NO_ARGS,
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
    telemetryRelevance: "Honours the CPU affinity mask, so it can legitimately differ from the machine's total. That difference is worth showing rather than hiding.",
    examples: [{ command: "nproc", note: "Processors available to this process." }],
  },

  // ------------------------------------------------------------ process
  {
    name: "ps",
    category: "process",
    executable: "ps",
    rationale: "The canonical process listing, and a direct cross-check on the host process explorer.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-a", "-A", "-e", "-u", "-o", "-p", "-n", "-L", "-x", "-w", "-h", "-s", "--no-headers"],
      valueFlags: ["-o", "-p", "-u"],
      maxPositional: 4,
      maxArgumentBytes: 512,
      positionalArePaths: false,
      leadingPatternPositionals: 1,
      detail:
        "A bounded set of display flags. Arbitrary ps combinations are refused: ps accepts a huge option surface including selection expressions, and the safe subset here is the one that stays a plain listing. -o may be followed by a comma-separated column list. --no-headers is allowed because counting state letters from a listing otherwise means post-processing the header, and a machine-readable listing should not require it.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 512 * 1024,
    telemetryRelevance: "Its PID/PPID/STAT/RSS columns should agree with the same fields the process explorer reports. Two independent implementations reading the same kernel data is a real check.",
    examples: [
      { command: "ps -e -o pid,ppid,stat,rss,comm", note: "A plain listing to compare against Process Explorer." },
      { command: "ps -e -o pid,stat --no-headers", note: "Just the state letters, for counting zombies." },
    ],
  },
  {
    name: "pgrep",
    category: "process",
    executable: "pgrep",
    rationale: "Finds PIDs by pattern, which is how a specific process is located before inspection.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-a", "-f", "-l", "-n", "-o", "-c", "-u", "-x"],
      valueFlags: ["-f", "-u"],
      maxPositional: 1,
      maxArgumentBytes: 128,
      positionalArePaths: false,
      detail: "A single pattern. Patterns are treated as text, never as a regular expression the gateway interprets.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 32 * 1024,
    telemetryRelevance: "Locates a process by name so its identity can be read and then inspected through the Process Detail route.",
    examples: [{ command: "pgrep -a caps", note: "Finds the CAPS processes and shows their argv." }],
  },
  {
    name: "seq",
    category: "text",
    executable: "seq",
    rationale: "Generates a known, countable number sequence: the ideal pipeline producer.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-s", "-f", "-w"],
      valueFlags: ["-s", "-f"],
      maxPositional: 3,
      maxArgumentBytes: 16,
      positionalIntegers: { min: 0, max: 10_000_000 },
      positionalArePaths: false,
      detail: "One to three whole numbers, each 0 to 10,000,000. The bound is what stops a single command from producing unbounded output before the output cap notices.",
    },
    timeoutMs: 20_000,
    maxOutputBytes: 256 * 1024,
    telemetryRelevance: "A producer whose output length is known in advance, so `seq 1 2000 | wc -l` must print exactly 2000. Any other number means bytes were lost or duplicated in the pipe.",
    examples: [
      { command: "seq 1 2000 | wc -l", note: "Verifies the pipe carried exactly 2000 lines." },
      { command: "seq 1 100 | head -1", note: "Makes the producer receive SIGPIPE." },
    ],
  },

  // ------------------------------------------------------------ network
  {
    name: "ip",
    category: "network",
    executable: "ip",
    rationale: "Reports and configures network interfaces. Only the read-only object queries are exposed.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-4", "-6", "-br", "-c", "-s", "-o", "-j", "-t", "-d"],
      maxPositional: 2,
      maxArgumentBytes: 32,
      positionalArePaths: false,
      detail:
        "The object to query (addr, link, route, neigh) and a show/flush verb. The mutating verbs -- add, del, replace, set, change -- are NOT accepted: this entry exists to read interface state, and a command that can modify the host's network configuration does not belong in a read-only catalog.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 128 * 1024,
    telemetryRelevance: "Interface addresses and link state, comparable against the /proc/net/dev counters the collector reports.",
    examples: [{ command: "ip -br addr", note: "Brief address listing per interface." }],
  },
  {
    name: "ss",
    category: "network",
    executable: "ss",
    rationale: "Reports socket state, which is the closest thing Linux offers to a network connection listing.",
    readOnly: true,
    workspacePolicy: "no-paths",
    argumentSchema: {
      flags: ["-a", "-l", "-n", "-p", "-t", "-u", "-x", "-w", "-s", "-e", "-m"],
      maxPositional: 2,
      maxArgumentBytes: 32,
      positionalArePaths: false,
      detail: "Socket families and display flags only. No --kill, --delete, or --timeout options, which would turn a listing utility into a socket control tool.",
    },
    timeoutMs: 15_000,
    maxOutputBytes: 128 * 1024,
    telemetryRelevance: "Socket state, which the interface byte counters deliberately do not describe: those are host totals and cannot be attributed to a socket or a process.",
    examples: [{ command: "ss -ltn", note: "Listening TCP sockets, numeric addresses." }],
  },
];

/** The static registry, by name. */
export const COMMAND_DEFINITIONS: ReadonlyMap<string, CommandDefinition> = new Map(
  DEFINITIONS.map((d) => [d.name, d]),
);

/** Every catalog command name, sorted, for the capability response. */
export function catalogNames(): string[] {
  const names = [...COMMAND_DEFINITIONS.keys(), ...workloadIds()].sort();
  return names;
}

/** The definition for a command, or null if it is not in the catalog. */
export function commandDefinition(name: string): CommandDefinition | null {
  return COMMAND_DEFINITIONS.get(name) ?? null;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/** The result of inspecting the real environment for one command. */
export interface ProbedCommand {
  readonly name: string;
  readonly category: CommandCategory;
  readonly availability: Availability;
  /**
   * Why this availability. Always populated, including on success, so the UI
   * can show the resolved path and the directory it came from rather than a
   * bare "available".
   */
  readonly reason: string;
  /**
   * The absolute path that will actually be exec'd, or null when unavailable.
   *
   * Resolved from `TRUSTED_DIRECTORIES` only. PATH is never consulted, and a
   * symlinked binary is refused rather than followed, so the bytes at this path
   * cannot change underneath the recorded evidence.
   */
  readonly resolvedPath: string | null;
  readonly readOnly: boolean;
  readonly workspacePolicy: WorkspacePolicy;
  readonly rationale: string;
  readonly telemetryRelevance: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly argumentSchema: ArgumentSchema;
  readonly examples: readonly { readonly command: string; readonly note: string }[];
}

const probeCache = new Map<string, { available: boolean; path: string | null; reason: string }>();

/**
 * Verify one candidate path.
 *
 * WHAT THE SECURITY PROPERTY ACTUALLY IS
 * ---------------------------------------
 * The goal is not "the path is not a symlink". It is "the bytes that will be
 * executed are the bytes that were verified".
 *
 * Refusing every symlink is the obvious implementation and it is wrong. On
 * Debian and Ubuntu, coreutils is arranged so that `/usr/bin/true` is a symlink
 * to `/usr/bin/gnutrue`, and `/bin` is itself a symlink to `/usr/bin`. A
 * blanket refusal therefore rejects *every* coreutils command on the most
 * common Linux distribution, which was caught here by the integration suite
 * failing to start a single session.
 *
 * The real property is CONTAINMENT, and it is checked as follows:
 *
 *   1. realpath() the candidate, following the whole chain;
 *   2. lstat() the resolved target -- it must be a regular file, not a device,
 *      FIFO, or directory;
 *   3. the resolved path must still be inside one of the trusted directories,
 *      so a symlink in a trusted directory cannot redirect execution to
 *      /tmp, $HOME, or anywhere else;
 *   4. it must be executable.
 *
 * A symlink is therefore allowed when it resolves to a verified regular file
 * inside a trusted root, and refused when it resolves anywhere else. That is
 * what stops a planted link from changing which bytes run, which is the
 * property the original code intended and did not achieve: it ran realpath
 * then lstat on the RESOLVED path, so its "resolves to a symbolic link" check
 * was unreachable dead code.
 *
 * The number of links traversed is reported in the reason, because a pinned
 * path that took three hops to resolve is worth knowing about.
 */
/**
 * Resolve a path and confirm the target is a safe executable file.
 *
 * This is the generic half: it answers "is this a regular, executable file?"
 * and says nothing about *where* the file is. Containment is a separate policy
 * decision applied by `verifyExecutablePath` below, because the two are
 * different questions. Conflating them makes the generic helper useless: a
 * caller verifying a file in its own workspace is not asking whether the file
 * lives in /usr/bin.
 *
 * Symlinks are followed. The previous implementation ran realpath and then
 * lstat on the RESOLVED path, which made its "resolves to a symbolic link"
 * refusal unreachable dead code: realpath had already followed the link, so
 * lstat could only ever report a regular file. A test that created a symlink
 * and asserted the refusal is what caught that.
 *
 * Note also that refusing symlinks outright would be wrong here: on Debian and
 * Ubuntu `/usr/bin/true` is a symlink to `/usr/bin/gnutrue` and `/bin` is a
 * symlink to `/usr/bin`, so a blanket refusal rejects every coreutils command
 * on the most common Linux distribution.
 */
export function verifyExecutableFile(
  candidate: string,
): { ok: true; path: string; linksTraversed: number } | { ok: false; reason: string } {
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as NodeJS.ErrnoException).code) : "UNKNOWN";
    if (code === "ENOENT") return { ok: false, reason: "not found at this path" };
    if (code === "EACCES") return { ok: false, reason: "present but not readable" };
    return { ok: false, reason: `cannot resolve (${code})` };
  }

  // Reported so a pinned path that took a hop to resolve is visible rather
  // than being presented as if the link were the file.
  const linksTraversed = real === candidate ? 0 : 1;

  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(real);
  } catch (err) {
    return { ok: false, reason: `cannot stat the resolved target (${(err as NodeJS.ErrnoException).code ?? "UNKNOWN"})` };
  }
  if (info.isSymbolicLink()) {
    // realpath fully resolves, so reaching here means the chain looped.
    return { ok: false, reason: "resolves through a symbolic link loop" };
  }
  if (!info.isFile()) {
    return { ok: false, reason: `resolves to ${real}, which is not a regular file` };
  }
  try {
    accessSync(real, constants.X_OK);
  } catch {
    return { ok: false, reason: "present but not executable" };
  }
  return { ok: true, path: real, linksTraversed };
}

/**
 * Verify a candidate executable AND that an unprivileged user cannot replace
 * the bytes it resolves to. This is what the catalog's probe uses.
 *
 * WHY THIS IS NOT A PATH-LIST CHECK
 * ---------------------------------
 * The obvious implementation is "the resolved path must be inside /usr/bin or
 * /bin". That is a proxy for the real property, and a bad one: on a host with a
 * package-manager coreutils installed, `/usr/bin/echo` is a symlink to
 * `/usr/lib/cargo/bin/coreutils/echo`, and a path-list check then refuses
 * *every* coreutils command on a perfectly legitimate machine. That was
 * observed here, and it turned 18 integration tests red for a condition that is
 * not a security problem.
 *
 * The property that actually matters is: could a process running as this
 * gateway's user replace the file, or the link pointing at it, between the
 * probe and the exec? A path is safe from that when it is
 *
 *   - a regular, executable file (checked by verifyExecutableFile), and
 *   - either inside a trusted root, OR owned by root and not writable by
 *     group or other.
 *
 * A symlink planted by the gateway's own user resolves to something that user
 * owns, which fails the ownership test. That is precisely the attack, and it is
 * refused for the right reason rather than by accident of directory layout.
 */
export function verifyExecutablePath(
  candidate: string,
  trustedRoots: readonly string[] = TRUSTED_DIRECTORIES,
): { ok: true; path: string; linksTraversed: number } | { ok: false; reason: string } {
  const resolved = verifyExecutableFile(candidate);
  if (!resolved.ok) return resolved;

  // realpath has already normalised "..", so a prefix test is sound.
  const insideTrustedRoot = trustedRoots.some((root) => {
    const normalisedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
    return resolved.path === normalisedRoot || resolved.path.startsWith(`${normalisedRoot}/`);
  });
  if (insideTrustedRoot) return resolved;

  /*
   * Outside the trusted roots, so fall back to the ownership test. A file
   * owned by uid 0 that is not group- or world-writable cannot be replaced by
   * the gateway's user, which is the property the path list was standing in
   * for.
   */
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(resolved.path);
  } catch (err) {
    return { ok: false, reason: `cannot stat the resolved target (${(err as NodeJS.ErrnoException).code ?? "UNKNOWN"})` };
  }

  // The write and execute bits, plus the ownership and mode.
  const WRITE_BITS = 0o222;
  const GROUP_OTHER_WRITE = 0o022;
  if (info.uid !== 0) {
    return {
      ok: false,
      reason:
        `${candidate} resolves to ${resolved.path}, which is owned by uid ${info.uid} rather than root and is outside every trusted ` +
        `directory (${trustedRoots.join(", ")}). A file the gateway's own user can replace is not safe to pin.`,
    };
  }
  if ((info.mode & GROUP_OTHER_WRITE) !== 0) {
    return {
      ok: false,
      reason:
        `${candidate} resolves to ${resolved.path}, which is writable by group or other ` +
        `(mode ${(info.mode & 0o777).toString(8)}). An unprivileged process could replace it between the probe and the exec.`,
    };
  }
  void WRITE_BITS;
  return resolved;
}
function probeSystemCommand(name: string): { available: boolean; path: string | null; reason: string } {
  const cached = probeCache.get(name);
  if (cached !== undefined) return cached;

  // Tracks the best "present but unusable" candidate, so the reported reason
  // describes a file that exists rather than implying the command is absent.
  let bestRejection: { available: boolean; path: string | null; reason: string } | null = null;
  for (const dir of TRUSTED_DIRECTORIES) {
    const candidate = resolve(dir, name);
    if (!existsSync(candidate)) continue;
    const verified = verifyExecutablePath(candidate);
    if (verified.ok) {
      // The link count goes in the reason because a pinned path that took a
      // hop to resolve is worth surfacing, and because on Debian/Ubuntu it is
      // the norm rather than the exception: reporting "resolved from
      // /usr/bin/true" would hide that `true` is really `gnutrue`.
      const found: { available: boolean; path: string | null; reason: string } = {
        available: true,
        path: verified.path,
        reason:
          verified.linksTraversed === 0
            ? `resolved from ${candidate}`
            : `resolved from ${candidate} through ${verified.linksTraversed} symbolic link to ${verified.path}, verified as a regular executable file inside a trusted directory`,
      };
      probeCache.set(name, found);
      return found;
    }
    bestRejection = { available: false, path: null, reason: `${candidate} ${verified.reason}` };
  }
  const final: { available: boolean; path: string | null; reason: string } =
    bestRejection ?? {
      available: false,
      path: null,
      reason: `not found in any trusted directory (${TRUSTED_DIRECTORIES.join(", ")})`,
    };
  probeCache.set(name, final);
  return final;
}

/** Test seam: forget every memoised probe. */
export function resetCatalogProbes(): void {
  probeCache.clear();
}

/**
 * Inspect the real environment for one catalog command.
 *
 * The result is cached per process, because a probe is several `stat` calls and
 * the answer cannot change while the gateway runs. `resetCatalogProbes` exists
 * so a test can observe a fresh probe.
 */
export function probeCommand(name: string): ProbedCommand {
  const definition = commandDefinition(name);
  if (definition === null) {
    // A workload, or an unknown name.
    if (isWorkloadId(name)) {
      const availability = probeWorkload(name);
      return {
        name,
        category: "workload",
        availability: availability.available ? "AVAILABLE" : "UNAVAILABLE",
        reason: availability.reason ?? `built and verified at ${workloadExecutablePath(name)}`,
        resolvedPath: availability.available ? workloadExecutablePath(name) : null,
        readOnly: false,
        workspacePolicy: "self-managed",
        rationale: "A first-party workload built by this repository, used to generate real CPU, memory, I/O, and process-tree behaviour under observation.",
        telemetryRelevance: "Each workload is built to move one specific class of resource, so the collector's figures have something known to move.",
        timeoutMs: 35_000,
        maxOutputBytes: 64 * 1024,
        argumentSchema: {
          flags: [],
          maxPositional: 3,
          maxArgumentBytes: 16,
          positionalIntegers: { min: 0, max: 1_000_000 },
          positionalArePaths: false,
          detail: "Bounded numeric arguments validated per workload profile by workloadCatalog.ts.",
        },
        examples: [],
      };
    }
    return {
      name,
      category: "system",
      availability: "BLOCKED",
      reason:
        "not on the allowlist: this command is not declared in the command catalog. " +
        "The browser may not name a command that the catalog does not declare, and may never name a path.",
      resolvedPath: null,
      readOnly: false,
      workspacePolicy: "no-paths",
      rationale: "None. This command is refused by policy.",
      telemetryRelevance: "None. The command was not executed.",
      timeoutMs: 0,
      maxOutputBytes: 0,
      argumentSchema: NO_ARGS,
      examples: [],
    };
  }

  // First-party helpers come from the repository, not from a system directory.
  const helperPath = REPOSITORY_HELPERS[name];
  if (helperPath !== undefined) {
    /*
     * A repository helper is verified WITHOUT the trusted-directory
     * containment check, because it is supposed to live in this repository's
     * own build directory -- which is by construction outside /usr/bin.
     *
     * It is trusted for a different reason than a system command: it is built
     * by `make` from source in this tree, so its provenance is the repository
     * rather than the filesystem. The path is derived from `repoRoot` and the
     * fixed helper name, never from client input, so the browser cannot
     * influence which file is executed.
     */
    const verified = verifyExecutableFile(helperPath);
    return {
      name,
      category: definition.category,
      availability: verified.ok ? "AVAILABLE" : "UNAVAILABLE",
      reason: verified.ok
        ? `first-party helper built by this repository, verified at ${verified.path}`
        : `${helperPath} ${verified.reason}. Run "make" to build the repository helpers.`,
      resolvedPath: verified.ok ? verified.path : null,
      readOnly: definition.readOnly,
      workspacePolicy: definition.workspacePolicy,
      rationale: definition.rationale,
      telemetryRelevance: definition.telemetryRelevance,
      timeoutMs: definition.timeoutMs,
      maxOutputBytes: definition.maxOutputBytes,
      argumentSchema: definition.argumentSchema,
      examples: definition.examples,
    };
  }

  const probe = probeSystemCommand(name);
  return {
    name,
    category: definition.category,
    availability: probe.available ? "AVAILABLE" : "UNAVAILABLE",
    reason: probe.reason,
    resolvedPath: probe.path,
    readOnly: definition.readOnly,
    workspacePolicy: definition.workspacePolicy,
    rationale: definition.rationale,
    telemetryRelevance: definition.telemetryRelevance,
    timeoutMs: definition.timeoutMs,
    maxOutputBytes: definition.maxOutputBytes,
    argumentSchema: definition.argumentSchema,
    examples: definition.examples,
  };
}

/** Every catalog command with its probed availability. */
export function probeCatalog(): ProbedCommand[] {
  return catalogNames().map((name) => probeCommand(name));
}

/** Summary counts, for the capability response. */
export function catalogSummary(): { total: number; available: number; unavailable: number; blocked: number } {
  const probed = probeCatalog();
  return {
    total: probed.length,
    available: probed.filter((c) => c.availability === "AVAILABLE").length,
    unavailable: probed.filter((c) => c.availability === "UNAVAILABLE").length,
    blocked: probed.filter((c) => c.availability === "BLOCKED").length,
  };
}

/** The directory a resolved executable lives in, for display. */
export function executableDir(path: string): string {
  return dirname(path);
}
