# CAPS architecture

One document describing the final system, its trust boundaries, and the
invariants each layer maintains. Where this and the other documents disagree,
this one is the reference and the others are stale.

## 1. The pipeline

```
  browser (React)
      |
      |  HTTPS / SSE
      v
  Fastify gateway  ------------------ security boundary
      |   allowlist -> verified absolute path
      |   argv, redirection, timeout validation
      v
  CAPS engine  (C11 / POSIX)
      |   fork()  ->  execvp(absolute path)  ->  waitpid()
      |   emits one JSON object per line on stderr
      v
  Linux kernel process
      |
      |   /proc/<pid>/{stat,status,io}
      v
  telemetry sampler  (procfs, 500 ms)
      |
      v
  canonical event store  (SQLite)   ------ persistence boundary
      |
      |  SSE + replay
      v
  evidence correlation  (pure, no I/O)
      |
      +--> 2D timeline / event list / inspector
      +--> 3D process space
```

## 2. The six boundaries

### Identity boundary

A process is identified by **session id + PID + kernel start time**, where the
start time is `/proc/<pid>/stat` field 22 converted with `btime` and
`CLK_TCK`. A PID alone is not an identity: Linux recycles PIDs, and a recycled
PID is a *different* process.

The same identity is used by three layers, and they must agree:

* the **gateway** refuses a delayed `SIGKILL` whose start ticks no longer match
  the identity captured when the process was first signalled;
* the **telemetry sampler** stops sampling a PID whose start ticks change
  mid-run, and refuses a PID whose `PPID` is not the gateway-spawned engine;
* the **frontend** keys its correlation index by `role:pid@start` and reports a
  PID seen with two start times as a collision instead of merging them.

### Security boundary

The gateway's allowlist is the only way to name a program, and it resolves to an
**absolute verified path** that is what actually gets `execvp`'d. `PATH` is
never consulted for an allowlisted command. See [SECURITY.md](../SECURITY.md)
for the full threat model and what is deliberately out of scope.

### Persistence boundary

The event store is canonical. The `sessions` table is a query index over it,
not a second source of truth; there is no separate process table. Everything a
reader can be shown is derived from persisted events.

### Transport boundary

SSE carries three distinct concepts, deliberately not conflated:

| Concept | Form | Meaning |
| --- | --- | --- |
| canonical event id | `evt_…` | stable identity of one event, unique database-wide |
| canonical sequence | `0, 1, 2, …` | position of an event *within one session* |
| transport frame | `caps.event` / `stream.end` | what is on the wire |

Only the `caps.event` frame carries an `id:`, and that id is the sequence. The
`stream.end` frame carries no `id:`, so `Last-Event-ID` can only ever hold a
real sequence. The previous implementation wrote `Number.MAX_SAFE_INTEGER`
into the end frame, which made a reconnecting client resume from a position
that does not exist.

### Rendering boundary

`lib/evidenceCorrelation.ts` is pure: no React, no three.js, no I/O, no
randomness. It is the single decision function every surface asks, which is
what makes the 2D timeline and the 3D process space agree by construction
rather than by convention.

### Observability-of-observability boundary

`/api/health` is liveness ("the process is running"). `/api/ready` is readiness
("the engine, database, workspace, and telemetry are usable") and returns 503
when a critical dependency is not. The previous single endpoint returned
`status: "ok"` with a literal `database: { available: true }`, so a gateway
that could not open its database still looked healthy.

## 3. The execution lifecycle

This is the part that was wrong, so it is stated precisely.

**CAPS is not a shell.** It tokenises like one and does not *expand* like one, and
this file is the tie-breaker when two documents disagree, so it states both halves
exactly as `include/parser.h` implements them.

Not supported, and there is no partial support to mistake for the real thing:

* no globbing (`*`, `?`, `[…]`)
* no variable expansion (`$VAR`) and no command substitution
* no `&`, `&&`, `||`, or `;`
* no subshells, no heredocs, no brace or tilde expansion
* no job control

Supported:

* **quoting** — single and double quotes, and backslash escapes, honoured by the
  single lexer `parser_tokenize()`
* **redirection** — one operator set: `<`, `>`, `>>`, `2>`, `2>>`, each requiring
  exactly one file-name token that may not itself be an operator
