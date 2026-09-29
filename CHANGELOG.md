# Changelog

CAPS is not published to a registry, so these are project milestones rather
than semantic releases. The current version is **1.1.0** and has a single
canonical source: `PRODUCT_VERSION` in
`web/backend/src/config/env.ts`, projected into the C engine by
`scripts/generate-version.sh` and asserted against both `package.json` files by
`scripts/check-lockfiles.sh`.

---

## 1.1.0 — Release hardening and evidence integrity

The milestone in which the system's claims were checked against its code, and
the places where they did not match were fixed rather than documented away.

### Execution lifecycle, made unambiguous

* The C engine reports a machine-readable `outcome` on every terminal process
  event: `COMPLETED`, `EXITED`, `SIGNALED`, `EXEC_FAILED`, `LAUNCH_FAILED`,
  `WAIT_FAILED`.
* `EXEC_ERROR` now carries `exit_code` (126/127), `errno`, `errno_name`, and a
  stable `reason`. Previously the 126-vs-127 distinction and the errno were
  computed and then dropped at the JSON boundary, and the only surviving trace
  was unstructured stderr prose.
* `SESSION_SUMMARY` is no longer usable as a success claim. It is emitted after
  a failed `execvp()` exactly as after a successful run, and the gateway used to
  read its presence as `COMPLETED` — so a program that never ran was reported as
  a successful run. The summary now also carries `exec_errors`,
  `launch_errors`, and `observed_cleanly`.
* A permanent `waitpid()` failure emits a terminal `WAIT_FAILED` event instead
  of making the execution disappear from the stream.
* `execution.cancelled` was added so a cancelled execution is not reported as a
  failure. One terminal event type per terminal session status.
* The redirection parser rejects an operator in the file-name slot. Previously
  `echo hi > > out.txt` created a file literally named `>` and demoted
  `out.txt` to an argument.
* Blank and whitespace-only input no longer emits a dangling
  `COMMAND_RECEIVED`.

### Security boundary

* The gateway **refuses to start** on a non-loopback address unless
  `CAPS_BIND_MODE=remote` is set, and refuses remote mode without a bearer
  token of at least 32 characters. A `CAPS_AUTH_TOKEN` in local mode is
  rejected, because a token the service never checks looks like hardening.
* Every allowlisted command resolves once to a **verified absolute path**
  (`realpath` + `lstat` + `access(X_OK)`, symlinks refused) and that path is
  what gets `execvp`'d. `PATH` is no longer consulted for any allowlisted
  command, so a shadowing binary cannot be substituted.
* Redirection targets are re-verified at the moment of open with `O_NOFOLLOW`
  plus a regular-file `fstat`, closing the gap between the gateway's check and
  the engine's `open()`.
* Delayed `SIGKILL` is gated on the target's kernel start time. If the PID was
  recycled, the escalation is refused and the reason logged.
* The signal model is fail-closed: the parent refuses to start if `SIGINT`
  cannot be set to `SIG_IGN`, and the child refuses to `execvp()` if it cannot
  restore `SIG_DFL` — rather than handing a program a signal disposition CAPS
  never promised.
* The child environment is `PATH`/`LANG`/`HOME`/`TERM` only, and the bearer
  token is never logged.

### Event store

* Versioned, transactional, idempotent migrations with a `schema_version` table.
  A database from a newer build is refused rather than downgraded.
* A SQLite busy timeout, so an operator inspecting the file does not break the
  next request.
* Session creation, its redirection rows, and its first event are one
  transaction, as is finalization with its terminal event.
* A corrupt persisted payload is marked and surfaced instead of being silently
  replaced with `{}`.
* `validateEventStream()` states thirteen invariants and returns structured
  diagnostics. Replay, the exports, and the Markdown report all include the
  report.
* The unused `processes` table was removed. The event store is the only source
  of truth.
* Configurable retention (`CAPS_RETENTION_DAYS`, `0` = keep everything).
* Analytics aggregates in SQL over the same persisted rows, so per-request cost
  no longer grows with the whole history's snapshot count.

