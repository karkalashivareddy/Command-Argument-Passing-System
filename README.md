# Command Argument Passing System

An educational **C11 / POSIX** implementation of the core of a command
shell: tokenizing a command line, building a `NULL`-terminated `argv[]`,
and running the program through `fork()` → `execvp()` → `waitpid()`.

It is a *teaching* project, not a Bash replacement. Its purpose is to
make one piece of Unix legible that most users treat as a black box:

```text
command + arguments
        -> argv[]  (NULL-terminated)
        -> fork()
        -> execvp()
        -> target main(argc, argv)
        -> exit status / signal
        -> waitpid() in parent
```

---

## Objectives

| # | Objective | Where it lives |
| - | --------- | -------------- |
| 1 | **Process creation** — `fork()` makes a child that duplicates the parent | `src/process.c` |
| 2 | **Process replacement** — `execvp()` replaces the child's image, same PID | `src/process.c` |
| 3 | **Argument passing** — tokens become `argv[]`; `argv[argc] == NULL` guaranteed | `src/parser.c` |
| 4 | **Synchronization** — parent blocks in `waitpid()` until the child ends | `src/process.c` |
| 5 | **Status interpretation** — `WIFEXITED`/`WEXITSTATUS` vs `WIFSIGNALED`/`WTERMSIG` | `src/process.c` |
| 6 | **IO redirection** — `>` / `>>` / `<` via `open()`/`dup2()`/`close()` | `src/parser.c`, `src/process.c` |
| 7 | **Signal hygiene** — parent survives Ctrl+C; child signals reported, not mishandled | `src/signals.c` |
| 8 | **Error recovery** — a failed `fork`/`exec`/`waitpid`, or a missing command, never kills the REPL | `src/main.c` |
| 9 | **Automated verification** — `make test` exercises every path above | `tests/` |

---

## Features

- **Interactive REPL** (`caps>`) with `help`, `exit [N]`, and `cd`.
- **One-shot mode** — `caps <command> [arg ...]` runs the pipeline once and exits with the child's status.
- **Redirection** — `>` (truncate), `>>` (append), `<` (input) in the REPL.
- **Correct child statuses** per shell convention: exit code `N`, `128 + signal`, `127` not found, `126` permission denied.
- **Robust child error path** — after a failed `execvp()`, the child writes to stderr with `write(2)` and `_exit()`s, never falling through into parent logic.
- **Debug mode** — `caps --parse` shows the exact `argv[]` a line produces.

---

## Quick start

Requires a Linux / POSIX-like host with GCC or Clang, GNU Make, and a
`sh`-compatible shell. (The Windows-native MinGW toolchain is not a
suitable target for the POSIX process model.)

```sh
make            # builds ./caps (zero warnings with -Wall -Wextra -Wpedantic)
make test       # runs the full test suite against a fresh build
make test-asan  # runs the same suite under AddressSanitizer + UBSan
make clean      # removes build artifacts
```

## Usage

### Interactive session

```text
$ ./caps
Command Argument Passing System 0.1.0
Type 'help' for available commands.

caps> help
Built-in commands:
  help         show this message
  exit [N]     exit the shell with status N (default: last status)
  cd [dir]     change the working directory in this shell

Every other command is run as an external program through
fork() + execvp(); its arguments are passed as the program's
argv[1..]. The parent then waits with waitpid().
caps> echo hello world
hello world
caps> echo hello > out.txt
caps> cat out.txt
hello
caps> echo world >> out.txt
caps> cat out.txt
hello
world
caps> echo end > out.txt
caps> cat out.txt
end
caps> exit
$
```

The `caps>` prompt is diagnostic output and goes to **stderr**; external
programs' output goes to stdout. Redirection (`>`, `>>`, `<`) re-points
the child's stdin/stdout before `execvp()` — that is why `>` truncates
and `>>` appends exactly as a real shell would.

### One-shot mode

```sh
$ ./caps echo Hello World
Hello World

$ ./caps false; echo $?
1

$ ./caps no_such_cmd; echo $?
caps: command not found: no_such_cmd
127
```

### Parse debug mode

```sh
$ ./caps --parse
Command Argument Passing System 0.1.0 (--parse mode)
Enter a command line: echo Hello " World"
argc = 4
argv[0] = echo
argv[1] = Hello
argv[2] = "
argv[3] = World"
argv[4] = (null)
```

Note the parser does **not** interpret quotes — the double quotes above
are literal characters, and the tokenizer splits on whitespace only.

---

## Architecture

### Repository layout

