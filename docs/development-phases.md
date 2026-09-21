# Development Phases

Status: **live roadmap** (updated as phases complete)

This file records the engineering roadmap and the actual state of each
phase. A phase is marked complete only after it has been implemented,
compiled, tested, reviewed, and committed.

---

## Phase status table

| Phase | Title                                      | State   | Commit(s) |
| ----- | ------------------------------------------ | ------- | --------- |
| 0     | Research + specification                   | Complete | `b0a4859` |
| 1     | Project foundation (build skeleton)        | Complete | `2eb5241` |
| 2     | Minimal fork/execvp/waitpid execution      | Complete | `657a8c3` |
| 3     | Argument vector handling                   | Complete | `3e26022` |
| 4     | Interactive REPL                          | Complete | `9eb97cd` |
| 5     | Built-ins + robust error handling          | Complete | `e6729af` |
| 6     | Automated testing                         | Complete | `d258be7` |
| 7     | Basic signal handling                     | Complete | `5789864` |
| 8a    | Redirection (>, >>, <)                    | Complete | `11cf4ba` |
| 8b    | Pipeline (pipe)                           | Skipped — not implemented, documented as planned |
| 9     | Final documentation                       | Complete | `c649b16` |
| 10    | CI + final engineering review             | Complete | `35b532f`, `68ed348` |
| 11    | Hardening + real-time execution monitoring | Complete | `0047170`, `6dc7f94`, `c9e9cff`, `ed63649`, `11fad6b`, `7c251e7`, `c84f1f0` |

---

## Phase 0 — Research + specification

**Goal.** Understand the problem before coding. Produce the design
documents that constrain every later phase.

Deliverables (this repository state):

| Document | Purpose |
| -------- | ------- |
| `docs/requirements.md` | normative behavior, scope, non-goals, error model, definition of done |
| `docs/architecture.md` | module layout, data flow, build/test design, design decisions |
| `docs/process-lifecycle.md` | fork/exec/wait semantics, status macros, child safety rules |
| `docs/argument-passing.md` | text -> argv -> main(argc, argv) transmission |
| `docs/development-phases.md` | this roadmap |

Research summary (references in `requirements.md §10`):

- `fork(2)`: returns child PID to parent, 0 to child, -1 on failure.
- `execvp(3)`: replaces the image; only returns on failure; PATH search.
- `waitpid(2)`: synchronizes with the child; status decoded with
  `WIFEXITED`/`WEXITSTATUS`/`WIFSIGNALED`/`WTERMSIG`.
- `getline(3)`: dynamic line input; chosen over fixed-size buffers.
- POSIX `<sys/wait.h>` semantics for the status macros.

**Gate:** all Phase 0 documents written; committed as
`docs: define project requirements and architecture`.

---

## Phase 1 — Project foundation

**Goal.** Minimal, reproducible build skeleton; no feature code yet.

Deliverables:

- `Makefile` with `CC`, `CFLAGS` (`-std=c11 -Wall -Wextra -Wpedantic
  -g`), targets `caps`, `clean`, `test`, `run`;
- `.gitignore` for `*.o`, the binary, and junk;
- `src/` + `include/` scaffolding only as needed (e.g. a trivial
  `main.c` that prints a banner and exits).

**Gate:** `make clean && make` succeeds; `make clean` leaves no
artifacts. Commit `build: establish Linux C project foundation`.

---

## Phase 2 — Minimal process execution

**Goal.** The core lifecycle, demonstrated with the simplest possible
interface: one-shot mode `caps <command> [arg ...]`.

Deliverables:

- `process` module (fork/execvp/waitpid) with a strict child contract;
- fork/exec/waitpid error handling;
- interactive mode still not required.

**Gate:** `./caps echo hello` prints `hello`; unknown command reports
`command not found`; exit status propagates. Commit
`feat: implement fork execvp waitpid command execution`.

---

## Phase 3 — Argument vector handling

**Goal.** Explicit, provable argv construction.

Deliverables:

- `parser` module: whitespace tokenization, `argv[argc] == NULL`
  invariant;
- debug trace showing the built argv;
- tests for the parser boundary.

**Gate:** `./caps echo Hello World` constructs
`{"echo","Hello","World",NULL}` (visible via `caps --parse`). Commit
`feat: implement command argument vector handling`.

---

## Phase 4 — Interactive REPL

**Goal.** `caps>` prompt; repeated read/parse/fork/exec/wait cycles.

Deliverables:

- REPL loop using `getline()`;
- blank-line and whitespace-only handling;
- EOF handling (clean exit);
- prompt output via stderr or stdout as chosen in review;
- parser handles leading/trailing/repeated whitespace and tabs.

**Gate:** interactive session behaves per `docs/requirements.md §6`.
Commit `feat: add interactive command execution loop`.

---

## Phase 5 — Built-ins + robust error handling

**Goal.** `help` and `exit`, plus hardened error paths.

Deliverables:

- `builtin` module; help text; clean exit;
- unified `caps:` error prefix;
- parent survives every command failure.

**Gate:** invalid command then valid command still works; `help`,
`exit` work; doc updates match. Commit
`feat: add built-ins and robust execution errors`.

---

## Phase 6 — Automated testing

**Goal.** `make test` exercises parser, execution, statuses, signals.

Deliverables:

- `tests/test_parser.sh`, `tests/test_execution.sh`,
  `tests/test_errors.sh`, `tests/test_exit_status.sh`;
- deterministic helper programs compiled by the harness;
- sanitizer build (ASan/UBSan) run as part of tests.

