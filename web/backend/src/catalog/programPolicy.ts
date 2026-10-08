/**
 * Program-operand policy for the two catalog entries whose leading positional
 * is a PROGRAM rather than data: `awk` and `sed`.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `leadingPatternPositionals` exempts a leading operand from the workspace path
 * policy so that `grep pattern file` and `awk '{print $1}' file` stay legal.
 * For a pattern that exemption is sound. For a PROGRAM it is not, because an
 * awk program and a sed script are not data the engine can inspect: they are
 * executed, and they can name files the path policy would have refused.
 *
 * Concretely, before this module existed the gateway accepted, validated, and
 * executed all three of these, in a product whose entire security story is
 * "no shell, allowlisted argv, workspace confinement":
 *
 *   awk 'BEGIN{system("id > /tmp/x")}'          arbitrary command execution
 *   awk 'BEGIN{print "p" > "/tmp/x"}'           arbitrary file write, outside the workspace
 *   awk 'BEGIN{while((getline l < "/etc/passwd")>0) print l}'   arbitrary file read
 *   sed 'w /tmp/x' file                         arbitrary file write (the `w` command)
 *   sed 's/x/y/e' file                          arbitrary command execution (GNU `e` flag)
 *
 * That is precisely the capability CAPS refuses `python`, `perl`, `node`,
 * `ruby`, `php`, `gcc` and `make` for, so allowing it here while refusing it
 * there was a hole in the model, not a feature.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It is not a sandbox and it does not try to prove an awk program harmless. It
 * refuses the specific constructs that break out of the model, and it says
 * which one it found. A program that uses none of them can still only read the
 * workspace files the path policy already admitted and write to its stdout,
 * which is what "read-only catalog entry" means everywhere else here.
 *
 * Two escapes remain deliberately open, and both are the documented contract of
 * these tools rather than a CAPS limitation: `awk -f prog.awk` reads a script
 * from a workspace file (which the path policy admits, like any other file
 * argument), and a program can still be arbitrarily long within the schema's
 * `maxArgumentBytes` bound.
 */

/** A construct that breaks the workspace/no-shell model, and how to say so. */
export interface ProgramPolicyViolation {
  /** Machine-readable name, used in tests and in the refusal reason. */
  readonly kind:
    | "shell-escape"
    | "file-write"
    | "file-read"
    | "script-load"
    | "shell-flag";
  /** One clause naming the rule, appended to the caller-facing message. */
  readonly rule: string;
}

/**
 * Scan an awk program for the constructs that escape the model.
 *
 * This is a scanner, not a regex sweep, because the dangerous operators
 * (`>`, `|`, `(`) are also ordinary awk syntax:
 *
 *   $1 > 5                is a COMPARISON and must stay legal
 *   print ($1 > 5)        is a comparison inside parentheses, and must stay legal
 *   print $1 > "/tmp/x"   is a REDIRECTION and must be refused
 *
 * A regex cannot tell those apart. So the program is walked once, tracking
 * string literals (so `print "system"` is not mistaken for a call), paren depth
 * (so a comparison at depth 1 is not mistaken for a redirection), and the
 * position of the last `print`/`printf` statement.
 */
