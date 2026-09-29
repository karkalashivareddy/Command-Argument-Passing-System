# Final repository audit

Scope: the whole `Command-Argument-Passing-System` repository at the close of
the release-hardening milestone, with the documentation-forensics pass layered
on top.

This is a summary of *what was found and what changed*. The reproducible
verification run is in
[FINAL_RELEASE_VERIFICATION.md](FINAL_RELEASE_VERIFICATION.md); the Git
authorship cleanup is in
[GIT_ATTRIBUTION_CLEANUP.md](GIT_ATTRIBUTION_CLEANUP.md).

---

## 1. What was wrong, and what fixed it

### Critical

| Finding | Fix |
| --- | --- |
| `CAPS_HOST=0.0.0.0` started silently and exposed unauthenticated process execution. The only network control was gated on `config.host === "127.0.0.1"`, so any other bind value disabled it. | The gateway refuses to start on a non-loopback address unless `CAPS_BIND_MODE=remote`; remote mode requires a bearer token; a token in local mode is rejected. `web/backend/src/config/env.ts`, `server.ts` |
| The allowlist resolved a *name*, and `execvp()` resolved it against `PATH` at exec time. The gateway's `access(X_OK)` probe proved nothing about what ran. | Every allowlisted command resolves once to a verified absolute path (`realpath` + `lstat` + `access(X_OK)`, symlinks refused) and that path is what gets `execvp`'d. `security/policy.ts` |
| An `execvp()` failure was recorded as `COMPLETED`. CAPS emits `SESSION_SUMMARY` even when exec failed, and the runner read the summary's presence as success. | The engine reports a machine-readable `outcome`; the gateway derives the session status from it. A session summary is no longer a success claim. `execution/runner.ts`, `src/process.c` |
| `EXEC_ERROR` dropped its failure status. 126/127 and the errno were computed in C and never emitted. | `exit_code`, `errno`, `errno_name`, `reason`, and `outcome` are emitted and carried end to end. `src/monitor.c`, `execution/normalizer.ts` |
| The SSE route read the store, computed the last sequence, and *then* subscribed. An event published in that window was silently lost. | Subscribe with a buffer, read, send, flush. `events/bus.ts`, `api/routes.ts` |
| The delayed `SIGKILL` trusted a bare PID captured 2 s earlier. A recycled PID meant killing an unrelated process. | Identity (`pid` + `/proc/<pid>/stat` start ticks) is captured at the first signal and re-verified before every escalation. `execution/terminator.ts` |
| The investigation store adopted a new session id while keeping the previous session's cursor, pinned flag, and process identity. | One session-switch policy. Selecting actions adopt and clear; clearing actions are scoped. `store/investigation.ts` |
| `Number.MAX_SAFE_INTEGER` was written as a canonical SSE event id. A reconnecting client resumed from a position that does not exist. | The end frame carries no `id:`. `events/sse.ts` |
| Output channels: the whole stderr chunk was appended to the user's stderr *and* each diagnostic was appended again. | Each line is classified once and routed once. `execution/output.ts`, `execution/runner.ts` |
| A CPU counter that decreased was clamped to `0 %`. | `UNAVAILABLE`, matching the existing policy for I/O and fault counters. `telemetry/derive.ts` |

### High

| Finding | Fix |
| --- | --- |
| A permanent `waitpid()` failure made the execution vanish: no terminal event, no persisted failure. | A terminal `WAIT_FAILED` event carrying the real errno. `src/process.c` |
| The redirection parser accepted an operator in the file-name slot. `echo hi > > out.txt` created a file named `>`. | Rejected in the validation pass, before any mutation. `src/parser.c` |
| Startup recovery finalized stale sessions in SQLite only, so replay showed an unfinished stream for a row that said `FAILED`. | Recovery goes through the runner and persists a canonical terminal event. `server.ts`, `execution/runner.ts` |
| One backend test hard-coded a POSIX absolute path and failed on any non-Linux machine. | Platform-aware assertion. `workloadCatalog.test.ts` |
| The `processes` table was created and deleted from but never written to — a second, unused source of truth. | Removed in migration 2. `db/database.ts` |
| Malformed persisted JSON silently became `{}`. | Marked `payload_corrupt` on the row and surfaced in the API. `db/repositories/events.ts` |
| The correlation index was keyed by `role:pid`, so a PID seen with two start times merged into one node and the second start time overwrote the first. | Keyed by `role:pid@start`, with the pid as a lookup accelerator and collisions reported. `lib/evidenceCorrelation.ts` |
| A record-wide "any signal exists" flag marked every ended process `SIGNALED`. | Signals are attributed per identity. `lib/evidenceCorrelation.ts`, `lib/processSpace.ts` |

### Also fixed, found while writing tests

* The buffered bus never switched to live delivery after `flush()` — every
  post-flush event was buffered forever. Caught by a test written for the
  original bug.
* Only the *first* `process.exited` in a stream was ever applied to a node, so
  a second exiting process stayed rendered as `RUNNING` for the rest of the
  session.
* The 2D timeline and the 3D scene used different node keys, so selecting a
  process in one view could not resolve it in the other.
