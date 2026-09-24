# CAPS Observatory — Web Architecture

## 1. System overview

```
┌─────────────────────────────────────────────────────────────┐
│  Browser — React + TypeScript + Vite                        │
│  (feature-oriented pages, SSE store, motion library)        │
└───────────────┬───────────────────────────────┬─────────────┘
                │ HTTP (REST)                   │ GET /api/sessions/:id/events (SSE)
                ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Web Gateway — Node.js 22 + TypeScript + Fastify            │
│                                                            │
│  validation (Zod)      session registry       SSE bus       │
│  execution runner      security layer          analytics    │
│  event parser          event normalizer        SQLite       │
└───────────────┬───────────────────────────────┬─────────────┘
                │ structured argv               │ JSON events per line + stdout
                ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│  CAPS — existing C11/POSIX engine (./caps)                 │
│  --monitor --json [--redir-in/out/append] <cmd> <args...>  │
│                                                            │
│  getline → parser → argv[] → fork() → dup2() → execvp()    │
│          → waitpid() → status macros → monitor JSON        │
└─────────────────────────────────────────────────────────────┘
```

**Rule:** the C engine is the sole process executor. The gateway only
spawns `./caps` with an explicit `argv` array, `shell: false`, and
passes the requested command and arguments through verbatim.

## 2. The execution path (end to end)

1. The frontend posts a **structured request**:
   `{ command, args, redirections?, timeoutMs? }`.
2. The gateway validates with Zod (allowlist, path policy, limits) and
   creates a session row + `execution.created` event.
3. The gateway builds the CAPS argv:

   ```
   [<caps>, "--monitor", "--json", ("--redir-in"|"--redir-out"|"--redir-append"|<file>)*, command, ...args]
   ```

   and `spawn()`s it with `cwd` = the safe workspace and `shell: false`.
4. CAPS runs the real lifecycle and writes **one JSON object per line to
   stderr**; the command's own output goes to stdout.
5. The gateway reads stderr line-by-line, validates JSON, normalizes each
   event, assigns a monotonic `sequence`, persists it, and broadcasts it.
6. The frontend receives events over an SSE stream and updates only the
   affected parts of its store.

## 3. Web Gateway module layout (`web/backend`)

```
src/
  server.ts            Fastify bootstrap, route registration, shutdown
  config/env.ts        typed environment/config (Zod-validated)
  config/paths.ts      caps executable & workspace resolution
  db/database.ts       better-sqlite3 connection + migrations
  db/repositories/     sessions, events, analytics queries
  api/routes.ts        REST route wiring
  api/health.ts        /api/health
  api/capabilities.ts  /api/capabilities
  api/sessions.ts      POST/GET sessions, history
  api/session-detail.ts GET /api/sessions/:id, argv, output, replay
  api/events.ts        SSE endpoint
  api/terminate.ts     POST /api/sessions/:id/terminate
  api/processes.ts     GET /api/processes
  api/analytics.ts     aggregated real metrics
  execution/runner.ts  spawn ./caps, wire pipes, lifecycle
  execution/parser.ts  stderr line → raw JSON event
  execution/normalizer.ts raw CAPS event → canonical envelope
  execution/registry.ts active-session map + concurrency control
  execution/terminator.ts safe signal delivery + timeout policy
  events/bus.ts        topic publish/subscribe for SSE
  events/sse.ts        SSE client management, replay-on-reconnect
  analytics/service.ts percentile/aggregate computation
  security/policy.ts   allowlist, path policy, limits, threat model
```

## 4. Event model

### Raw CAPS monitor events (stderr, JSON line)

