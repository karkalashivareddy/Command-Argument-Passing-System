## 2.0.0 - Process identity, host observability, and the CAPS terminal

### Process identity

- pidfd-based process addressing through a new `build/caps_pidfd` helper, because
  Node exposes no pidfd API. The target is bound with `pidfd_open`, its start
  ticks are verified, and only then is it signalled.
- A pidfd cannot be re-pointed by the kernel, so a recycled PID cannot be
  signalled. Where pidfd is unavailable the start-ticks check still runs, and the
  recorded `mechanism` says which one carried the signal.
- Identity confidence is classified `VERIFIED`, `UNVERIFIED`, or `UNAVAILABLE`,
  and published at `/api/capabilities` with the kernel it was measured on.

### Thermal guard

- An admission check that runs before a CAPS-owned workload starts, with
  `WARN`, `TERM`, and `TERM_THEN_KILL` actions.
- Discovery is authoritative. With no sensor the guard reports UNAVAILABLE with
  the reason and admits the workload explicitly carrying no thermal
  justification, rather than reading an absent sensor as a cool machine.
- It never writes to sysfs or hwmon, never touches an MSR, and never signals a
  process it did not spawn.

### Guardrails

- `RLIMIT_AS`, `RLIMIT_CPU`, `RLIMIT_FSIZE` and `RLIMIT_CORE` applied in the
  child immediately before `execvp`, so the limits are provably in force for the
  whole life of the executed program.
- Address space is reported as address space, never as physical memory.

### The CAPS terminal

- A catalog-backed terminal whose validation calls the C engine's own lexer. The
  gateway never parses a command line, so two lexers cannot disagree about one
  quoting case.
- POSIX short-option composition, numeric short forms, and per-command value
  flags, so the forms people actually type are the forms that work.
- Every published catalog example is verified against the validator, which
  found and fixed several examples the catalog itself refused.

### Pipeline and stage evidence

- Per-stage `argv` emitted as separate JSON elements, bounded with the
  truncation declared rather than silent.
- Structural invariants I11 and I14 over `(pid, stage)` keys, and a shared
  reducer so the live and replay views cannot disagree.

### Defects found by running the system

Every item below was found by executing CAPS 2.0 and reading what came back, not
by reading the code. Each had a passing test suite behind it.

- **CAPS-owned processes were never identified as CAPS-owned.** The registry
  declared a per-session `childIdentity` and read it when deciding ownership, but
  nothing ever assigned it, so every identity key was `pid@?#bootId`, matched no
  live row, and the ownership distinction the Process Explorer exists to draw was
  permanently `false`. Identity is now captured at `process.started` — the safest
  instant, because the child was just forked and an unreaped child keeps its PID
  reserved — and `SystemService` passes the ownership set to the discovery that
  actually serves `/api/system/processes`.
- **`processIdentity` was never published.** `/api/capabilities` ran the real
  pidfd probe and discarded it, so the System Control Center read `undefined` and
  crashed. The probe's verdict is now published, with the kernel it was measured
  on.
- **Per-stage `argv` never reached the browser.** The engine emitted it and the
  normalizer dropped it, so the pipeline evidence card showed "not recorded" for
  stages that had demonstrably started. `argv`, its truncation metadata, and the
  stage's `stdin`/`stdout` wiring now survive the boundary.
- **Pipe wiring was read from the wrong event.** `writesToPipe` was taken from
  `process.started`; the engine publishes it on `command.parsed`. Every stage's
  output was labelled as collected by the gateway.
- **Two product pages crashed on first paint.** The frontend's `HostProcessRow`
  type described fields the gateway has never sent. The type is now a
  transcription of the wire shape, and a test asserts the two agree field for
  field.
- **The screenshot tool could not run and wrote to the wrong tree.** Playwright
  was imported but not installed, and the repository root resolved to `web/`, so
  a successful capture produced nineteen correct and completely undiscoverable
  images.
- **The version gate could not fail correctly.** Four independent defects made it
  report a clean tree as broken and a broken tree as clean, including a README
  check that read only the first marker. It is now exercised against deliberately
  drifted fixtures, and a mutation that fails to apply is itself reported as a
  failure.
- **`git diff --check` failed.** Eight files had picked up CRLF, which git reads
  as trailing whitespace. They are normalised back to the line endings they had
  before.
- **The catalog described a different program than the one it names.**
  `status_probe`'s schema said "one positional, an integer 0..255", while the
  helper takes `exit N | signal S | print A B ...`. It refused the documented
  form with `"exit" is not a plain non-negative integer`, it accepted a bare
  `status_probe 7` that the helper answers with its unknown-mode status 3, and it
  made the playground's own example return 422. Three API integration tests were
  failing on it. `ArgumentSchema` gained `leadingChoices` and
  `choiceIntegerOperands`, because the type of the second operand depends on the
  mode and no existing field could say so.
- **`GET /api/capabilities` reported stderr redirection as unavailable.**
  `redirection.stderr: false` is true of `POST /api/sessions` and false of the
  product: `POST /api/terminal/execute` accepts `2>` and `2>>`, the grammar
  publishes both, and the engine implements them. The response now reports the
  split per route instead of one flag that cannot describe it.
- **Two counters were rendered as a hard `0` when they had never been measured.**
  Minor and major page faults are gated on separate sample counts, but the
  Analytics card collapsed them into one number, so two major-fault samples and
  one minor-fault sample printed `min 0`. The block I/O card did the same to read
  and write. Each half now renders its own unavailable state, and the backend
  publishes `minorFaultSamples` alongside `majorFaultSamples`.
- **Two pages displayed limits and totals the gateway had not sent.**
  Execute offered a 30 s default, a 120 s maximum, and a concurrency of 4 from
  `?? ` fallbacks; Process Explorer reported the returned row count as the host's
  process count even when the request limit truncated it. Both now render the
  server's value, or nothing.
- **A source file was binary.** `lib/terminal.ts` used a raw NUL byte as a join
  separator. The separator is still NUL — it is injective where a space is not —
  but it is now written `"\0"`, so the file is ASCII and grep can see it. Nothing
  had failed, which is why it survived: no gate inspects file encoding.

### Documentation

- [`docs/host-telemetry.md`](docs/host-telemetry.md) — every host metric, its
  kernel source, and its provenance.
- [`docs/guardrails.md`](docs/guardrails.md) — what is enforced, by which layer,
  and what is configured but not enforced.
- [`docs/limitations.md`](docs/limitations.md) — what CAPS does not do.
- [`docs/testing.md`](docs/testing.md) — every verification command.
- [`docs/ground-truth-verification.md`](docs/ground-truth-verification.md) — 59
  checks against raw `/proc` and `/sys`.
- [`docs/cross-view-trace.md`](docs/cross-view-trace.md) — one real execution
  traced through every surface, with captured identifiers.

Two routes were documented by a claim rather than by a description:
`/api/terminal/execute` had no entry in `docs/web-api.md` at all, and the stderr
capability was documented as absent. Both are now stated per route, and
`web/backend/tests/api/stderrRedirection.test.ts` holds the capability response
to what the two routes actually accept.

# Changelog

CAPS is not published to a registry, so these are project milestones rather
than semantic releases. The current version is **2.0.0** and has a single
canonical source: `PRODUCT_VERSION` in
`web/backend/src/config/env.ts`, projected into the C engine by
`scripts/generate-version.sh` and asserted against both `package.json` files, both
lockfiles, `include/version.h`, the README marker, and this changelog by
`scripts/check-version.sh` — which is itself tested against deliberately drifted
fixtures by `scripts/check-version.test.sh`.

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