* `vite preview` had no API proxy, so the production build could not be
  exercised at all — which also made a browser smoke suite impossible.
* `include/version.h` did not exist and the C version was a literal that had
  drifted from both npm packages.

## 2. What was verified

| Area | Result |
| --- | --- |
| GCC and Clang, `-Werror` | PASS |
| C unit + integration suite | PASS |
| C under ASan + UBSan, leak detection on | PASS |
| Controlled workload suite | PASS |
| Workloads under sanitizers | PASS |
| Backend typecheck + build | PASS |
| Backend tests (185) | PASS |
| Frontend typecheck + production build | PASS |
| Frontend tests (139) | PASS |
| Real gateway integration against the real engine | PASS |
| Replay integrity (13 invariants) | PASS |
| Cross-view correlation (2D ≡ 3D) | PASS |
| Browser smoke against the production build | PASS |
| Repository hygiene, attribution, lockfile/version consistency | PASS |

Exact counts and commands: [FINAL_RELEASE_VERIFICATION.md](FINAL_RELEASE_VERIFICATION.md).

## 3. Known limitations

These are deliberate scope boundaries, not defects left undiscovered.

* One observed process per execution. The sampler follows the single PID CAPS
  reported; descendants are not discovered, so `caps_fork_tree` demonstrates
  fork *activity*, not a process tree.
* No eBPF, no syscall tracing, no cgroup accounting, no kernel tracepoints, no
  GPU or network telemetry.
* Single-node, single-user. No multi-tenant model, no RBAC, no distributed
  ingestion.
* Loopback security boundary by default; remote mode is an explicit opt-in with
  a bearer token and no additional hardening.
* Output channels share a descriptor and are separated line-wise.
* 3D requires WebGL, with functional 2D and table fallbacks.
* **No visual-regression (pixel-diff) suite.** None exists in this repository
  and none was invented. The browser suite is behavioural.
* WSL2 is verified; bare Windows is not, for the engine and the gateway
  integration suite.

## 4. Documentation state

| Class | Documents |
| --- | --- |
| **Canonical** | `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/architecture.md`, `docs/observability-model.md`, `docs/web-architecture.md`, `docs/web-api.md` |
| **Current and scoped** | `docs/telemetry.md`, `docs/monitor.md`, `docs/process-lifecycle.md`, `docs/signals.md`, `docs/redirection.md`, `docs/process-microscope.md`, `docs/three-dimensional-observatory.md`, `docs/realtime-visualization.md`, `docs/workload-lab.md`, `docs/runtime-verification.md`, `docs/design-system.md` |
| **Historical, retained with a banner** | `docs/DEPLOYMENT.md`, `docs/development-phases.md`, `docs/faculty-demo.md`, `docs/future-roadmap.md` |
| **Audit records** | `docs/audit/GIT_ATTRIBUTION_CLEANUP.md`, this file, `FINAL_RELEASE_VERIFICATION.md` |

Material corrections made during the documentation pass:

| Was | Now | Why |
| --- | --- | --- |
| `web-architecture.md` named a `better-sqlite3` connection, a `config/paths.ts`, and nine `api/*.ts` route files. | The actual layout: `node:sqlite`, no paths module, one `api/routes.ts`. | None of the named files existed. |
| `web-architecture.md` and `README.md` named a source file that no longer exists. | `src/process.c`. | The file was renamed long ago. |
| The version was `0.1.0` in one document and `1.0.0` in others. | `1.1.0`, from one generated source. | Verified by CI. |
| SSE frames were `execution.received` / `execution.ended`. | `caps.event` / `stream.end`. | The old names conflated a completed *event* with a completed *stream*. |
| `/api/health` was documented as reporting engine and database availability. | Liveness only; `/api/ready` reports readiness. | The old endpoint returned a literal `database: { available: true }`. |
| `workload-lab.md` said a `fork()` "gives a new PID, so descendants become visible to the collector". | The collector sees one PID; descendants are not observed. | The gateway does not discover descendants. |
| `observability-model.md` said the gateway "does not collect them yet" about `/proc/<pid>/stat`. | It reads them, and the document now lists every field with its provenance. | Stale since the collector was written. |
| `three-dimensional-observatory.md` mentioned a process chain without stating the single-PID limit. | States the limit explicitly. | Same reason. |
| `observability-model.md` claimed `CAPS does not collect them yet` about `/proc` fields. | Rewritten with a per-field provenance table. | — |
| The C engine's `CAPS_VERSION` was a literal in `main.c`. | Generated from `PRODUCT_VERSION`. | The literal had drifted to `0.1.0`. |

## 5. Screenshot provenance

`docs/screenshots/*.png` are real captures of the running application, taken by
`web/frontend/scripts/capture-screenshots.mjs` against a live gateway and the
real C engine. They are not redrawn, not composited, and no telemetry was
edited. The recorded command label visible in the flight-recorder capture is
the absolute resolved path of the executed binary, which is itself evidence
that the executable-resolution boundary is in force.

There is **no** visual-diff baseline in this repository, and none is claimed.