| Raw event              | Carries                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `COMMAND_RECEIVED`     | `command` label                                              |
| `PARSED`               | `command` label                                              |
| `COMMAND_PARSE_ERROR`  | `command`                                                    |
| `REDIRECTION_OPENED`   | `command`                                                    |
| `REDIRECTION_FAILED`   | `command`                                                    |
| `PROCESS_STARTED`      | `pid`, `command`                                             |
| `PROCESS_EXITED`       | `pid`, `exit_code`, `duration_ms` (monotonic), `command`     |
| `SIGNAL_RECEIVED`      | `pid`, `signal`, `command`                                   |
| `EXEC_ERROR`           | `pid`, `command` (126/127 heuristic)                         |
| `SESSION_SUMMARY`      | counters + `average_duration_ms`                             |

The gateway **does not invent C-side events**. Anything the C engine
cannot observe (e.g. an explicit `execvp()` success event) is either
derived honestly from surrounding events or labeled as inferred in the UI.

### Canonical envelope (stored + streamed)

```json
{
  "id": "evt_01J4Q...",
  "sessionId": "exec_01J4Q...",
  "sequence": 7,
  "type": "process.exited",
  "source": "caps",
  "timestamp": "2026-09-24T10:30:20.125Z",
  "monotonicMs": 1842,
  "pid": 12345,
  "payload": { "exitCode": 0, "label": "echo Hello Shiva" }
}
```

Canonical types map 1:1 from raw events plus honest gateway lifecycle
events:

- `execution.created`, `execution.started`, `execution.completed`,
  `execution.failed`, `execution.timeout` (gateway facts)
- `command.received`, `command.parsed`, `command.parse_error`
- `redirection.opened`, `redirection.failed`
- `process.started`, `process.exited`, `process.exec_error`
- `signal.received`
- `session.summary`

**Ordering:** `sequence` is authoritative; wall-clock timestamps are for
display. `(sessionId, sequence)` is unique.

## 5. State model

### Session lifecycle

```
CREATED → STARTING → RUNNING → COMPLETED
                    → FAILED       (caps crashed / spawn error)
                    → TIMED_OUT    (gateway killed the child)
                    → CANCELLED    (user requested termination → observed)
```

The terminal state is derived from observed events, never guessed.

### Frontend store

A dedicated execution store (Zustand) holds `session`, `events[]`,
`processes[]`, `argv`, `redirections`, and `streamState`. Components
consume derived selectors. Router params (`/execution/:id`) rehydrate
from history when not already present.

## 6. Real-time transport

- **Server-Sent Events** (`GET /api/sessions/:id/events`). The gateway
  sends persisted events on connect (so a reconnecting client never
  misses data — `Last-Event-ID` / `sequence` based), then broadcasts live
  events.
- No polling for execution events.
- A global `/api/events/global`-style awareness is avoided; the Overview
  reads live state via `GET /api/processes` + history list with a
  client-side refresh channel when a local execution completes.

## 7. Persistence (SQLite)

- `sessions` — id, command, args JSON, redirections JSON, status,
  started_at, ended_at, duration_ms, exit_code, signal, is_success,
  variant (external/builtin), created_at.
- `events` — id, session_id, sequence, type, source, timestamp,
  monotonic_ms, pid, payload JSON.
- `processes` — pid, session_id, command, state, started_at, ended_at,
  duration_ms, exit_code, signal.
- `redirections` — session_id, slot, target, mode, flags.
- Indexes on `events(session_id, sequence)`, `sessions(created_at)`,
  `sessions(status)`.

## 8. Security model

See `docs/security.md`. Summary:

- Bind `127.0.0.1` only (allows WSL localhost forwarding for dev).
- Command allowlist (safe binaries only, structured argv, `shell:false`).
- Safe working directory; redirection file paths validated (no `..`, no
  absolute, no NUL).
- Timeouts, output caps, max concurrent sessions (default 4),
  abandoned-session cleanup.
- No secrets in env → never accepted/logged; docs warn about exposing the
  gateway to untrusted networks.

## 9. Performance

- Every event updates one store; React components subscribe selectively.
- The event timeline is capped in the UI (tail window) while the full
  event history stays in SQLite.
- SSE clients are removed on socket close; completed sessions are pruned
  from the registry memory but persisted.