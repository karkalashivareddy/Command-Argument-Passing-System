# Requirements Specification

Status: **Approved baseline** (Phase 0)
Scope owner: Command Argument Passing System (`caps`)

---

## 1. Project identity

| Field       | Value                                           |
| ----------- | ----------------------------------------------- |
| Name        | Command Argument Passing System                 |
| Executable  | `caps`                                          |
| Language    | C (C11)                                         |
| Platform    | Linux / POSIX-like Unix                         |
| Build       | Make                                            |
| Compiler    | `cc` (Makefile `CC`; e.g. GCC or Clang)         |
| Not         | a Bash replacement                              |

---

## 2. Problem statement

When a Unix shell or launcher starts a program, it must:

1. read a command line,
2. split it into a command name and its arguments,
3. construct a memory representation the kernel can reuse
   (`argv[]`, terminated by `NULL`),
4. create a child process (`fork()`),
5. replace that child's program image with the requested program
   (`execvp()`), and
6. wait for completion and interpret the result (`waitpid()`).

Most new systems programmers treat "running a command" as a magic box.
This project rebuilds that box so the entire lifecycle is visible,
understandable, and testable:

```text
command + arguments
        -> argv[] (NULL-terminated)
        -> fork()
        -> execvp()
        -> target main(argc, argv)
        -> exit status / signal
        -> waitpid() in parent
```

The project demonstrates why each of these system-call steps exists and
how they fit together.

---

## 3. Objectives

The project must demonstrate:

1. **Process creation** — `fork()` creates a child that is a duplicate
   of the parent.
2. **Process replacement** — `execvp()` replaces the child's program
   image with the requested program while preserving the same PID.
3. **Argument passing** — input tokens become `argv[]`;
   `argv[argc] == NULL` is guaranteed as required by `execvp()`.
4. **Synchronization** — the parent blocks in `waitpid()` until the
   child changes state, then inspects the status.
5. **Status interpretation** — `WIFEXITED`/`WEXITSTATUS` vs.
   `WIFSIGNALED`/`WTERMSIG` are distinguished.
6. **Error recovery** — a failed `fork`, `exec`, or `waitpid`, or a
   non-existent command, does not terminate the interactive runner.
7. **Interactive REPL** — a `caps>` prompt drives repeated
   execution of the above cycle.
8. **Automated verification** — behavior is exercised by `make test`.
9. **Documentation** — every design decision, system call, and
   limitation is written down and matches the implementation.

---

## 4. Scope

### 4.1 In scope (must implement)

| Area             | Detail                                                              |
| ---------------- | ------------------------------------------------------------------- |
| Interactive CLI  | `caps>` prompt, one command per line                                |
| One-shot mode    | `caps command [arg ...]`                                            |
| Parsing          | whitespace-separated tokens; `argv[argc] == NULL`                   |
| Process model    | `fork()` in parent, `execvp()` in child, `waitpid()` in parent      |
| Built-ins        | `help`, `exit`, `cd`                                                |
| Redirection      | `>` (truncate), `>>` (append), `<` (input) in interactive REPL      |
| Error handling   | empty input, unknown command, `fork`/`exec`/`waitpid` failures, EOF |
| Status handling  | normal exit, non-zero exit, signal termination                      |
| Build            | `make`, `make clean`, `make test`, `make run`                       |
| Tests            | parser, execution, exit status, signal termination, redirection, resilience |

### 4.2 In scope (must document, implementation optional)

- Pipes / background jobs as clearly-marked extensions (future phase),
  only if the core is stable.

### 4.3 Out of scope (explicitly excluded)
- Wildcard/glob expansion.
- Environment-variable and tilde expansion.
- Command substitution.
- Subshell syntax, `&&`, `||`.
- Job-control process groups and advanced terminal handling.
- Bash compatibility.

These are documented in "future improvements" only.

---

## 5. Terminology

| Term            | Meaning                                                              |
| --------------- | -------------------------------------------------------------------- |
| parent process  | the `caps` process that calls `fork()` and `waitpid()`               |
| child process   | the process created by `fork()`; executes the target program         |
| command         | the first token (e.g. `echo`)                                        |
| argument        | every token after the command (e.g. `Hello`, `World`)                |
| `argv`          | NULL-terminated array of char pointers passed to `execvp()`          |
| `argc`          | number of strings in `argv` (excluding the NULL terminator)          |
| exit status     | value passed to `_exit()`/`exit()` or returned from `main()`         |
| signal          | async notification that can terminate a process (e.g. SIGKILL)       |
| REPL            | Read-Evaluate-Print Loop: `caps>` prompt                             |

---

## 6. Expected behavior (normative)

### 6.1 Launch

```text
$ make
$ ./caps
Command Argument Passing System
Type 'help' for available commands.

caps> echo Hello World
Hello World

caps> exit
$
```

### 6.2 Argument contract

For input `echo Hello World` the runner **must** construct:

```c
argv[0] = "echo";
argv[1] = "Hello";
argv[2] = "World";
argv[3] = NULL;   /* required by execvp() */
```

with `argc == 3`.

### 6.3 Invalid command

```text
caps> nonexistent_command
caps: command not found: nonexistent_command

caps> echo still-alive
still-alive
```

