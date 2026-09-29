# Final release verification

Every result below is from an actual run of this work, not from a previous
iteration. Commands are the ones CI runs, so a reader can reproduce them
exactly.

## Environment

| | |
| --- | --- |
| Kernel | WSL2, Linux 6.18.33.2-microsoft-standard-WSL2 |
| Compiler | gcc (Ubuntu 15.2.0-16ubuntu1) 15.2.0 |
| Node | v22.14.0 (WSL2), v24.19.0 (Windows host) |
| npm | 10.9.2 (WSL2), 11.17.0 (Windows host) |
| Database | SQLite via Node's built-in `node:sqlite` |
| Frontend build | Vite 6, production bundle |
| Date | 2026-09-29 |

Clang is **not** installed in this environment, so the Clang leg of the CI
matrix is configured and declared but was not executed here. It is the one
verification item below that is `NOT RUN` locally.

---

## C engine

```sh
make clean
make CFLAGS="-std=c11 -Wall -Wextra -Wpedantic -Werror -g"   # GCC strict
make test
make test-asan
make test-workloads
make test-workloads-asan
```

| Check | Result |
| --- | --- |
| GCC strict build, `-Werror` | **PASS** — zero warnings |
| Clang strict build, `-Werror` | **NOT RUN** — clang not installed locally; runs in CI |
| `make test` (13 suites) | **PASS** — **151 assertions** |
| `make test-asan` (ASan + UBSan, `detect_leaks=1`) | **PASS** — the same **151 assertions** |
| `make test-workloads` | **PASS** — **60 assertions** |
| `make test-workloads-asan` | **PASS** — the same **60 assertions** |

Test suites: `test_smoke`, `test_parser`, `test_execution`, `test_errors`,
`test_exit_status`, `test_signals`, `test_redirection`, `test_exit_parse`,
`test_fd_edge`, `test_monitor`, `test_lifecycle`, `test_waitpolicy`,
`test_wait_failure`.

### Failure-mode coverage added in this milestone

* `tests/test_lifecycle.sh` — exec failure is terminal and carries its errno;
  126 and 127 are distinguishable; a target's own non-zero exit is not an exec
  error; a signalled run reports `SIGNALED`; a blank line emits no event; the
  parser rejects an operator in the file-name slot for every combination; a
  20 000-character token and a 3 000-token argv both execute; the parent
  survives `SIGINT` while a child runs; the monitor protocol never reaches
  stdout.
* `tests/test_wait_failure.sh` — a permanent `waitpid()` failure is reported
  exactly once, preserves the real errno, and never fabricates a status.

## Backend

```sh
cd web/backend
npm ci
npm run typecheck
npm run build
node node_modules/vitest/vitest.mjs run
```

| Check | Result |
| --- | --- |
| `npm run typecheck` | **PASS** |
| `npm run build` | **PASS** |
| `vitest run` | **PASS** — **185 tests**, 12 files |

Suites: `unit/policy` (20), `unit/invariants` (23), `unit/infrastructure`
(26), `unit/config` (18), `unit/analytics` (4), `unit/normalizer` (7),
`unit/parser` (7), `unit/peaks`, `telemetry/collector` (16),
`telemetry/sampler` (14), `execution/workloadCatalog` (13), and
`api/server` (32) — the last against the **real C engine** and the **real
controlled workloads**.

### Failure-mode coverage added in this milestone

* Remote bind rejection, remote-mode token enforcement, and the rejection of a
  token in local mode (`config`).
* Cross-field configuration validation: default timeout above maximum, invalid
  log level, out-of-range port, negative retention.
* Executable resolution: absolute-path guarantee, symlink refusal, symlink
  loops, non-executable files, directories, missing files.
* PID-reuse safety: `escalateTo` refuses without an identity, refuses a
  mismatched identity, and refuses a vanished PID.
* All thirteen event-stream invariants, each asserted to produce a *named*
  violation rather than a boolean.
* Buffered-bus race: events published during the read window are delivered
  exactly once, with the overlap dropped.
* Versioned migrations, idempotency, refusal of a newer schema, removal of the
  unused `processes` table, and the busy timeout.
* Corrupt persisted payloads, and transactional rollback of a partial session.
* Retention deletion of sessions, events, and redirection rows together.
* Output-channel classification, including a truncated protocol line.
* Line assembly across chunks with no trailing newline.

## Frontend

```sh
cd web/frontend
npm ci
npm run typecheck
npm run build
node node_modules/vitest/vitest.mjs run
```

