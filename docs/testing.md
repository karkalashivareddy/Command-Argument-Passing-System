# Testing and verification

Everything in this document is a command you can run. Nothing here is a claim
about what was once true.

- What the system observes and refuses to invent: [`host-telemetry.md`](host-telemetry.md)
- What is enforced, and by whom: [`guardrails.md`](guardrails.md)
- A recorded end-to-end trace of one execution: [`cross-view-trace.md`](cross-view-trace.md)
- Every figure checked against raw `/proc` and `/sys`: [`ground-truth-verification.md`](ground-truth-verification.md)
- Historical runtime record: [`runtime-verification.md`](runtime-verification.md)

---

## Prerequisites

```bash
# Linux. The C engine is POSIX; the gateway's telemetry is /proc and /sys.
# On Windows, use WSL2 and run everything inside the distribution.

make            # builds the engine, the pidfd helper, and the workloads
node --version  # 22 or newer
```

Chromium is needed only for the documentation screenshots and the browser suite:

```bash
cd web/frontend && npm ci && npx playwright install chromium
```

---

## 1. One command for everything local

```bash
make test-scripts     # repository gates and their own self-tests
make test             # C engine, every suite, real assertions
make test-asan        # the same suites under ASan + UBSan + leak detection
make test-workloads      # controlled workloads
make test-workloads-asan # controlled workloads under sanitizers
```

Under `web/backend` and `web/frontend`:

```bash
npm run typecheck && npm test
```

---

## 2. The C engine

### 2.1 Strict build

Warnings are errors. A warning that survives is a defect, not a style choice.

```bash
make clean
make CC=gcc CFLAGS="-std=c11 -Wall -Wextra -Wpedantic -Werror -g"
make clean
make CC=clang CFLAGS="-std=c11 -Wall -Wextra -Wpedantic -Werror -g"
```

**Clang is verified in CI, not locally.** The development environment used for
this release has no Clang and no package-installation rights, so the local run is
GCC with `-Werror`. CI builds and tests both compilers, and CI is the authoritative
Clang check. This is stated rather than implied.

### 2.2 Suites

| Suite | What it proves |
| --- | --- |
| `test_smoke.sh` | the binary runs and reports its version |
| `test_parser.sh` | quoting, escaping, and tokenisation |
| `test_execution.sh` | real programs, real exit codes |
| `test_errors.sh` | launch and exec failures are distinguished |
| `test_exit_status.sh` | 126 and 127 stay distinct |
| `test_signals.sh` | signal delivery and the 128+n convention |
| `test_redirection.sh` | `O_NOFOLLOW` and descriptor wiring |
| `test_exit_parse.sh` | `waitpid` status decoding |
| `test_fd_edge.sh` | descriptor lifetime at the edges |
| `test_monitor.sh` | the monitor protocol, one flush per event, parseable JSON |
| `test_lifecycle.sh` | `fork`/`exec`/`wait` pairing |
| `test_waitpolicy.sh`, `test_wait_failure.sh` | `waitpid` failure policy, via a linked probe |
| `test_pipeline.sh` | real pipes, per-stage pid/pgid, stage accounting |
| `test_pidfd.sh` | pidfd bind, signal, and refusal on a recycled PID |
| `test_limits.sh` | `RLIMIT_*` reach the child, verified in the child's own `/proc/<pid>/limits` |

`test_pidfd.sh` needs a real zombie, which a shell cannot produce: bash reaps its
own jobs, and an orphaned child is re-parented to init, which reaps it at once.
`tests/helpers/zombie_maker.c` holds an unreaped child so those assertions
actually execute.

### 2.3 Sanitizers

```bash
make test-asan
```

AddressSanitizer + UndefinedBehaviorSanitizer with leak detection. Both the
engine and the helper binaries are instrumented, and the pidfd and limits suites
run against the sanitized build — they drive real children, which is exactly the
fork/exec path ASan exists to watch.

For the workloads, ASan options are set so a memory-constrained environment
produces a test failure rather than an exhausted machine:

```
allocator_may_return_null=1:hard_rss_limit_mb=1024:detect_leaks=1
```