**Gate:** all tests pass; regression: every prior example still works.
Commit `test: add command execution and process lifecycle tests`.

---

## Phase 7 — Basic signal handling

**Goal.** Documented, minimal signal behavior: parent survives Ctrl+C;
child termination by signal is correctly reported (status, not
handling).

Deliverables:

- parent SIGINT disposition safe for the REPL;
- child inherits default dispositions so `sleep` / Ctrl+C behaves;
- `docs/signals.md` or equivalent; honest limitation statement.

**Gate:** `caps> sleep 5` + Ctrl+C does not kill the prompt; status
reporting verified. Commit `feat: add basic child signal handling`.

---

## Phase 8a — Redirection

**Goal.** Add `>`/`>>`/`<` redirection to the interactive REPL, chosen
over pipelines as the Phase 8 extension (scope decision, recorded in
the review of Phase 7).

Deliverables:

- parser: `parser_split_redirections()` — validate-first extraction of
  redirection tokens, transferring file tokens into a redirection list
  and freeing operator tokens, keeping `argv[argc] == NULL`;
- process: fds opened in the parent before `fork()`; `dup2()` +
  `close()` in the child before `execvp()`; parent closes its copies
  before `waitpid()`;
- REPL: redirections pair with external commands; built-ins reject
  them; syntax failures and open() failures never kill the prompt;
- `tests/test_redirection.sh` (truncate, append, input, combined,
  operator position, syntax errors, missing/unwritable targets,
  built-in rejection);
- `docs/redirection.md`; `docs/architecture.md` and
  `docs/requirements.md` updated to match.

**Gate:** `make clean && make` zero warnings; `make test` and
`make test-asan` green (leak detection on). Commit
`feat: add basic output redirection`.

---

## Phase 8b — Pipeline (not implemented)

`cmd1 | cmd2` via `pipe()` + two `fork()`s + `dup2()` remains planned
and is documented as such; it is not implemented.

---

## Phase 9 — Final documentation

**Goal.** Production-quality `README.md` matching implementation.

Deliverables:

- overview, motivation, objectives, architecture, lifecycle,
  argument passing, system calls, structure, build, usage, examples,
  error handling, testing, limitations, future work, design decisions;
- truthful Mermaid diagrams.

**Gate:** every claim in the README is exercised or marked planned.
Commit `docs: finalize project documentation`.

---

## Phase 10 — CI + final engineering review

**Goal.** Linux CI (GitHub Actions) runs `make` + `make test`.

Deliverables:

- `.github/workflows/ci.yml` (ubuntu-latest, build + test);
- full code review against the checklist in `docs/requirements.md`;

**Gate:** clean clone -> `make` -> `make test` green in CI; review
checklist satisfied. Commit `ci: add Linux build and test workflow`.

---

## Phase 11 — Hardening + real-time execution monitoring

**Goal.** Fix two confirmed correctness bugs, make documented claims
match the code, strengthen regression tests, and add an observational
real-time event stream — without changing the architecture or faking
capability.

Deliverables:

- **Redirection descriptor ownership fix** (`src/process.c`): skip
  `dup2`/`close` when `open()` returned the destination fd itself
  (`fd == target`), so redirecting while a standard descriptor is
  closed no longer produces an empty file. Regression:
  `tests/test_fd_edge.sh`.
- **Built-in `exit` argument validation** (`src/builtin.c`): replace
  `atoi()` with a `strtol()`-based parser that rejects non-numeric,
  partially-numeric, out-of-range, and overflow inputs, reporting
  `exit: invalid status: '<arg>' (expected an integer in the range
  0..255)` and continuing the REPL. Regression:
  `tests/test_exit_parse.sh`.
- **Signal setup error handling** (`src/signals.c`): `sigaction`
  failures are reported instead of ignored (parent warns and
  continues; child warns and proceeds to `exec`).
- **Documentation accuracy:** the post-`fork()` child is no longer
  described as an async-signal-safe/signal-handler context; the
  whitespace-required redirection grammar and multiple-redirection
  (last-one-wins per slot) semantics are documented.
- **Test-diagnostic hardening:** shell tests capture `$?` immediately
  instead of reading it after a `[ ]` test, so failure messages report
  the real status.
- **Real-time execution monitoring** (`src/monitor.c`,
  `include/monitor.h`, `--monitor [--json]`): event-driven emissions at
  `COMMAND_RECEIVED`, `PARSED`, `REDIRECTION_OPENED/FAILED`,
  `PROCESS_STARTED`, `PROCESS_EXITED`, `SIGNAL_RECEIVED`, `EXEC_ERROR`,
  plus a `SESSION_SUMMARY`. Text and one-JSON-object-per-line modes;
  optional `jq` validation. No threads, no polling, no sleeps.
  Regression: `tests/test_monitor.sh`.

**Gate:** `make clean && make` zero warnings; `make test`,
`make test-asan` (ASan + UBSan + leak detection) all green; the two
bugs are reproduced-then-fixed. Committed as `0047170` (redirection fd
ownership), `6dc7f94` (sigaction failures), `c9e9cff` (exit parsing),
`ed63649` (monitor), `11fad6b` (tests), `7c251e7` (executable bit), `c84f1f0` (CI).

---

## Definition of done (repeated from requirements)

Fresh Linux checkout: `make` clean; `make clean && make` reproduces;
`./caps` runs; parsing/args/fork/exec/wait/status all correct;
invalid commands keep the REPL alive; EOF exits cleanly; `help`/`exit`
work; `make test` passes; docs match implementation; no fake claims;
git history reflects genuine incremental development.