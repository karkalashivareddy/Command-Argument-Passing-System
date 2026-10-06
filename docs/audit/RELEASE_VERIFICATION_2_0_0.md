# CAPS 2.0 — final release verification

This is the authoritative verification record for **CAPS 2.0**. Every number
below comes from an actual execution on the machine described, with the exact
command shown. Nothing here is a plan, a projection, or a carry-over from an
earlier milestone.

It supersedes two earlier documents, which remain in place as historical
evidence and are labelled as such:

- [FINAL_RELEASE_VERIFICATION.md](FINAL_RELEASE_VERIFICATION.md) — the 1.1.0 milestone
- [FINAL_REPOSITORY_AUDIT.md](FINAL_REPOSITORY_AUDIT.md) — the 1.1.0 repository audit

> **Re-verified 2026-10-06 against the current tree.** Every measurement in this
> document was reproduced after the Vitest 3.x → 5.0.3 upgrade described in
> [SECURITY.md](../../SECURITY.md). The counts held: 450 backend tests in 27
> files, 247 frontend tests in 13 files, 260 C assertions across 16 suites, and
> the same repository-gate results. Two facts were added at that point, because
> the upgrade changed what a reader needs to know:
>
> * The C engine's event stream is guarded by **fourteen** invariants, not
>   thirteen. `I14-pipeline-stages-accounted` exists in
>   `web/backend/src/events/invariants.ts` and is asserted by
>   `web/backend/tests/api/pipeline.test.ts`; the 1.1.0-era documents count
>   only the first thirteen.
> * Vitest 5 builds on **Rolldown**, so a platform-mismatched install, or a test
>   run on a high-latency network filesystem, can fail in ways that read as a
>   broken suite but are install and I/O artifacts. See
>   [SECURITY.md](../../SECURITY.md#the-vitest-upgrade-changed-the-test-runners-engine-not-just-its-version).

The 1.1.0 figures quoted inside
[FINAL_RELEASE_VERIFICATION.md](FINAL_RELEASE_VERIFICATION.md) and
[FINAL_REPOSITORY_AUDIT.md](FINAL_REPOSITORY_AUDIT.md) describe that milestone
and are intentionally left unedited.

---

## 1. Environment

| | |
| --- | --- |
| Product version | **2.0.0** (single source: `PRODUCT_VERSION` in `web/backend/src/config/env.ts`, projected into `include/version.h`) |
| Kernel | WSL2, `6.18.33.2-microsoft-standard-WSL2` |
| C compiler | gcc (Ubuntu) — locally verified |
| C compiler | clang — **not installed locally**; CI is authoritative |
| Node | v22.14.0 |
| Database | SQLite via Node's built-in `node:sqlite` |
| Frontend | Vite production bundle |
| Date of this run | 2026-10-04 |

Two environmental limitations are stated rather than worked around:

- **No local clang.** The Clang leg of the CI matrix is the authority for
  Clang. It is not reported as PASS here.
- **No thermal sensor and no cpufreq policy on this host.** `/sys/class/thermal`
  and `/sys/class/hwmon` expose no temperature input. That is the expected
  result under WSL2 and inside most VMs, and CAPS reports it as
  `UNAVAILABLE` with the reason rather than inventing a reading.

---

## 2. Release blockers found in the live audit, and what fixed them

These were real defects in the published `main` at the start of this pass. Each
is listed with the evidence that it was real and the change that closed it.

| # | Defect | Evidence it was real | Fix |
| --- | --- | --- | --- |
| 1 | The gateway CI job built the C engine from `web/backend`, where no Makefile exists. | Job `gateway typecheck, build, tests` failed at `make` while every later step in the same job passed. | Explicit `working-directory: .` on the build step. The one root Makefile stays the only build definition. |
| 2 | A pipeline producer killed by a closed pipe took `EPIPE` and exited non-zero instead of dying by `SIGPIPE`. | `FAIL: no SIGNAL_RECEIVED for a producer killed by SIGPIPE, over 5 attempts` in both the gcc and clang CI jobs. Reproduced locally: with `SIGPIPE` ignored in the invoking shell, `yes` printed `standard output: Broken pipe`, exited 1, and produced **no** `SIGNAL_RECEIVED` — every attempt, forever. The five-attempt loop could never have passed. | `signals_child_reset()` now establishes **both** dispositions explicitly before `execvp()`: `SIGINT` → `SIG_DFL` and `SIGPIPE` → `SIG_DFL`. `SIG_IGN` survives `execvp()`, and the engine's pipeline signal model was inheriting it from whatever launched it. |
| 3 | The SIGPIPE test asserted the property over five attempts and depended on coreutils. | GNU `yes`, uutils `yes` and BusyBox `yes` do not agree on what to do with `EPIPE`. | New first-party `tests/helpers/sigpipe_writer.c`: writes newline-terminated lines through `write(2)`, installs **no** signal handler, is bounded, and is provably blocked in `write(2)` before the consumer exits. The test is now single-attempt and asserts `SIGNAL_RECEIVED`, `signal = 13`, `outcome = SIGNALED`, exit 141, prompt termination, and the unchanged behaviour under an inherited `SIG_IGN`. |
| 4 | Resource limits were applied only on the single-command path. | `stage_apply_and_exec()` in `src/process.c` never called `caps_limits_apply()`. A configured `RLIMIT_AS` protected `caps <burner>` and silently did **nothing** for `caps <burner> \| cat`. | Every pipeline stage now applies the limits in the child, immediately before `execvp()`, on the same terms as a single command, and refuses the stage on the status pipe if a limit cannot be applied. |
| 5 | The thermal guard module existed but nothing on the execution path called it. | `evaluateThermalGuard` was referenced only by tests; `CAPS_THERMAL_GUARD_ENABLED=true` read no sensor and refused nothing, while the API published the configuration as though it were in force. | Wired into `ExecutionRunner.start()` **before** anything is persisted or spawned. `WARN` admits and records; `TERM` / `TERM_THEN_KILL` refuse with `503 THERMAL_REFUSED` and a persisted, replayable, SSE-visible decision record carrying the sensor path, the raw millidegree value, and the threshold. A host with no sensor yields `UNAVAILABLE_ALLOW` — the workload runs and the record says the admission carries **no** thermal justification. |
| 6 | Process Detail reported `capsOwned: false` for a process the Process Explorer reported as `capsOwned: true`. | The detail route re-reads procfs per request and skipped `annotateRelationships`, so ownership was never settled on that row. | The detail route now annotates against `SystemService.ownedIdentityKeys()` — the same set the list route uses — and against the same sampled-PID context. |
| 7 | Only the **last** stage of a pipeline was reported as CAPS-owned. | `ActiveSession` held one `childPid`/`childIdentity`, and each stage's `process.started` overwrote it. | `ActiveSession.ownedIdentities[]` is append-only and records a verified identity per stage; `ownedIdentityKeys()` unions them. `childPid`/`childIdentity` remain the singular termination handle. |
| 8 | A process that exited between `/proc/<pid>/stat` and `/proc/<pid>/status` was reported as `PERMISSION_DENIED`. | `rowState: statusRead.ok ? "LIVE" : "PERMISSION_DENIED"`. Routine churn on a busy host was published as a host configuration fault. | Classified from the read failure that actually occurred: `missing` → `EXITED`, `permission` → `PERMISSION_DENIED`, everything else → `UNAVAILABLE`. `DISAPPEARED` still means the kernel's own PID cross-check disagreed. |
| 9 | Malformed stat fields became fabricated measurements. | `parseStatLine()` ended with `minflt ?? 0`, `majflt ?? 0`, `threads ?? 1`. "0 minor faults" and "1 thread" are claims, and neither was measured. | Those three fields are `number \| null`. `null` becomes `provenance: "UNAVAILABLE"` with an explicit reason. A kernel-reported **zero** is still preserved. `processSummaryFrom` counts an unknown thread count as unknown instead of as one thread. |
| 10 | The analytics response omitted `minorFaultSamples`. | The repository computed it; `computeAnalytics` never copied it across, so a real average shipped beside a denominator of `0`. The UI rendered "minor from 0 sample(s)". | Assigned from the same SQL aggregation, and declared in the backend contract. |
| 11 | The comparison view rendered `NaN MiB` for block read/write. | `ComparisonSide` carried `totalRcharBytes`/`totalWcharBytes` but not `totalReadBytes`/`totalWriteBytes`, while the UI declared and rendered the latter. `fmtBytes(undefined)` passes its `null` guard. | `totalReadBytes`/`totalWriteBytes` and their deltas are now part of the comparison side, computed from the same persisted snapshots. |
| 12 | `pssSupported` was typed `boolean`; the gateway sends a full metric. | `pssSupported === false` could never be true, so the "PSS was not observed" notice was unreachable while type-checking cleanly. | Typed as `SystemMetric<boolean> \| null`; the page reads `.value` and keeps "not probed yet" distinct from "supported". |
| 13 | The host SSE stream advertised an end frame it never emitted. | `SYSTEM_SSE_END_FRAME` was published in the capability document with no write site anywhere. | Emitted on close, with no `id:` — a terminal marker is not a resume position. |
| 14 | `system.processes` was emitted with `sequence: 0`, so its SSE `id:` was always `id: 0`. | A reconnecting client echoed `Last-Event-ID: 0` and rewound its resume position to the start of history. | The event takes a real sequence from the same global counter, after persistence has been attempted. |
| 15 | Three dashboards rendered a failed request as a real measurement. | `HistoryPage` and `OverviewPage` mapped a rejected request to `{ sessions: [], total: 0 }`; `LivePage` mapped it to `[] ?? []`. An unreachable gateway produced "0 sessions", "No executions recorded yet" and "0 running". | Each failure is now recorded and rendered as **unavailable**, with the gateway's message. |
| 16 | Three documents stated that stderr redirection was not supported. | `README.md`, `docs/architecture.md` and `docs/runtime-verification.md` all said so, while the engine implements `2>` and `2>>`, the gateway publishes both in its grammar, and `tests/test_redirection.sh` and `stderrRedirection.test.ts` cover them. | Corrected, with the actual behaviour and the evidence stated. |
| 17 | The integration CI job duplicated the entire backend suite. | After fix 1, the `backend` and `integration` jobs ran the identical pipeline. | `integration` is now scoped to the cross-layer suites under `web/backend/tests/api`, the cross-layer files. The unit suites are the `backend` job's job. |
| 18 | GitHub Actions were pinned to superseded majors. | `checkout@v4`, `setup-node@v4`, `codeql-action@v3`; current majors are v7, v7 and v4. | Updated to the supported majors. Dependabot's `actions` group still tracks them. |

---

## 3. C engine

```sh
make clean
make CC=gcc CFLAGS="-std=c11 -Wall -Wextra -Wpedantic -Werror -g"   # strict, -Werror
make test CC=gcc
make test-asan CC=gcc
make test-workloads CC=gcc
make test-workloads-asan CC=gcc
```

| Suite | Assertions | Result |
| --- | --- | --- |
| `tests/test_smoke.sh` | 17 | PASS |
| `tests/test_parser.sh` | 1 | PASS |
| `tests/test_execution.sh` | 11 | PASS |
| `tests/test_errors.sh` | 8 | PASS |
| `tests/test_exit_status.sh` | 7 | PASS |
| `tests/test_signals.sh` | 5 | PASS |
| `tests/test_redirection.sh` | 13 | PASS |
| `tests/test_exit_parse.sh` | 14 | PASS |
| `tests/test_fd_edge.sh` | 8 | PASS |
| `tests/test_monitor.sh` | 13 | PASS |
| `tests/test_lifecycle.sh` | 47 | PASS |
| `tests/test_waitpolicy.sh` | 4 | PASS |
| `tests/test_wait_failure.sh` | 5 | PASS |
| `tests/test_pipeline.sh` | 57 | PASS |
| `tests/test_pidfd.sh` | 21 | PASS |
| `tests/test_limits.sh` | 29 | PASS |
| **Total** | **260 across 16 suites** | **PASS** |

The identical 16 suites and 260 assertions pass under
`-fsanitize=address,undefined` with `detect_leaks=1`.

`make test-workloads` and `make test-workloads-asan` both PASS: the five
first-party laboratory workloads run, and run again instrumented.

### Deterministic pipeline SIGPIPE evidence

`tests/test_pipeline.sh`, first-party producer, single attempt:

```
PASS  '<repo>/build/sigpipe_writer | head -1' terminated in 0s instead of spinning
PASS  the producer is recorded as terminated by a signal
PASS  the recorded signal is 13 (SIGPIPE)
PASS  the producer's outcome is SIGNALED, not a non-zero exit
PASS  stage 0 exits 141 (128+13) with outcome SIGNALED, which is not an EPIPE exit
PASS  the consumer still completed normally (stage 1 exit 0)
PASS  the pipeline delivered one line and reported success
PASS  SIGPIPE is still delivered when the invoking shell ignores it
PASS  an inherited SIG_IGN for SIGINT changes nothing: the pipeline completes and SIGPIPE still fires
```

### Per-stage resource limits, from the kernel

`tests/test_limits.sh`, `sleep 300 | cat` with `CAPS_LIMIT_ADDRESS_SPACE_BYTES=536870912`
and `CAPS_LIMIT_CPU_SECONDS=9`, read from each stage's own `/proc/<pid>/limits`:

```
PASS  stage 0 (pid 484): RLIMIT_AS is the configured 512 MiB
PASS  stage 0 (pid 484): RLIMIT_CPU is the configured 9 seconds
PASS  stage 0 (pid 484): RLIMIT_CORE is 0, so the stage cannot dump core
PASS  stage 1 (pid 485): RLIMIT_AS is the configured 512 MiB
PASS  stage 1 (pid 485): RLIMIT_CPU is the configured 9 seconds
PASS  stage 1 (pid 485): RLIMIT_CORE is 0, so the stage cannot dump core
PASS  stage 0 failed under the 64 MiB cap (exit_code=3, outcome=EXITED)
PASS  the pipeline still reports its last stage's status (0), which is shell convention
PASS  the failure is attributed to stage 0, the stage whose limit bound
PASS  the consumer stage completed, so the failure was the producer's limit
PASS  the same pipeline succeeds when the allocation fits, so the failure above was the limit
PASS  a malformed address-space limit refuses a pipeline as well
PASS  no refused pipeline stage produced output, so none of them ran
PASS  the pipeline-stage refusal is recorded as EXEC_ERROR in the event stream
TOTAL: 29 passed, 0 failed
```

`RLIMIT_AS` is reported as **virtual address space** everywhere. It is never
described as a memory limit: it bounds mappings that need never be touched, and
a generous value says nothing about resident memory.

---

## 4. Gateway (backend)

```sh
cd web/backend
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node node_modules/typescript/bin/tsc -p tsconfig.build.json   # build
node node_modules/vitest/vitest.mjs run                # tests
```

| | Result |
| --- | --- |
| Typecheck | PASS, no diagnostics |
| Build | PASS |
| Tests | **PASS — 450 tests, 27 files** |

Suites added or extended in this pass:

| Suite | What it now proves |
| --- | --- |
| `web/backend/tests/api/ownership.test.ts` | A CAPS-owned process stays CAPS-owned through Process Detail: same `identity.key`, same `startTicks`, same `rowState`, same `relationshipConfidence`, `capsOwned: true` in both views, and no unsettled placeholder. |
| `web/backend/tests/unit/thermalAdmission.test.ts` | The execution path **consults** the guard: a `REFUSE_*` decision spawns nothing, returns 503, and is recorded with the sensor path, raw millidegree value and threshold; `ALLOW` spawns and completes; `UNAVAILABLE_ALLOW` carries `celsius: null` and `readingProvenance: "UNAVAILABLE"`, never a temperature. |
| `web/backend/tests/unit/failureInjection.test.ts` | An unreadable `minflt`/`majflt`/`num_threads` is `null` + `UNAVAILABLE`, while a kernel-reported `0` is preserved; `status` missing → `EXITED`; unreadable `status` → `UNAVAILABLE`; absent `stat` → `EXITED`; unparseable `stat` → `UNAVAILABLE`; PID mismatch → `DISAPPEARED`. |

---

## 5. Frontend

```sh
cd web/frontend
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
node node_modules/vitest/vitest.mjs run
```

| | Result |
| --- | --- |
| Typecheck | PASS, no diagnostics |
| Production build | PASS |
| Tests | **PASS — 247 tests, 13 files** |

---

## 6. Repository gates

```sh
make test-scripts
sh scripts/check-repository-hygiene.sh
sh scripts/check-trailing-newline.sh
sh scripts/check-lockfiles.sh
sh scripts/check-version.test.sh
sh scripts/check-attribution.sh HEAD
```

| Gate | Result |
| --- | --- |
| Version consistency (one source, four projections) | PASS |
| Version gate's own self-test on broken fixtures | PASS — 14 passed, 0 failed |
| Repository hygiene (no artifacts, databases, local paths) | PASS |
| Trailing newline on every tracked text file | PASS |
| Lockfiles consistent with their manifests | PASS |
| Documentation links | PASS |
| Attribution gate and its own tests | PASS — 14 passed, 0 failed |

---

## 7. Cross-view proof

One real two-stage pipeline, followed through every view CAPS has.
`scripts/cross-view-proof.sh`, 17 assertions, all PASS:

```
PASS  gateway is ready and the real C engine is available
PASS  capabilities report version 2.0.0
PASS  the terminal accepted a two-stage command line (exec_…, 2 stages)
PASS  the engine's pipeline evidence survived normalization: two stages in one process group
PASS  each pipeline stage carries its own distinct pid
PASS  the stage-0 program is pid 1069
PASS  SSE delivers the same evidence on the caps.event frame
PASS  the live SSE stream carries the same stage-0 pid as the persisted stream
PASS  the host inventory publishes a full identity for the executed program
      (1069@162254#20ee22ad-4054-482b-9f39-10c4327b20dc)
PASS  the Process Explorer row is LIVE, CAPS-owned, with a settled parent link
PASS  Process Detail agrees with the inventory on identity, ownership, and provenance
PASS  the execution completed through the real engine
PASS  every stage's exit is attributable to its own start, and the stream passes its invariant check
PASS  persistence agrees with the event stream on session, status and exit code,
      and the row's pid is one of its stages
PASS  replay is idempotent: a second read returns an identical document
PASS  analytics reports every average with a real sample count
PASS  the capabilities document names address space correctly, states what is
      enforced, and reports its identity confidence

CROSS-VIEW PROOF PASSED
```

The specific contradiction that motivated this pass —
`Explorer: capsOwned=true` vs `Process Detail: capsOwned=false` — is closed, and
`scripts/cross-view-proof.sh` fails the build if it ever reappears.

The full narrative trace is in [../cross-view-trace.md](../cross-view-trace.md).

---

## 8. What is NOT verified locally, and why

| Item | Status | Reason |
| --- | --- | --- |
| Clang build, tests and sanitizers | **NOT RUN locally** | No clang in this environment and no sudo. CI's `C engine (clang)` matrix leg is the authority. It is reported as `NOT RUN` here rather than as PASS. |
| Thermal guard against a **real** sensor | **NOT RUN locally** | This host exposes no temperature sensor. The guard's decision table is fully covered against fixture sysfs trees, and its integration into the execution path is covered by substituting the *decision*. What is untested here is a genuine hot machine, and no local amount of testing can produce one. |
| cpufreq policy frequency | **NOT RUN locally** | WSL2 exposes no cpufreq policy. Reported `UNAVAILABLE` with the reason. |
| Measured hardware CPU frequency | **NOT IMPLEMENTED, by design** | Requires MSR or fixed-performance-counter access. CAPS installs neither and publishes `measuredHardwareKhz` as `UNAVAILABLE`. |
| Per-process network traffic | **NOT IMPLEMENTED, by design** | Linux exposes no per-process byte counters in procfs. Published as `UNAVAILABLE`; host interface counters are host-wide and never attributed to a process. |

These are environmental or architectural limits, not defects, and none of them
is presented anywhere in the product as working.

---

## 9. Continuous integration

`.github/workflows/ci.yml`, one job per claim:

| Job | What it executes |
| --- | --- |
| `commit attribution` | The attribution gate over the full history, plus the gate's own tests on synthetic fixtures |
| `repository gates` | `make test-scripts`, hygiene, trailing-newline, lockfile, and the version gate's self-test |
| `C engine (gcc)` / `C engine (clang)` | Strict `-Werror` build, clean build, 260 assertions, ASan+UBSan, workloads, workload sanitizers |
| `gateway typecheck, build, tests` | Engine, workloads and test helpers built **from the repository root**, then typecheck, build, 450 tests |
| `real gateway integration` | The real engine, workloads and helpers, then only the cross-layer API suites |
| `frontend typecheck, build, tests` | Typecheck, production build, 247 tests |
| `browser smoke (production build)` | The production bundle against a live gateway and the real engine |
| `CodeQL (javascript-typescript)` / `CodeQL (c-cpp)` | Buildless analysis, both languages |
| `dependency audit` | `npm audit --audit-level=high` for both packages |
| `repository hygiene (history scope)` | Full-history hygiene and attribution |

There is **no visual-regression job**, because there is no visual-diff
infrastructure in this repository and none is claimed.

---

## 10. Repository state

```sh
git status --porcelain   # empty after the release commit
git branch -a            # main (local) + origin/HEAD -> origin/main + origin/main
git tag -l               # empty: no tag is created by this release
git ls-files | wc -l     # tracked files, source and documentation only
```

No database, build output, `.env`, credential, or user-owned presentation or
output artifact is tracked.

The presentation file
`Command_Argument_Passing_System_End_Semester_Presentation.pptx` is present in
the working tree but **not tracked**: `.gitignore` excludes `*.pptx`, because a
presentation is a local submission artifact rather than a source or a build
product. `output.txt`, `output.txtx`, and `shape.cjs` are likewise ignored local
scratch files, and `git status` is expected to be clean without them.

---

## 11. Status classification

| Area | Status |
| --- | --- |
| C engine — gcc, strict, 260 assertions | **PASS** |
| C engine — ASan + UBSan, same suites | **PASS** |
| Controlled workloads, plain and sanitized | **PASS** |
| Gateway typecheck, build, 450 tests | **PASS** |
| Frontend typecheck, production build, 247 tests | **PASS** |
| Cross-view proof, 17 assertions | **PASS** |
| Repository gates, hygiene, attribution, docs links | **PASS** |
| C engine — clang | **NOT RUN locally**; CI is authoritative |
| Thermal guard against a real sensor | **NOT RUN locally**; no sensor exists here |
| Everything else claimed by the product | **PASS**, or explicitly `UNAVAILABLE` in the product itself |