* **pipelines** — `|`, on a single command or across several stages, with the
  redirections attaching to the stage they are written on

There is no `1<`. The fd-number prefix is implemented for `2` only, because that
is what the engine opens a second descriptor for; `1<` is left literal.

The engine reports a **machine-readable outcome** on every terminal process
event:

| outcome | meaning |
| --- | --- |
| `COMPLETED` | the program ran and exited 0 |
| `EXITED` | the program ran and exited non-zero |
| `SIGNALED` | the program ran and was terminated by a signal |
| `EXEC_FAILED` | `execvp()` never succeeded; **no program ran** |
| `LAUNCH_FAILED` | the engine could not create the child |
| `WAIT_FAILED` | `waitpid()` failed; the outcome is genuinely unknown |

The gateway derives the session status from that outcome, and there is exactly
one terminal event type per terminal session status:

| session status | terminal event |
| --- | --- |
| `COMPLETED` | `execution.completed` |
| `FAILED` | `execution.failed` |
| `TIMED_OUT` | `execution.timeout` |
| `CANCELLED` | `execution.cancelled` |

**`SESSION_SUMMARY` is not a success claim.** It means the monitor reached the
end of its input, and CAPS emits it after a failed `execvp()` exactly as it
does after a successful run. The summary therefore also carries
`exec_errors`, `launch_errors`, and `observed_cleanly`. The previous
implementation read the summary's presence as success, so a nonexistent
program run was reported as `COMPLETED`.

Failure information is preserved end to end: the C engine emits `exit_code`,
`errno`, `errno_name`, `reason`, and `outcome`; the normalizer passes them
through; they are persisted in the event payload and served over SSE. 126
(permission denied) and 127 (not found) remain distinguishable all the way to
the UI.

## 4. Event-stream invariants

`web/backend/src/events/invariants.ts` states fourteen rules and returns
structured diagnostics, not a boolean:

| Id | invariant |
| --- | --- |
| I1 | one session per stream |
| I2 | sequences are unique |
| I3 | sequences strictly increase |
| I4 | sequences are contiguous from 0 (no gaps, therefore no loss) |
| I5 | at most one terminal event |
| I6 | the terminal event is last |
| I7 | no `process.snapshot` after the terminal event |
| I8 | event ids are unique (no duplicate delivery) |
| I9 | the stream begins with `execution.created` |
| I10 | a finalized session row and a finished stream agree |
| I11 | no process lifecycle event without a preceding `process.started` |
| I12 | `execution.completed` has a `process.exited` with code 0 |
| I13 | a corrupt stored payload is reported, never read as valid |
| I14 | a pipeline that reported completion accounted for every stage it declared |

`GET /api/sessions/:id/replay` returns the report with the events, and the
Markdown report and the JSON export include it.

## 5. SSE delivery order

The race-free sequence, and the order is load-bearing:

1. **subscribe** to the bus with a **buffer** — the listener exists, but events
   go into the buffer;
2. **read** the persisted backlog;
3. **send** the backlog;
4. **flush** the buffer, dropping anything already sent.

The previous order — read, compute the last sequence, then subscribe — left a
window in which an event could be both persisted and published with no listener
attached, so a connected client silently missed it. The guarantee now
implemented and tested: *a client never misses a persisted event because it
connected at the wrong moment.*

`GET /api/live/stream` uses the same ordering.

## 6. Telemetry provenance

Every metric in a `process.snapshot` payload carries its own provenance, and
the API publishes the classification so nothing has to be inferred:

| class | meaning | examples |
| --- | --- | --- |
| `OBSERVED` | read from procfs on this sample | `rssBytes`, `minorFaults`, `ppid`, `command` |
| `DERIVED` | computed from observations | `cpuPercent`, `cpuTimeMs`, `startTime`, every `*PerSec` |
| `UNAVAILABLE` | not produced, with a reason | anything on the first sample, any denied field |

Two counter policies apply to every cumulative counter:

* **no rate on the first sample** — a rate is a statement about an interval, so
  it is `UNAVAILABLE` rather than 0;