---

## 3. Controlled workloads

Real first-party Linux programs, built by this repository, in
`workloads/`. The gateway resolves them through explicit repository-relative
paths and never accepts an arbitrary executable path from the browser.

```bash
make test-workloads
make test-workloads-asan
```

Each is bounded in both time and memory. What each demonstrates is in
[`workload-lab.md`](workload-lab.md).

---

## 4. The gateway

```bash
cd web/backend
npm ci
npm run typecheck
npm run build
npm test
```

| Area | Where |
| --- | --- |
| API, against the **real engine** | `web/backend/tests/api/server.test.ts` |
| Pipeline lifecycle and stage evidence | `web/backend/tests/api/pipeline.test.ts` |
| CAPS-owned attribution, end to end | `web/backend/tests/api/ownership.test.ts` |
| Canonical invariants (I11, I14) | `web/backend/tests/unit/` and `web/backend/tests/api/pipeline.test.ts` |
| argv surviving the engine → gateway boundary | `web/backend/tests/unit/argvBoundary.test.ts` |
| Process identity, ownership, parent-link confidence | `web/backend/tests/unit/processAttribution.test.ts` |
| pidfd capability and signalling | `web/backend/tests/unit/pidfd.test.ts` |
| Thermal guard decisions and configuration | `web/backend/tests/unit/thermalGuard.test.ts`, `thermalGuardConfig.test.ts` |
| Thermal guard on the real execution path (refuses, records, admits) | `web/backend/tests/unit/thermalAdmission.test.ts` |
| Ownership agreement across Process Explorer and Process Detail | `web/backend/tests/api/ownership.test.ts` |
| Failure injection | `web/backend/tests/unit/failureInjection.test.ts` |
| Host telemetry against raw `/proc` | `web/backend/src/telemetry/system/groundtruth.test.ts` |
| Catalog and argument validation | `web/backend/src/catalog/commands.test.ts` |
| Terminal grammar | `web/backend/src/terminal/grammar.test.ts` |

The API suites run the real C engine. A suite that mocked the engine would prove
the mock.

### 4.1 Ground truth

`groundtruth.test.ts` compares collector output against values read
independently from `/proc`, and asserts **provenance and availability**, not just
numbers. It covers CPU delta arithmetic, memory, load-versus-utilisation, each PSI
file independently, RSS versus PSS, process versus device I/O, thermal and
cpufreq absence, and process identity agreement.

---

## 5. The frontend

```bash
cd web/frontend
npm ci
npm run typecheck
npm run build
npm test
```

Tests live in two places on purpose: `web/frontend/src/**/*.test.ts` sits beside the module it
covers, and `web/frontend/tests/` holds cross-cutting suites. **Both** are in the Vitest
`include` globs. Only `src` was included at one point, so a suite written under
`web/frontend/tests/` was silently never run — a green result that proved less than it appeared
to. The glob is asserted by the configuration itself.

---

## 6. Browser and end-to-end

```bash
make caps
make test-helpers
cd web/backend && npm ci && npm run build
cd ../frontend && npm ci && npm run build
# start the gateway, then serve the production build
sh scripts/browser-smoke.sh
```

The suite asserts behaviour, not pixels: the app loads and routes render, a real
execution runs through the real engine, its events arrive over SSE with a
contiguous sequence and an explicit `stream.end`, replay is contiguous with
exactly one terminal event and a passing integrity verdict, a second replay is
byte-identical, the production bundle is hashed and code-split, and the monitor
protocol never leaks into a program's `stderr`.

There is **no visual-regression suite**, and this is a deliberate scope decision
rather than a gap: the repository has no screenshot-diff infrastructure, and adding
one would test pixels rather than the system's claims.

---

## 7. Repository gates

```bash
make test-scripts
```

| Gate | Checks |
| --- | --- |
| `check-attribution.sh` | no AI author, committer, or co-author in the history |
| `check-version.sh` | one authoritative version, projected everywhere |
| `check-version.test.sh` | the version gate **fails when it should** |
| `check-lockfiles.sh` | lockfiles agree with their manifests |
| `check-repository-hygiene.sh` | no build artifacts, databases, or local paths committed |
| `check-trailing-newline.sh` | every text file ends with a newline |
| `check-docs.sh` | every relative link, image, and referenced path resolves |