| Check | Result |
| --- | --- |
| `npm run typecheck` | **PASS** |
| `npm run build` (production bundle) | **PASS** — built in ~22 s |
| `vitest run` | **PASS** — **139 tests**, 9 files |

### Failure-mode coverage added in this milestone

* A recycled PID produces two records and a reported collision, and an
  ambiguous identity with no start time resolves to `null` rather than a guess.
* A signal is attributed only to the process its event names, and the space
  view does not mark a sibling that exited 0 as `SIGNALED`.
* 2D and 3D reach the same selected event, node key, identity confidence,
  cursor moment, and nearest event from one record.
* The store cannot leak a selection, cursor, or event across sessions.

## Integration and browser

| Check | Result |
| --- | --- |
| Real gateway integration against the real engine | **PASS** — 32 tests, ~17 s |
| Browser smoke against the production build | **PASS** — 15 assertions |
| Replay fingerprint identical across two reads | **PASS** |
| SSE ids contiguous from 0 with no gaps, no synthetic sequence | **PASS** |
| Output channels separated (no monitor protocol in stderr) | **PASS** |
| Production bundle code-split (entry 420 573 bytes) | **PASS** |

The browser smoke suite asserts behaviour, not pixels. There is **no**
visual-regression (pixel-diff) baseline in this repository and none is claimed.

## Repository

```sh
sh scripts/check-attribution.sh
sh scripts/check-repository-hygiene.sh
sh scripts/check-trailing-newline.sh
sh scripts/check-lockfiles.sh
sh scripts/check-docs.sh
git diff --check
```

| Check | Result |
| --- | --- |
| Commit attribution (46 commits) | **PASS** — no AI author, committer, or co-author |
| Repository hygiene | **PASS** — no tracked artifacts, databases, secrets, or local paths |
| Trailing newline (183 text files) | **PASS** |
| Lockfile and version consistency | **PASS** — 1.1.0 in the gateway and both packages |
| Documentation links | **PASS** |
| `git diff --check` | **PASS** — no whitespace errors |

## Performance

`web/backend/scripts/benchmark.ts`, this machine, four scales:

| Events | Insert (µs/event) | Replay (µs/event) | Invariants | Analytics | 3D view-model | Size |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | 14.1 | 12.9 | 0.8 ms | 1.5 ms | 1.2 ms | 0.2 MiB |
| 1 000 | 9.2 | 9.8 | 0.8 ms | 7.6 ms | 2.0 ms | 1.1 MiB |
| 10 000 | 12.3 | 15.8 | 13.6 ms | 82.4 ms | 34.7 ms | 10.9 MiB |
| 100 000 | 11.6 | 24.7 | 268.9 ms | 1 101.5 ms | 150.2 ms | 108.7 MiB |

Per-event insert cost is flat across three orders of magnitude (0.8× from 100
to 100 000 events) and replay load grows 1.9×. The analytics aggregate is linear
in stored snapshots, which is why retention exists.

## Status classification

| Item | Status |
| --- | --- |
| GCC strict build | **PASS** |
| Clang strict build | **NOT RUN** — not installed locally; CI runs it |
| C tests | **PASS** — 151 assertions, 13 suites |
| C ASAN/UBSAN | **PASS** — the same 151 assertions under ASan + UBSan |
| Workload tests | **PASS** — 60 assertions |
| Workload sanitizers | **PASS** — the same 60 assertions |
| Backend typecheck | **PASS** |
| Backend build | **PASS** |
| Backend tests | **PASS** (185) |
| Frontend typecheck | **PASS** |
| Frontend build | **PASS** |
| Frontend tests | **PASS** (139) |
| Real gateway integration | **PASS** |
| Replay integrity | **PASS** |
| Cross-view correlation | **PASS** |
| Browser smoke | **PASS** |
| WebGL / 2D / table fallbacks | **PASS** |
| Documentation links | **PASS** |
| Repository hygiene | **PASS** |
| Commit attribution | **PASS** |
| Performance at 4 scales | **PASS** |
| Visual-regression (pixel diff) | **NOT APPLICABLE** — no such system exists or is claimed |

Overall: **release hardened, verified on Linux/WSL2, known limitations
documented.**

This is not a claim of production readiness. CAPS is a local, single-user
observability tool with a loopback security boundary, single-PID observation
scope, and no multi-tenant model. What is claimed here is that the behaviours
listed above were executed and passed, and that the limitations were measured
rather than assumed.