### Transport

* The SSE race is fixed: subscribe with a buffer **before** reading the store,
  then send the backlog, then flush. A client can no longer miss a persisted
  event because it connected at the wrong moment.
* `Number.MAX_SAFE_INTEGER` is no longer used as a synthetic event id. The
  end-of-stream frame carries no `id:` at all, so `Last-Event-ID` can only ever
  hold a real sequence.
* Frame names are unambiguous: `caps.event` for a canonical event, `stream.end`
  for the end of the stream.
* Output channels are separated once each: the monitor protocol no longer
  appears in the user's stderr, and diagnostics are no longer duplicated. Both
  channels are served live while the execution runs.

### Telemetry

* A CPU counter that decreases between samples is `UNAVAILABLE`, not `0`,
  matching the existing policy for I/O and fault counters.
* The capability response publishes a per-metric provenance classification
  (`observedMetrics` / `derivedMetrics` / `gatewayMetrics`), so a rate is no
  longer advertised as a procfs field.
* Stable kernel values (`CLK_TCK`, `btime`) are cached through an injectable
  cache rather than a module global, so tests do not depend on their order.

### Frontend

* One session-switch policy in the investigation store. Previously three
  actions adopted a new session id while keeping the previous session's cursor
  and process identity, so one execution's evidence could be shown inside
  another's timeline.
* The correlation index is keyed by `role:pid@start`, not by PID. A PID seen
  twice with two start times is two records and a reported collision, not one
  merged node with an overwritten start time.
* Signals are attributed per identity. A record-wide "any signal exists" flag
  marked every ended process `SIGNALED`.
* Process end times are resolved per PID, so a second exiting process in a
  multi-process record is no longer left rendered as running.
* The 2D and 3D views are keyed identically, which is what makes them agree by
  construction; a test asserts the agreement.
* The API client has a request timeout, `AbortController` support, and one
  error path that distinguishes a timeout from a cancellation.
* Liveness and readiness are separate. A gateway that is alive but cannot
  execute anything shows as *degraded*, not *online*.

### Repository

* `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, Dependabot, issue and PR
  templates.
* CI runs the full stack: GCC and Clang with `-Werror`, the C suite, both
  sanitizer suites, both workload suites, backend and frontend
  typecheck/build/tests, a real gateway integration run against the real engine,
  a browser smoke suite against the production build, CodeQL for C and
  TypeScript, dependency audit, and repository hygiene.
* `vite preview` had no API proxy, so the production build could not be
  exercised at all. The proxy is now configured for both dev and preview, and
  its target is readable from `.env`.
* The product version had four sources and had drifted (`0.1.0` in C, `1.0.0`
  everywhere else). There is now one.

---

## 1.0.0 — The observatory

* The C engine's monitor protocol, including exec-error reporting with the
  126/127 convention, redirection diagnostics, and the session summary.
* `fork`/`execvp`/`waitpid` execution with a fail-closed signal model.
* The Fastify gateway: structured argv, an allowlist, a workspace-confined
  redirection policy, concurrency and timeout limits, and an output cap.
* The canonical event store with per-session sequencing.
* Real procfs telemetry with a sampler, identity verification, and per-metric
  provenance.
* SSE delivery with reconnect by `Last-Event-ID`.
* Replay, analytics, comparison, and JSON/CSV/Markdown export.
* The React application: overview, execute, flight recorder, processes, live
  feed, history, compare, analytics, architecture, signals, redirection,
  playground, settings.
* The bounded workload laboratory, and the two-bound enforcement (gateway and C)
  that keeps a bug in either layer from running an unbounded workload.
* The 3D Process Space and the cross-view evidence correlation layer.

## 0.1.0 — The engine

* The argument-passing engine: whitespace tokenization, `argv` construction,
  `fork`/`execvp`/`waitpid`, and the interactive REPL with `help`, `cd`, and
  `exit` built-ins.
* Output redirection: `>`, `>>`, `<` via `open`/`dup2`/`close` with correct
  descriptor ownership.
* The signal model, and the tests that pin down its limits honestly.
