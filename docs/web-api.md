# CAPS Observatory — Web API

Base path: `http://127.0.0.1:3000` (configurable). All request/response
bodies are JSON. Errors follow a single shape:

```json
{
  "error": { "code": "INVALID_ARGUMENT", "message": "…", "requestId": "req_…" }
}
```

## Execution model

POSTing `/api/sessions` starts one **real CAPS execution**. CAPS is
spawned with `shell:false` and an explicit argv array; the request is the
single source of truth for the argument vector.

## Endpoints

### `GET /api/health`

```json
{
  "status": "ok",
  "engine": { "available": true, "path": "./caps" },
  "database": { "available": true },
  "version": "0.1.0"
}
```

`engine.available` reflects a real executable check of the CAPS binary.

### `GET /api/capabilities`

```json
{
  "platform": "linux",
  "allowlist": ["echo","printf","sleep","true","false","pwd","cat","status_probe"],
  "limits": { "maxConcurrent": 4, "defaultTimeoutMs": 30000, "maxTimeoutMs": 120000 },
  "workspace": "/path/to/data/work",
  "redirection": { "supported": true, "modes": ["in","out","append"] },
  "signals": { "supported": true },
  "telemetry": { "enabled": true, "intervalMs": 500, "source": "/proc/<tracked-pid>" }
}
```

### `POST /api/sessions`

Body (Zod-validated):

```json
{
  "command": "echo",
  "args": ["Hello", "Shiva"],
  "redirections": { "out": "demo.txt", "append": "log.txt", "in": "in.txt" },
  "timeoutMs": 30000
}
```

- `command` is required and must be on the allowlist.
- `cat` accepts only existing regular files whose resolved paths remain
  inside the configured workspace. It does not accept command-line options
  through the gateway.
- `redirections` is optional; each slot takes exactly one file name.
  File names must be relative, within the safe workspace, no `..`.
- Returns `202` immediately; execution proceeds in the background:

```json
{
  "sessionId": "exec_01J4…",
  "status": "STARTING",
  "eventsUrl": "/api/sessions/exec_01J4…/events",
  "argvPreview": ["--monitor","--json","echo","Hello","Shiva"]
}
```

Rejected cases return `400` (invalid), `403` command not allowed, `429`
concurrency limit reached, `422` redirection path rejected.

### `GET /api/sessions`

History, newest first. Query: `?limit=50&offset=0&status=…&q=…`.

```json
{
  "sessions": [{
    "id": "exec_…",
    "command": "echo",
    "args": ["Hello","Shiva"],
    "status": "COMPLETED",
    "startedAt": "…", "endedAt": "…",
    "durationMs": 4, "exitCode": 0, "signal": null,
    "isSuccess": true,
    "pid": 12345,
    "redirections": {}
  }],
  "total": 12
}
```

### `GET /api/sessions/:id`

Full metadata + `argv`:

```json
{
  "id": "exec_…",
  "command": "echo",
  "args": ["Hello","Shiva"],
  "argv": ["echo","Hello","Shiva"],
  "status": "COMPLETED",
  "startedAt": "…",
  "endedAt": "…",
  "durationMs": 4,
  "exitCode": 0,
  "signal": null,
  "isSuccess": true,
  "pid": 12345,
  "redirections": { "out": "demo.txt" },
  "eventCount": 6
}
```

### `GET /api/sessions/:id/events` (SSE)

`text/event-stream`. On connect the server replays stored events, then
streams live ones.

```
event: execution.received
data: {"id":"evt_…","sessionId":"exec_…","sequence":0,"type":"execution.created","source":"gateway","timestamp":"…","monotonicMs":0,"pid":null,"payload":{}}

event: execution.received
data: {"…"}

event: execution.ended
data: {"sessionId":"exec_…","status":"COMPLETED","exitCode":0}
```

The final line (`execution.ended`) closes the stream. Reconnect uses the
`Last-Event-ID` header; events are re-sent from `sequence > last`.

### `GET /api/sessions/:id/argv`

```json
{
  "sessionId": "exec_…",
  "argc": 3,
  "argv": ["echo","Hello","Shiva"],
  "argvDisplay": ["echo","Hello","Shiva","NULL"]
}
```

### `GET /api/sessions/:id/output`

Captured program stdout/stderr as the execution ran:

```json
{ "sessionId": "exec_…", "stdout": "Hello Shiva\n", "stderr": "" }
```

### `GET /api/sessions/:id/replay`

Stored event timeline for the replay engine:

The timeline includes `process.snapshot` events when the backend collected procfs data. Snapshot event payload metrics carry `value`, `provenance`, `source`, and, when unavailable, a `reason`. Replay returns only persisted event data; it does not inspect procfs or restart the command.

### `GET /api/processes`