### The gates are themselves tested

`check-version.test.sh` copies the tree, mutates one declared version location at
a time, and requires the gate to notice each one — including the case where a
README carries both the current and an older version marker. It also asserts that
each mutation actually landed, because a mutation that fails to apply leaves the
tree correct and is indistinguishable from a working gate.

A gate that has never been shown to fail is not evidence of anything.

---

## 8. Documentation and screenshots

```bash
sh scripts/check-docs.sh
```

Screenshots are produced by driving real Chromium against the production build,
the real gateway, and the real engine:

```bash
cd web/frontend
CAPS_SHOT_GATEWAY=http://127.0.0.1:3000 \
CAPS_SHOT_FRONTEND=http://127.0.0.1:4174 \
node scripts/capture-screenshots.mjs
```

The capture **fails rather than producing a placeholder**:

- if a route renders fewer than 200 characters of text, the view did not render;
- if a screenshot's own subject is not on the page, the capture stops;
- if a source file is newer than the built bundle, the run refuses to photograph
  a stale build.

Nothing is painted, mocked, or cropped to hide a state.

---

## 9. Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request to `main`.

| Job | Covers |
| --- | --- |
| `attribution` | the authorship policy over full history |
| `repository-gates` | every gate above, against the real repository and its own self-tests |
| `c-engine` | GCC **and** Clang: strict build, tests, ASan/UBSan, workloads, workload sanitizers |
| `backend` | typecheck, build, tests |
| `frontend` | typecheck, production build, tests |
| `integration` | the real engine through the real gateway |
| `browser-smoke` | the production build against the real gateway |
| `repository-hygiene` | artifacts and full-history attribution |
| `dependency-audit` | high and critical advisories fail the build |
| `codeql` | C/C++ and JavaScript/TypeScript |

CI is the authoritative Clang check. A green local run does not substitute for it.

---

## 10. What is verified where

| Claim | Verified by | Runs locally |
| --- | --- | --- |
| Engine correctness | `tests/*.sh` | yes |
| No leaks or UB | ASan/UBSan | yes |
| Resource limits reach the child | `test_limits.sh` | yes |
| pidfd identity safety | `test_pidfd.sh` | yes |
| Thermal guard decisions | `thermalGuard*.test.ts` | yes |
| Thermal guard is on the execution path | `thermalAdmission.test.ts` | yes |
| Pipeline stages get the configured limits | `test_limits.sh` | yes |
| Child signal dispositions are stated, not inherited | `test_pipeline.sh`, `test_signals.sh` | yes |
| One execution, every view, one answer | `scripts/cross-view-proof.sh` | needs a running gateway |
| Pipeline stage accounting | `test_pipeline.sh`, `pipeline.test.ts` | yes |
| argv fidelity | `argvBoundary.test.ts` | yes |
| Ownership attribution | `ownership.test.ts`, `processAttribution.test.ts` | yes |
| Telemetry vs raw Linux | `groundtruth.test.ts` | yes |
| Frontend behaviour | `vitest` | yes |
| Browser flows | `browser-smoke.sh` | needs Chromium |
| Screenshots | `capture-screenshots.mjs` | needs Chromium |
| **Clang** | CI | **no — environmental limitation** |
| **Real thermal hardware** | the host it runs on | **no — not present here** |
| **Bare-metal cpufreq** | bare metal | **no — WSL2 does not expose it** |

The last three are environment limitations, stated rather than worked around, and
none of them invalidates a release: the code reports all three as `UNAVAILABLE`
with a reason when the host cannot supply them.

---

## See also

- [`limitations.md`](limitations.md) — what the system does not do
- [`ground-truth-verification.md`](ground-truth-verification.md) — the recorded ground-truth pass
- [`cross-view-trace.md`](cross-view-trace.md) — one execution traced through every surface
- [`workload-lab.md`](workload-lab.md) — the controlled workloads
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — the authorship policy