The failed command must **not** terminate the parent REPL.

### 6.4 EOF

On Ctrl+D (EOF) at the prompt, `caps` prints a newline and exits
cleanly with status `0`. No crash, no infinite loop.

### 6.5 Exit status reporting

`caps` must distinguish:

| Outcome             | Reporting                       |
| ------------------- | ------------------------------- |
| exit 0              | quiet (success) in normal mode  |
| non-zero exit       | `caps: 'cmd' exited with status N` |
| terminated by signal| `caps: 'cmd' terminated by signal N` |
| `execvp()` failure  | `caps: command not found: cmd` (if `errno == ENOENT`) |
|                     | `caps: cmd: permission denied` (if `errno == EACCES`)  |
|                     | `caps: cmd: <strerror(errno)>` (otherwise)             |

Diagnostics go to stderr. Normal mode output stays quiet and tidy.

### 6.6 Redirection (interactive REPL)

```text
caps> echo Hello > /tmp/caps_out.txt
caps> cat /tmp/caps_out.txt
Hello

caps> cat < /tmp/caps_out.txt
Hello
```

Operator tokens:

| Token | Meaning                       |
| ----- | ----------------------------- |
| `>`   | truncate output to file       |
| `>>`  | append output to file         |
| `<`   | read input from file          |

Contract:

- a redirection operator consumes the following token as the file name;
- operators may appear before, after, or interleaved with arguments;
- `> f` alone (no command) is a syntax error;
- `echo >` (missing file) is a syntax error;
- a missing input file aborts the command and reports the error;
- an unwritable output path aborts the command and reports the error;
- the REPL is never killed by a redirection failure;
- redirection is **not** supported for built-in commands (`help`,
  `exit`, `cd`); attempting it is reported as an error.
- one-shot mode does **not** interpret redirection tokens; `./caps echo
  > file` passes `>` and `file` literally to `echo`.

---

## 7. Error model

Every important system call must have its return value checked:

```text
fork()      -> parent: -1 = failure (no child created)
execvp()    -> only returns on failure (errno set)
waitpid()   -> -1 = failure (errno set)
open()      -> -1 = failure (errno set; redirection aborts the command)
dup2()      -> -1 = failure (errno set; child terminates)
close()     -> -1 = failure (errno set)  [best-effort reported]
getline()   -> -1 = EOF or error (ferror() disambiguates)
malloc()    -> NULL = allocation failure
```

Errors must state:

1. which operation failed,
2. why, where useful (`strerror(errno)`/`perror`),
3. whether the runner can continue.

Design rule: the child, after `execvp()` failure, must report on
stderr and terminate with `_exit()` so it never falls through into
parent logic.

---

## 8. Non-functional requirements

| Requirement | Policy                                                    |
| ----------- | --------------------------------------------------------- |
| Warnings    | build with `-Wall -Wextra -Wpedantic`; zero warnings      |
| Sanitizers  | Address/UB sanitizers applied during test builds          |
| Memory      | every allocation has one owner; freed; no leaks          |
| Buffers     | no fixed input arrays; `getline()` used for input        |
| External deps | none; libc + kernel interfaces only                  |
| Scope       | no `system()`, no `popen()` for the execution path          |

---

## 9. Testing strategy

- Parser: empty, whitespace-only, single command, one argument,
  multiple arguments, leading/trailing/repeated whitespace.
- Execution: valid command, arguments, options, unknown command.
- Process: success exit 0, non-zero exit, signal termination,
  parent-alive-after-failure.
- Input: EOF, blank lines.
- Deterministic targets: `echo`, `true`, `false`, `printf`, `pwd`,
  `sleep` + signal, plus small C helper programs compiled by the test
  harness for controlled exit codes.

---

## 10. Validation references

Authoritative sources used while writing this specification and the
rest of the Phase 0 documentation:

- `fork(2)` — Linux man-pages 6.18 (man7.org)
- `exec(3)` / `execvp(3)` — Linux man-pages 6.18 (man7.org)
- `execve(2)` — Linux man-pages 6.18 (man7.org)
- `wait(2)` / `waitpid(2)` — Linux man-pages 6.18 (man7.org)
- `<sys/wait.h>` — POSIX.1-2017 (`WIFEXITED`, `WEXITSTATUS`,
  `WIFSIGNALED`, `WTERMSIG`)
- `getline(3)` — Linux man-pages 6.18 (man7.org)
- `exec(3p)` — POSIX Programmer's Manual (man7.org)
- `open(2)` / `dup2(2)` / `close(2)` — POSIX file-descriptor interfaces
  used by the redirection feature (Phase 8)

---

## 11. Definition of done (project level)

A fresh Linux checkout must, in order:

1. `make` succeed cleanly (no warnings);
2. `make clean && make` reproduce the build;
3. `./caps` run interactively;
4. parsing, argument passing, `fork`, `execvp`, `waitpid`, status
   interpretation all behave per Section 6;
5. invalid commands keep the REPL alive;
6. EOF exits cleanly; `help` and `exit` work;
7. `make test` passes all automated tests;
8. documentation matches implementation and diagrams are truthful.