Lists only active executions tracked in the gateway registry. Each row contains the CAPS execution ID, the CAPS-reported child PID, and the latest procfs snapshot for that same execution when available. No arbitrary PID can be supplied to this endpoint.

```json
{
  "sessionId": "exec_…",
  "command": "echo",
  "argv": ["echo","Hello","Shiva"],
  "startedAt": "…",
  "events": [
    {"sequence":0,"type":"execution.created","timestamp":"…","monotonicMs":0,"pid":null},
    {"sequence":1,"type":"command.received","…"},
    …
  ],
  "result": { "exitCode": 0, "signal": null, "durationMs": 4, "isSuccess": true }
}
```

### `POST /api/sessions/:id/terminate`

```json
{ "signal": "SIGINT" }
```

Sends a real signal to the child PID (observed via `process.started`).
Returns `202` unless the session is already terminal. Default `SIGINT`
(the Signal Lab path). The real `SIGNAL_RECEIVED`/`PROCESS_EXITED` events
then stream as usual.

### `GET /api/processes`

Live process registry (only PIDs genuinely produced by CAPS in this
gateway):

```json
{
  "processes": [{
    "sessionId": "exec_…", "pid": 12345, "command": "sleep",
    "argv": ["sleep","10"], "state": "RUNNING",
    "startedAt": "…", "durationMs": 2103
  }]
}
```

### `GET /api/analytics/overview`

Computed from stored sessions only:

```json
{
  "totalExecutions": 42,
  "successful": 37,
  "failed": 4,
  "signalled": 1,
  "avgDurationMs": 12.4,
  "p50Ms": 5, "p95Ms": 42, "p99Ms": 300,
  "byExitCode": { "0": 37, "1": 3, "127": 1, "130": 1 },
  "bySignal": { "2": 1 },
  "byCommand": { "echo": 20, "sleep": 10, "false": 4, … },
  "redirectionUsage": { "out": 5, "append": 2, "in": 1 },
  "byDay": [ { "date": "2026-09-24", "count": 42, "success": 37 } ]
}
```

### `GET /api/analytics/commands`

Per-command baselines from stored sessions:

```json
{
  "totalCommandRuns": 42,
  "commands": [{
    "command": "echo", "runs": 20, "successful": 20, "failed": 0,
    "signalled": 0, "successRate": 100.0,
    "avgDurationMs": 1.2, "medianDurationMs": 1.0, "p95DurationMs": 3.0,
    "minDurationMs": 0.4, "maxDurationMs": 6.0,
    "rssSamples": 10, "medianRssBytes": 1204296, "peakRssBytes": 1409024,
    "lastRunAt": "…"
  }]
}
```

`null` fields mean insufficient observations, never fabricated zeros. The
frontend renders `—` for those cells.

### `GET /api/analytics/compare?ids=<left>,<right>`

Side-by-side comparison of two stored sessions (no re-execution):

```json
{
  "left":  { "sessionId": "exec_…", "command": "echo", "args": ["Hello"], "status": "COMPLETED", "exitCode": 0, "signal": null, "durationMs": 4, "eventCount": 12, "snapshotCount": 6, "peakRssBytes": 1260000, "medianRssBytes": 1220000, "peakCpuPercent": 8.2, "cpuTimeMs": 2 },
  "right": { … },
  "shared": { "sameCommand": true, "command": "echo", "sameExit": true, "sameSignal": true, "sameStatus": true },
  "deltas": { "durationMs": 2, "eventDelta": 1, "snapshotDelta": 0, "peakRssDeltaBytes": 40000, "cpuTimeDeltaMs": 1 }
}
```

Rejects sessions that do not exist, an empty query, or a self-comparison
(`ids=a,a`) with a `400`.

### `GET /api/sessions/:id/export?format=json|csv`

Downloads the persisted event timeline.

- `json` — the same canonical envelope array returned by replay.
- `csv` — header `sequence,timestamp,type,payload_json`; string values are
  RFC 4180 double-quote escaped; content disposition
  `attachment; filename="<id>.<format>"`.

### `GET /api/sessions/:id/report`

Markdown observation report (`text/markdown; charset=utf-8`) with the
command, outcome, exit/signal, duration, peaks & moments, snapshot summary,
and per-event tallies. Generated from the stored event store; it never
re-runs the command.

### `GET /api/playground/examples`

Curated educational examples (static, safe list).

## Security rules

- No shell executable (`sh`, `bash`, etc.) is allowed through the gateway:
  a request for `sh -c` would bypass the executable allowlist. No
  `shell:true`, `system()`, `popen()`, or string-concatenated command
  execution is used.
- Allowlist enforced server-side; path traversal rejected; timeouts and
  output caps enforced server-side; default bind `127.0.0.1`.
- This gateway executes OS processes — do **not** expose it to untrusted
  networks.
