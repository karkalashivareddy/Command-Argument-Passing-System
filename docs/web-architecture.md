# CAPS — Web Architecture

> **Scope.** This document covers the gateway: module layout, the event model,
> storage, and transport. For the whole system — including the C engine, the
> trust boundaries, and the thirteen event-stream invariants — see
> [architecture.md](architecture.md), which is the reference. For what is and is
> not observed, see [observability-model.md](observability-model.md).

## 1. System overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser — React 19 + TypeScript + Vite                          │
│  pages · components/space (3D observatory) · lib (pure models)   │
└───────────────┬──────────────────────────────┬───────────────────┘
                │ REST                         │ SSE
                │ POST /api/sessions           │ /api/sessions/:id/events
                │ GET  /api/...                │ /api/live/stream
                ▼                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Gateway — Node.js 22 + TypeScript + Fastify 5                  │
│                                                                  │
│  SECURITY    allowlist → verified absolute path, workspace policy │
│  EXECUTION   runner · registry · terminator · output classifier  │
│  STORAGE     versioned migrations · transactions · repositories  │
│  TRANSPORT   EventBus (buffered) · SseStream                     │
│  TELEMETRY   procfs collector · sampler · provenance             │
│  ANALYTICS   percentiles · peaks · comparison                    │
└───────────────┬──────────────────────────────────────────────────┘
                │ spawn(argv, shell: false)
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  CAPS — C11/POSIX engine (./caps)                                │
│  --monitor --json [--redir-in|out|append F] <absolute> <args…>  │
│                                                                  │
│  parser.c → process.c → fork() · execvp() · waitpid() → monitor.c│
└───────────────┬──────────────────────────────────────────────────┘
                │ one JSON object per line on stderr
                ▼
        Linux kernel — the real target process, the real /proc
```

**The rule that keeps the layers honest:** the C engine is the *only* process
executor. The gateway never calls `fork()` or `execvp()`; it spawns `./caps`
with an explicit argv array and `shell: false`, and the engine runs the
requested command. The browser executes nothing.

## 2. The execution path, end to end

1. The frontend posts a **structured request**:
   `{ command, args, redirections?, timeoutMs? }`. There is no command string
   for a shell to interpret.
2. `zod` validates shape, size, and semantics. A redirection target that is
   empty or whitespace-only is a 400, not a silently ignored field.
3. The allowlist resolves `command` to a **verified absolute path**:
   `realpath` → `lstat` (regular file, not a symlink) → `access(X_OK)`. `PATH`
   is never consulted.
4. The session row, its redirection rows, and the `execution.created` event are
   written in **one transaction**.
5. The gateway builds the CAPS argv and spawns it with `cwd` = the workspace,
   `shell: false`, and an environment of `PATH`/`LANG`/`HOME`/`TERM` only.
6. CAPS runs the real lifecycle and writes one JSON object per line to stderr.
   The command's own output goes to stdout.
7. The gateway classifies **each stderr line exactly once** into
   monitor-protocol / CAPS-diagnostic / target-output, normalizes the monitor
   lines, assigns the next sequence, persists, and publishes.
8. The frontend receives `caps.event` frames and updates only what changed.

## 3. Module layout (`web/backend/src`)

```
server.ts              Fastify bootstrap, request boundary, shutdown sequence
config/env.ts          validated configuration, bind mode, cross-field checks
db/database.ts         open, pragmas, versioned migrations, transactions
db/repositories/       sessions.ts, events.ts
events/bus.ts          in-process pub/sub with a buffered subscription
events/sse.ts          SSE frames, keep-alive, Last-Event-ID parsing
events/invariants.ts   validateEventStream() — the thirteen rules
execution/runner.ts    spawn, stderr classification, lifecycle, finalization
execution/registry.ts  active-session map, concurrency, stale sweep
execution/terminator.ts signal delivery with PID-reuse identity checks
execution/normalizer.ts raw CAPS event → canonical envelope
execution/parser.ts    one stderr line → event or diagnostic
execution/output.ts    line classification for the three output channels
execution/workloadCatalog.ts  bounded workload profiles and their scope
telemetry/collector.ts the only place that reads /proc
telemetry/sampler.ts   cadence, identity verification, rate derivation
telemetry/derive.ts    cross-sample rates and counter-reset policy
telemetry/capabilities.ts  the published provenance classification
telemetry/types.ts     the snapshot contract and its key lists
analytics/service.ts   percentiles, runtime peaks, comparison, aggregates
security/policy.ts     allowlist, executable resolution, path policy, limits
types/observability.ts the canonical event and session contract
utils/logger.ts        structured, bounded logging from validated config
utils/ids.ts           id generation
```

There is no `config/paths.ts` and no `api/health.ts` / `api/sessions.ts` split:
routes are registered from a single `api/routes.ts`, and path resolution moved
into `config/env.ts` when the bind boundary became cross-field.

## 4. Event model

### Raw CAPS monitor events (stderr, one JSON object per line)

| Raw event | Carries |
| --- | --- |
| `COMMAND_RECEIVED` | `command` label |
| `PARSED` | `command` label |
| `COMMAND_PARSE_ERROR` | `command` label |
| `REDIRECTION_OPENED` / `REDIRECTION_FAILED` | `command` label |
| `PROCESS_STARTED` | `pid`, `command` |
| `PROCESS_EXITED` | `pid`, `exit_code`, `duration_ms`, `outcome` |
| `SIGNAL_RECEIVED` | `pid`, `signal`, `outcome` |
| `EXEC_ERROR` | `pid`, `exit_code` (126/127), `errno`, `errno_name`, `reason`, `outcome` |
| `WAIT_FAILED` | `pid`, `errno`, `reason`, `outcome` |
| `EXECUTION_FAILED` | `errno`, `reason`, `outcome` |
| `SESSION_SUMMARY` | counters, `exec_errors`, `launch_errors`, `observed_cleanly` |

### Canonical event types

| Type | Source | Terminal |
| --- | --- | --- |
| `execution.created` | gateway | |
| `execution.started` | gateway | |
| `process.started` | caps | |
| `process.snapshot` | gateway | |
| `signal.received` | caps | |
| `process.exited` | caps | |
| `process.exec_error` | caps | |
| `process.wait_failed` | caps | |
| `process.launch_failed` | caps | |
| `command.*`, `redirection.*` | caps | |
| `session.summary` | caps | |
| `execution.completed` | gateway | ✔ |
| `execution.failed` | gateway | ✔ |
| `execution.timeout` | gateway | ✔ |
| `execution.cancelled` | gateway | ✔ |

One terminal event type per terminal session status, so the row and the stream
can never describe the same ending differently.

### Envelope

```json
{
  "id": "evt_…",
  "sessionId": "exec_…",
  "sequence": 7,
  "type": "process.exited",
  "source": "caps",
  "timestamp": "2026-03-01T12:00:03.412Z",
  "monotonicMs": 3097,
  "pid": 1944,
  "payload": { "exitCode": 0, "durationMs": 3097, "outcome": "COMPLETED", "…": "…" }
}
```

`sequence` is contiguous from 0 within a session, and is the only value
`Last-Event-ID` may carry.

## 5. Storage

SQLite through Node's built-in `node:sqlite`, in WAL mode, with foreign keys on
and a busy timeout so an operator inspecting the file does not turn the next
request into an immediate `SQLITE_BUSY`.

```sql
sessions(id PK, command, args, redirections, status, started_at, ended_at,
         duration_ms, exit_code, signal, is_success, pid, stdout, stderr,
         error, timeout_ms, created_at)