```text
Command-Argument-Passing-System/
├── src/          C source files (one module per file)
├── include/      public headers for the modules
├── tests/        automated test scripts + C helper programs
├── docs/         design documentation
├── Makefile      build, clean, test, run targets
├── .gitignore    build artifacts and junk exclusions
├── .gitattributes LF normalization for text files
├── LICENSE
├── README.md     (this file)
└── ABSTRACT.docx (project abstract)
```

### Module map

| Module            | Responsibility |
| ----------------- | -------------- |
| `src/main.c`      | `main()` — banner, REPL loop, dispatch (built-in vs external) |
| `src/parser.c`    | whitespace tokenizer into `argv[]`; redirection-token extraction |
| `src/process.c`   | `fork()`/`execvp()`/`waitpid()` lifecycle; `open()`/`dup2()`/`close()` for redirection |
| `src/builtin.c`   | `help`, `exit`, `cd` — always run in the parent process |
| `src/signals.c`   | parent SIGINT disposition; child reset before `exec` |
| `src/utils.c`     | `caps_error()` — `caps:`-prefixed stderr reporting |

Dependency direction is strict: `main -> process`, `main -> parser`,
`main -> builtin`, `main -> signals`. Lower layers never call the REPL.

### Data flow

```mermaid
flowchart TD
    U[User types a line] --> R[getline - dynamic buffer]
    R --> T[parser: whitespace tokenization]
    T --> RF[parser: split redirection tokens]
    RF --> A["argv[]  (redirection free, argv[argc] == NULL)"]
    RF --> RD["redir list: type + file"]
    A --> B{builtin?}
    B -->|help/exit/cd| BI[run in parent process]
    B -->|external| O[parent opens redirection files]
    O --> P[fork]
    P --> C[child]
    P --> PA[parent]
    C --> D[child: dup2 onto stdin/stdout, close]
    D --> E[execvp argv0, argv]
    E -->|success| TG[target program main argc, argv]
    TG --> S[exit status or signal]
    S --> W[waitpid reaps status]
    PA --> W
    W --> D2[interpret WIFEXITED / WIFSIGNALED]
    D2 --> R2[back to prompt]
```

### The core cycle

```text
command line
    |
    v
argv[]   (parser guarantees NULL terminator)
    |
    v
fork() ----------+
    |            |
(parent)      (child)
    |            |
waitpid()    execvp()
    |            |
    v            v
status    target program (same PID as child)
    |
    v
interpret: exit code | signal
```

**Why `fork` then `exec` and not a single call?**

- `execvp()` *replaces* the calling process. If `caps` exec'd directly,
  the interactive runner would vanish along with the prompt.
- `fork()` clones the runner; the clone (the child) is the one replaced
  by `execvp()`. The original runner (the parent) keeps executing, so it
  can continue the REPL after the child finishes.
- `waitpid()` gives the parent a rendezvous point: it suspends until
  the child terminates and lets the parent read the outcome.

---

## System calls at a glance

| Call        | Used for | Error behavior |
| ----------- | -------- | -------------- |
| `getline()` | line input (no fixed-size buffer) | `-1` on EOF/error |
| `strtok()`-free tokenization | splitting on whitespace | never fails |
| `fork()`    | creating the child | `-1` → reported, REPL survives |
| `execvp()`  | running the program | returns only on failure; `_exit(127/126)` |
| `waitpid()` | reaping the child | `-1` → reported, REPL survives |
| `open()`    | redirection files | `-1` → command aborted, REPL survives |
| `dup2()`    | wiring file descriptors onto stdin/stdout | `-1` in child → `_exit(1)` |
| `close()`   | releasing descriptors | best-effort |

---

## Redirection

Supported in the interactive REPL only:

| Token | Mode | Open flags |
| ----- | ---- | ---------- |
| `<`   | input | `O_RDONLY` |
| `>`   | truncate output | `O_WRONLY | O_CREAT | O_TRUNC` |
| `>>`  | append output | `O_WRONLY | O_CREAT | O_APPEND` |

The lifecycle in `process_exec()`:

1. the **parent** opens every file before `fork()` — a missing input
   file or unwritable target aborts the command with no child created;
2. the **child** `dup2()`s each descriptor onto stdin/stdout and
   `close()`s the originals before `execvp()`;
3. the **parent** `close()`s its own copies, then `waitpid()`s.

The parser validates redirection tokens before touching anything: a
line that ends in `>` (missing file) is a syntax error, and `> out`
with no command is also rejected. Built-ins (`help`/`exit`/`cd`) reject
redirection. See [`docs/redirection.md`](docs/redirection.md).

---

## Signal handling

- The **parent** ignores `SIGINT` for its lifetime, so Ctrl+C never
  kills the prompt.
- The **child** `sigaction()`s `SIGINT` back to `SIG_DFL` right after
  `fork()` and before `execvp()`. This matters because POSIX `exec`
  preserves `SIG_IGN` dispositions: without the reset, a foreground
  child like `sleep 3` would ignore Ctrl+C too.
