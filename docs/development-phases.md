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
| 6     | Automated testing                         | Planned | —         |
| 7     | Basic signal handling                     | Planned | —         |
| 8     | Optional IPC extensions (pipes/redirection)| Planned | —         |
| 9     | Final documentation                       | Planned | —         |
| 10    | CI + final engineering review             | Planned | —         |

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
`{"echo","Hello","World",NULL}` (visible via `--debug`). Commit
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

## Phase 8 — Optional IPC extensions

**Goal.** Only if core is stable. Pipes then redirection, each in its
own phase/commit with tests and docs:

- pipeline: `cmd1 | cmd2` via `pipe()` + two `fork()`s + `dup2()`;
- redirection: `>`/`>>`/`<` via `open()`/`dup2()`/`close()`.

**Gate:** each feature documented, tested, committed separately. If
skipped, state is marked "not implemented — documented as planned".

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

## Definition of done (repeated from requirements)

Fresh Linux checkout: `make` clean; `make clean && make` reproduces;
`./caps` runs; parsing/args/fork/exec/wait/status all correct;
invalid commands keep the REPL alive; EOF exits cleanly; `help`/`exit`
work; `make test` passes; docs match implementation; no fake claims;
git history reflects genuine incremental development.