* **a counter that decreases is `UNAVAILABLE`, not 0** — a decrease means the
  identity changed, not that nothing was measured. This applies to CPU time as
  well as to I/O and fault counters; clamping a negative CPU delta to zero was
  reporting a fabricated measurement.

## 7. Shutdown

Deterministic, and each step is awaited before the next begins:

1. stop accepting new executions;
2. signal every active child (identity captured);
3. allow a graceful window, escalating with `SIGKILL` only if the recorded
   identity still matches;
4. finalize every session, so the database and the event stream agree;
5. stop telemetry;
6. close SSE streams and the HTTP server;
7. close the database.

The previous implementation sent one `SIGTERM`, immediately closed everything,
and called `process.exit(0)` — leaving sessions non-terminal in the database
with no terminal event, and leaving any child that ignored `SIGTERM` running.

Boot recovery is the same mechanism applied to sessions left in flight by a
previous process: they are finalized **through the runner**, so they get a
canonical terminal event rather than only a database row.

## 8. Persistence

* **Versioned migrations.** `schema_version` plus an ordered, append-only list.
  Each migration runs in its own transaction. Applying an already-applied
  migration is a no-op, so `migrate()` is safe on every open. A database from a
  *newer* build is refused rather than downgraded.
* **Transactions for multi-write units.** Session creation, its redirection
  rows, and its first event are one transaction, as is finalization with its
  terminal event.
* **`busy_timeout`**, so an operator inspecting the file with the `sqlite3` CLI
  does not turn the next request into an immediate `SQLITE_BUSY`.
* **Corruption is recorded, not hidden.** A payload that no longer parses is
  marked `payload_corrupt` on the row and surfaced in the API, instead of being
  replaced with `{}`.
* **Retention is explicit.** `CAPS_RETENTION_DAYS`, where `0` means "keep
  everything" and is a deliberate setting rather than an absent one. Every
  sweep logs what it removed.
* **Analytics aggregate in SQL.** The per-sample aggregates are computed with
  `json_extract` over the same persisted rows, so every number is still
  traceable to evidence; only the JavaScript object churn is avoided.

## 9. What CAPS does not observe

Stated once, and repeated verbatim in
[docs/observability-model.md](observability-model.md):

* **Only one PID is sampled.** The single CAPS-reported child. Descendants it
  forks are not discovered, not sampled, and not drawn. The `caps_fork_tree`
  workload therefore demonstrates *fork activity of one tracked process*, not a
  process tree.
* **No syscall tracing, eBPF, or cgroup accounting.**
* **No network I/O**, and `/proc/<pid>/io` is not per-device.
* **No file-descriptor census.**
* **No low-level `open`/`dup2`/`close` events.** Redirection *is* supported
  (`<`, `>`, `>>`, `2>`, `2>>`, on a single command or on one stage of a
  pipeline); what is not modelled is the descriptor-level syscall trail behind
  it. The engine reports `REDIRECTION_OPENED` and `REDIRECTION_FAILED` and then
  performs the `open`/`dup2`, and nothing below that is observed.
* **No descendant or sibling processes** beyond the sampled child.
* **CAPS diagnostics and the target's stderr share one descriptor** and are
  separated line-wise, not at descriptor level. The classification is exact
  for CAPS's own lines and a best effort for the target's.

## 10. Source layout

| Path | Role |
| --- | --- |
| `src/` | the C engine: `main.c` (REPL and one-shot), `process.c` (fork/exec/wait), `parser.c`, `monitor.c`, `signals.c`, `builtin.c` |
| `include/` | engine headers; `version.h` is generated |
| `workloads/` | first-party bounded laboratory programs |
| `tests/` | C unit/integration suites and the waitpid probe |
| `web/backend/src/security/` | allowlist, executable resolution, redirection policy |
| `web/backend/src/execution/` | runner, registry, terminator, normalizer, output classification |
| `web/backend/src/events/` | bus, SSE, and the event-stream invariants |
| `web/backend/src/db/` | migrations, transactions, repositories |
| `web/backend/src/telemetry/` | procfs collector, sampler, provenance, capabilities |
| `web/frontend/src/lib/` | pure view-model and correlation layers |
| `web/frontend/src/store/` | session-scoped investigation selection |
| `scripts/` | CI verification scripts and the version generator |