events(id PK, session_id FK → sessions ON DELETE CASCADE, sequence, type,
       source, timestamp, monotonic_ms, pid, payload,
       payload_corrupt, payload_error, UNIQUE(session_id, sequence))

redirections(id PK, session_id FK → sessions ON DELETE CASCADE, slot, target, flags)

schema_version(version PK, name, applied_at)
```

The event store is canonical. `sessions` is a query index over it, not a second
source of truth. A `processes` table existed, was never written to, and was
**removed** in migration 2 — leaving it would have implied a second truth.

Migrations are ordered, transactional, and idempotent. A database from a newer
build is refused rather than downgraded.

## 6. Transport

### Frame semantics

Three separate concepts, deliberately not conflated:

| Concept | Form | Meaning |
| --- | --- | --- |
| canonical event id | `evt_…` | unique identity of one event, database-wide |
| canonical sequence | `0, 1, 2, …` | position within one session; what `Last-Event-ID` means |
| transport frame | `caps.event` / `stream.end` | what is on the wire |

Only `caps.event` carries an `id:`. `stream.end` carries none, so a reconnect
can never resume from a position that does not exist.

### Race-free delivery order

```
1. subscribe to the bus WITH A BUFFER   (listener exists, delivery paused)
2. read the persisted backlog
3. send the backlog
4. flush the buffer, dropping anything already sent
```

The previous order — read, compute the last sequence, then subscribe — left a
window in which an event could be both persisted and published with no listener
attached. The guarantee now implemented and tested: *a client never misses a
persisted event because it connected at the wrong moment.*

## 7. Shutdown

Deterministic, each step awaited before the next: stop accepting new
executions → signal every active child (identity captured) → graceful window
with identity-verified escalation → finalize every session so the database and
the event stream agree → stop telemetry → close SSE and HTTP → close the
database.

Boot recovery applies the same mechanism to sessions left in flight by a
previous process, so a recovered session gets a real terminal event rather than
only a database row.

## 8. Analytics

Per-session work (runtime peaks, command profiles, comparison) runs over the
events of the sessions it needs. The overview's cross-session telemetry
aggregate is computed in SQL with `json_extract` over the same persisted rows,
so every number remains traceable to evidence without materialising an object
per snapshot. See [architecture.md](architecture.md#8-persistence) for the
retention policy that keeps that cost bounded.