export function findAwkProgramViolations(program: string): ProgramPolicyViolation[] {
  const found: ProgramPolicyViolation[] = [];
  const add = (kind: ProgramPolicyViolation["kind"], rule: string): void => {
    if (!found.some((v) => v.kind === kind)) found.push({ kind, rule });
  };

  /*
   * Replace string literals with a placeholder of equal length so that byte
   * offsets still line up with the source (which keeps the scan honest) while
   * their contents cannot match a keyword.
   */
  const masked = maskLiterals(program, '"');

  // `@load` / `@include` pull in an arbitrary file at parse time.
  if (/^[ \t]*@(load|include)\b/m.test(masked)) {
    add("script-load", "an awk program may not use @load or @include");
  }

  // `system(...)` is a shell. There is no argument shape that makes it safe.
  if (/(^|[^A-Za-z0-9_$])system[ \t]*\(/.test(masked)) {
    add("shell-escape", "an awk program may not call system()");
  }

  /*
   * `getline` is the file-read primitive. Both forms exist --
   * `getline < "f"` and `getline line < "f"` -- and both name a file the path
   * policy never saw, so the whole keyword is refused.
   */
  if (/(^|[^A-Za-z0-9_$])getline\b/.test(masked)) {
    add("file-read", "an awk program may not use getline");
  }

  // Output redirection and pipe-to-command, both only after print/printf.
  for (const hit of findPrintRedirects(masked)) {
    if (hit === ">") {
      add("file-write", "an awk program may not redirect print/printf output to a file");
    } else {
      add("shell-escape", "an awk program may not pipe print/printf output to a command");
    }
  }

  return found;
}

/**
 * Scan a sed script for the constructs that escape the model.
 *
 * `w`/`W` append a copy of the pattern space to a file and `r`/`R` splice a
 * file's contents into the output, so the file operand is invisible to CAPS.
 * GNU sed's `e` flag and `e` command run text through the shell.
 */
export function findSedScriptViolations(script: string): ProgramPolicyViolation[] {
  const found: ProgramPolicyViolation[] = [];
  const add = (kind: ProgramPolicyViolation["kind"], rule: string): void => {
    if (!found.some((v) => v.kind === kind)) found.push({ kind, rule });
  };

  const masked = maskLiterals(script, "'");

  /*
   * The `w`, `W` and `r` commands are legal only in command position: at the start
   * of the script, after `;`, `{`, `}` or `)`, or as the trailing command of a
   * substitution (`s/a/b/w f`). Anchoring on command position is what keeps
   * `s/w/x/` -- a substitution of the letter w -- legal while catching
   * `;w /tmp/x` and `s/a/b/w /tmp/x`.
   *
   * The group around this alternation is load-bearing. Without it the trailing
   * `w` binds only to the last branch, the whole pattern degenerates into
   * "match the empty string", and every script is reported as using every
   * command -- which is a silent false positive in the other direction, and the
   * worse of the two failure modes here.
   */
  const CMD = String.raw`(?:(?:^|[;{}])[ \t]*|\)[ \t]*|\/[ \t]*)`;

  if (new RegExp(`${CMD}w[ \t]`).test(masked)) {
    add("file-write", "a sed script may not use the `w` command, which writes a file");
  }
  if (new RegExp(`${CMD}W[ \t]`).test(masked)) {
    add("file-write", "a sed script may not use the `W` command, which appends to a file");
  }
  if (new RegExp(`${CMD}r[ \t]`).test(masked)) {
    add("file-read", "a sed script may not use the `r` command, which reads a file");
  }

  // GNU sed: the standalone `e` command runs a shell.
  if (new RegExp(`${CMD}e[ \t]`).test(masked)) {
    add("shell-escape", "a sed script may not use the `e` command, which runs a shell");
  }

  // GNU sed's `e` FLAG sits at the end of a substitution: `s/a/b/e`.
  if (/s[^;/\n]*\/[^;\n]*\be\b[ \t]*$/.test(masked)) {
    add("shell-escape", "a sed script may not use the `e` flag, which runs a shell");
  }

  return found;
}

/**
 * Blank out the contents of double-quoted literals.
 *
 * Length is preserved on purpose: the caller scans by offset, and silently
 * changing lengths would make every later position wrong. An escaped quote does
 * not end the literal, matching awk's own lexer.
 */
function maskLiterals(source: string, quote: '"' | "'"): string {
  const out = source.split("");
  let i = 0;
  while (i < source.length) {
    if (source[i] === "\\") {
      // Keep the escape pair visible as blanks; it cannot start a literal.
      out[i] = " ";
      if (i + 1 < source.length) out[i + 1] = " ";
      i += 2;
      continue;
    }
    if (source[i] === quote) {
      out[i] = " ";
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out[i] = " ";
          if (i + 1 < source.length) out[i + 1] = " ";
          i += 2;
          continue;
        }
        const closing = source[i] === quote;
        out[i] = " ";
        i += 1;
        if (closing) break;
      }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** Operators that turn a `print`/`printf` into an escape rather than a write to stdout. */
type RedirectKind = ">" | "pipe";

/**
 * Find `>`/`>>`/`|` that follow a `print` or `printf` at the same paren depth,
 * stopping at the end of that statement.
 *
 * The paren-depth tracking is the whole point: without it, `print ($1 > 5)`
 * would be reported as a redirection and a perfectly ordinary comparison would
 * be refused.
 */
function findPrintRedirects(masked: string): RedirectKind[] {
  const kinds: RedirectKind[] = [];
  let depth = 0;
  /** True when a print/printf was seen at this depth and not yet terminated. */
  let pendingPrint = false;
  let pendingDepth = 0;

  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i]!;

    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      // A print whose operand was parenthesised has finished its statement.
      if (pendingPrint && depth < pendingDepth) {
        pendingPrint = false;
        pendingDepth = 0;
      }
      continue;
    }
    if (ch === ";" || ch === "{" || ch === "}" || ch === "\n") {
      pendingPrint = false;
      pendingDepth = 0;
      continue;
    }

    if (/(^|[^A-Za-z0-9_$])print(f)?[ \t]*($|[^A-Za-z0-9_$])/.test(masked.slice(Math.max(0, i - 1), i + 7))) {
      pendingPrint = true;
      pendingDepth = depth;
      i += 5;
      continue;
    }

    if (!pendingPrint || depth !== pendingDepth) continue;
    if (ch === ">") {
      kinds.push(">");
      pendingPrint = false;
      continue;
    }
    if (ch === "|") {
      kinds.push("pipe");
      pendingPrint = false;
      continue;
    }
  }

  return kinds;
}