- Termination of a child by a signal is reported
  (`caps: 'cmd' terminated by signal N`) and folded into the last
  status as `128 + N`. See [`docs/signals.md`](docs/signals.md).

---

## Error handling

Every command failure is per-command and must never kill the REPL.

| Failure | Behavior |
| ------- | -------- |
| empty / whitespace line | ignored silently |
| unknown command | `caps: command not found: <cmd>` (status 127) |
| permission denied | `caps: <cmd>: permission denied` (status 126) |
| redirection, malformed line | `caps: syntax error: '<op>' requires a file name` |
| redirection, no command | `caps: syntax error: no command to redirect` |
| redirection `open()` fails | `caps: <file>: <strerror(errno)>`; command aborted |
| `fork()` fails | `caps: fork: <strerror(errno)>` |
| `waitpid()` fails | `caps: waitpid: <strerror(errno)>` |
| EOF at prompt | newline + clean exit with last status |

Diagnostics go to **stderr**; successful commands are quiet.

---

## Testing

`make test` runs seven POSIX-shell test scripts that pipe scripted input
into a fresh `./caps` build and assert on stdout/stderr. A small C
helper (`tests/helpers/status_probe.c`) is compiled by the harness so
exit codes and signals can be tested deterministically.

| Script | Coverage |
| ------ | -------- |
| `test_smoke.sh` | end-to-end sanity: echo, help, cd, errors, signals |
| `test_parser.sh` | empty/whitespace input, single/multi args, tab handling |
| `test_execution.sh` | one-shot and REPL execution, argument passing |
| `test_errors.sh` | unknown command, non-executable file, REPL resilience |
| `test_exit_status.sh` | exit codes, signal termination, 128+N, last-status |
| `test_signals.sh` | child SIG_DFL reset, parent survival, status reporting |
| `test_redirection.sh` | `>`/`>>`/`<`, combined, syntax errors, built-in rejection |

`make test-asan` is the same suite rebuilt with AddressSanitizer and
UndefinedBehaviorSanitizer (leak detection enabled).

---

## Documentation

| Document | Contents |
| -------- | -------- |
| [`docs/requirements.md`](docs/requirements.md) | normative behavior, scope, error model, definition of done |
| [`docs/architecture.md`](docs/architecture.md) | module layout, data flow, build/test design, design decisions |
| [`docs/process-lifecycle.md`](docs/process-lifecycle.md) | `fork`/`exec`/`wait` semantics, status macros, child safety rules |
| [`docs/argument-passing.md`](docs/argument-passing.md) | text → `argv[]` → `main(argc, argv)` transmission |
| [`docs/signals.md`](docs/signals.md) | signal dispositions, exec interaction, limitations |
| [`docs/redirection.md`](docs/redirection.md) | fd model, `open`/`dup2`/`close`, parser contract, limitations |
| [`docs/development-phases.md`](docs/development-phases.md) | engineering roadmap and phase records |

---

## Limitations

Documented honestly rather than hidden:

- no quoting, escapes, globs, environment expansion, or command
  substitution — the tokenizer splits on whitespace and passes tokens
  literally;
- no pipelines (`|`), `&&`/`||`, background jobs, or job control;
- redirection applies to external commands in the REPL only; one-shot
  mode passes `>`/`<` literally as arguments;
- no fd-number redirection (`2>`), heredocs, process substitution, or
  `&>`;
- built-ins run in the parent; redirecting them is rejected.

All are recorded in `docs/requirements.md §4.3`.

---

## Future work

- Pipeline support (`cmd1 | cmd2`) via `pipe()` + two `fork()`s + `dup2()`.
- Quoting and escape handling in the tokenizer.
- `&` background execution with simple job tracking.
- fd-number redirection (`2>`, `1<`).

---

## Design decisions

| Decision | Rationale |
| -------- | --------- |
| `getline()` not `fgets()` | dynamic sizing; no arbitrary line-length limit |
| `execvp()` over `execve()` | PATH search; no env plumbing needed here |
| `fork()` rather than `system()` | explicit process model — the project's purpose |
| `waitpid(pid,...)` not `wait()` | unambiguous relation to the exact child |
| `_exit()` in the child after failed `exec` | skips stdio flushing that would duplicate parent buffers; async-signal-safe context |
| module map introduced per phase | complexity appears incrementally; clarity first |
| diagnostics on stderr, output on stdout | keeps success output clean and scriptable |

---

## Author

**Karkala Shiva Reddy** — [GitHub](https://github.com/karkalashivareddy)

Licensed under the MIT License. See [LICENSE](LICENSE).