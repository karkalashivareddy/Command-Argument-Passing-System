# CAPS — Web API Reference

Base path: `http://127.0.0.1:3000` by default (`CAPS_PORT`). All request and
response bodies are JSON. Errors use a single shape:

```json
{ "error": { "code": "INVALID_ARGUMENT", "message": "…", "requestId": "req_…" } }
```

The `requestId` is also sent as `x-request-id` on the request and appears in
the gateway's structured log, so one call is traceable without correlating on
timing.

## Execution model

`POST /api/sessions` starts one **real CAPS execution**. CAPS is spawned with
an explicit argv array and `shell: false`; the request is the single source of
truth for the argument vector. `command` and `args` are separate fields — there
is no command string for a shell to interpret.

## Authentication

In the default `local` bind mode there is no authentication, because the
gateway refuses to start on a non-loopback address. In `remote` mode every
request requires `Authorization: Bearer <token>`, and the gateway refuses to
start without one. See [SECURITY.md](../SECURITY.md).

## Health

### `GET /api/health` — liveness

Answers one question: is the process running?

```json
{
  "status": "ok",
  "version": "2.0.0",
  "platform": "linux/posix",
  "uptimeSeconds": 412
}
```

### `GET /api/ready` — readiness

Answers a different question: can the gateway actually do its job? Returns
**503** when a critical dependency is unavailable.

```json
{
  "ready": true,
  "version": "2.0.0",
  "checks": {
    "engine":     { "available": true, "detail": "caps engine is executable" },
    "database":   { "available": true, "detail": "event store is open" },
    "workspace":  { "available": true, "detail": "workspace is writable" },
    "telemetry":  { "available": true, "detail": "procfs sampling is available" }
  },
  "retention": { "days": 0, "enabled": false, "policy": "disabled: every session is kept" },
  "storage": { "sessions": 42, "events": 3180, "dbBytes": 2_191_360 }
}
```

## Capabilities

### `GET /api/capabilities`

What this gateway can actually do, verified at request time. Absolute
filesystem paths are **not** returned; `enginePath` and `workspace` are
repository-relative.

```json
{
  "version": "2.0.0",
  "platform": "linux/posix",
  "engineAvailable": true,
  "enginePath": "caps",
  "workspace": "data/work",
  "workspaceAvailable": true,
  "allowlist": ["echo","printf","sleep","true","false","pwd","cat","uname","status_probe","caps_cpu_burn","…"],
  "limits": { "maxConcurrent": 4, "defaultTimeoutMs": 30000, "maxTimeoutMs": 120000, "maxOutputBytes": 65536 },
  "guardrails": {
    "wallTime": {
      "configuredBytesOrMs": 30000,
      "unit": "ms",
      "enforced": true,
      "mechanism": "the gateway's own timer; on expiry it escalates SIGTERM then SIGKILL. The engine has no timeout of its own"
    },
    "wallTimeCeiling": { "configuredBytesOrMs": 120000, "unit": "ms", "enforced": true },
    "stdout": {
      "configuredBytesOrMs": 65536,
      "unit": "bytes",
      "enforced": true,
      "mechanism": "the gateway bounds the retained stdout buffer and records the truncation. The child is NOT stopped for producing output, and does not need to be: both pipes are drained continuously, so a full pipe cannot block the child"
    },
    "stderr": {
      "configuredBytesOrMs": 65536,
      "unit": "bytes",
      "enforced": true,
      "mechanism": "bounded separately from stdout, so a loud stderr cannot consume the stdout budget. The gateway drains both pipes continuously, so an unbounded stderr fills no pipe and cannot deadlock a healthy child"
    },
    "cpuTime": {
      "configuredBytesOrMs": 0,
      "unit": "ms of kernel-reported CPU time",
      "enforced": false,
      "mechanism": "not configured; CPU time is observed and recorded but not limited",
      "caveat": "This is CPU time, not wall-clock time. A process sleeping on I/O consumes none. The kernel's limit is whole seconds, so a millisecond budget is rounded UP to the next second and the real ceiling is never tighter than the configured one"
    },
    "addressSpace": {
      "configuredBytesOrMs": 0,
      "unit": "bytes of virtual address space (RLIMIT_AS)",
      "enforced": false,
      "mechanism": "not configured",
      "caveat": "RLIMIT_AS caps VIRTUAL ADDRESS SPACE, not physical memory. It bears no simple relation to RSS or to the machine's RAM…"
    },
    "concurrency": {
      "configuredBytesOrMs": 4,
      "unit": "simultaneous executions",
      "enforced": true,
      "mechanism": "a request beyond the limit is refused with 429 rather than queued indefinitely"
    },
    "thermal": { "enabled": false, "availability": "DISABLED", "reason": "…", "action": "WARN", "scope": "CAPS-owned workloads only; never an unrelated host process", "restrictions": [ … ] }
  },
  "security": {
    "bindMode": "local",
    "loopbackOnly": true,
    "authentication": "none (loopback only)",
    "executableResolution": "absolute verified path; PATH is never consulted for an allowlisted command",
    "redirectionHardening": "O_NOFOLLOW plus a regular-file check at open time"
  },
  "redirection": {
    "supported": true,
    "modes": ["in","out","append"],
    "stderr": true,
    "stderrByRoute": { "/api/sessions": false, "/api/terminal/execute": true },
    "stderrNote": "stderr redirection is a terminal-route feature. POST /api/sessions accepts only in/out/append and rejects a stderr slot with 400. Both routes validate the target against the workspace policy and the engine opens it with O_NOFOLLOW."
  },
  "signals": {
    "supported": ["SIGINT","SIGTERM","SIGKILL","SIGQUIT","SIGTSTP"],
    "identityVerified": true,
    "identityVerificationScope": "verified before every DELAYED escalation, and for every signal delivered through pidfd. The first signal of a terminate or a timeout is delivered by kill(2) to the PID the gateway spawned, without a re-read of /proc first; that PID is the gateway's own unreaped child at that moment, so it cannot have been recycled. …"
  },
  "telemetry": {
    "enabled": true,
    "intervalMs": 500,
    "source": "/proc/<tracked-pid>/{stat,status,io}",
    "observedMetrics": ["pid","command","ppid","rssBytes","minorFaults","…"],
    "derivedMetrics": ["startTime","elapsedMs","cpuTimeMs","cpuPercent","…"],
    "gatewayMetrics": ["capsEnginePid"],
    "metricProvenance": { "cpuPercent": "DERIVED", "rssBytes": "OBSERVED", "capsEnginePid": "GATEWAY" },
    "counterResetRule": "A cumulative counter that decreases between two samples is reported as UNAVAILABLE, never as zero…",
    "notCollected": ["Syscall tracing","eBPF","cgroup accounting","Network I/O","File descriptor counts"]
  },
  "processIdentity": {
    "model": "pidfd: a kernel handle bound to one specific process",
    "confidence": "VERIFIED",
    "reason": "pidfd_open(2) and pidfd_send_signal(2) are available",
    "kernel": "…",
    "terminationMechanism": "pidfd",
    "invariant": "CAPS signals only processes it started. Every DELAYED escalation, and every pidfd signal, checks that the kernel still reports the identity it recorded before delivering. A PID on its own is never sufficient, because PIDs are reused. …"
  },
  "observability": {
    "timeline": { "enabled": true, "axis": "seconds-relative-to-first-event" },
    "annotations": true,
    "peaks": true,
    "replaySync": true,
    "sequenceIntegrity": true,
    "export": { "formats": ["json","csv"] },
    "report": true,
    "comparison": true,
    "commandProfiles": true
  },
  "bind": { "mode": "local", "host": "127.0.0.1", "port": 3000 },
  "workloads": { "count": 5, "available": 5, "profiles": [ … ], "limits": { … } }
}
```

`guardrails` publishes every limit as three separable things: `configuredBytesOrMs`,
`enforced`, and a `mechanism`. They are allowed to disagree, and the
disagreement is the point — a configured limit the gateway cannot apply must not
look enforced. `enforced` is `false` wherever the configured value is `0`, which
means "unlimited", not "zero". See [`guardrails.md`](guardrails.md).

`processIdentity` is a **real probe**, not a declaration: it is the answer to
"what does a signal sent by CAPS actually guarantee?", and the guarantee differs
by host. `confidence` is `VERIFIED` (`pidfd`), `UNVERIFIED` (start-ticks
validation), or `UNAVAILABLE` — and in the last case CAPS **will not signal**.

`redirection.stderr` is `true` because the product supports `2>` and `2>>`. It
used to publish `stderr: false`, which was true only of `/api/sessions`, whose
schema accepts just `in`/`out`/`append`; `stderrByRoute` states the per-route
truth and `stderrNote` names the asymmetry. A single flag cannot describe it.

`telemetry.observedMetrics` is the procfs-read subset. A rate is **not** in
it: a rate is computed from two samples, and the previous single
`collectedMetrics` list conflated the two, which let a reader conclude
`cpuPercent` was a procfs field.

Each workload profile carries an `observationScope` stating what is sampled and
what is **not**, so a UI cannot imply coverage the sampler does not provide.

## Sessions

### `POST /api/sessions`

```json
{
  "command": "echo",
  "args": ["Hello CAPS"],
  "redirections": { "out": "demo.txt", "append": "log.txt", "in": "in.txt" },
  "timeoutMs": 30000
}
```

| Field | Rule |
| --- | --- |
| `command` | 1–256 chars, on the allowlist, and **resolvable to a verified absolute path** |
| `args` | ≤ 512 entries, each ≤ 4096 chars, ≤ 128 KiB total, no NUL |
| `redirections.*` | optional; each value must be a non-empty, non-blank, workspace-relative name |
| `timeoutMs` | ≥ 1000, clamped to `maxTimeoutMs` |

This route takes **one command**. It has no stderr slot: `redirections` is a
strict object of `in`/`out`/`append`, so a `stderr` key is a 400 rather than a
silently ignored field. For stderr redirection, and for pipelines, use
[`POST /api/terminal/execute`](#post-apiterminalexecute).

Errors:

| Code | Status | When |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 400 | shape, size, or semantic violation |
| `COMMAND_NOT_ALLOWED` | 403 | the name is not on the allowlist |
| `COMMAND_UNAVAILABLE` | 503 | allowlisted, but the binary is missing or unverified |
| `TIMEOUT_TOO_SHORT` | 400 | a workload's own budget exceeds the transport timeout |
| `REDIRECTION_REJECTED` | 422 | path policy refused the target |
| `ARGUMENT_REJECTED` | 422 | a per-command argument schema or the workspace file policy refused an argument; the message names the rule |
| `WORKLOAD_ARGUMENT_REJECTED` | 400 | a workload's own arguments are not in its declared range |
| `CONCURRENCY_LIMIT_REACHED` | 429 | the concurrency limit is reached |
| `PERSISTENCE_FAILED` | 500 | the session could not be recorded, so it was **not started** |

Response `202`:

```json
{ "sessionId": "exec_…", "status": "STARTING", "eventsUrl": "/api/sessions/exec_…/events", "argvPreview": ["--monitor","--json","echo","Hello CAPS"] }
```

### `GET /api/sessions`

Query: `limit` (1–200, default 50), `offset` (0–100000, default 0),
`status` (one of the session statuses or `ALL`), `q` (≤ 128 chars, matched
against command, args, and id).

```json
{ "sessions": [ … ], "total": 128, "limit": 50, "offset": 0 }
```

### `GET /api/sessions/:id`

The session record. `storedJsonCorrupt` and `storedJsonError` appear when a
persisted JSON column could not be parsed — the record is still returned,
because hiding the session would hide the corruption.

### `DELETE /api/sessions/:id`

`409 RUNNING` if the execution is still in flight. Deletes the session, its
events, and its redirection rows in one transaction.

### `GET /api/sessions/:id/argv`

The exact argv the program received, with the `NULL` terminator shown for
teaching purposes.

### `GET /api/sessions/:id/output`

```json
{
  "sessionId": "exec_…",
  "stdout": "Hello CAPS\n",
  "stderr": "",
  "live": true,
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "channels": {
    "stdout": "the executed program's own stdout, copied verbatim",
    "stderr": "the executed program's stderr plus CAPS diagnostics; the CAPS monitor protocol is not included",
    "limitation": "CAPS diagnostics and the target's stderr share one descriptor and are separated line-wise, not at descriptor level"
  }
}
```

`live` is `true` while the execution is running. Both channels are served live;
the CAPS monitor protocol never appears in `stderr`.

### `GET /api/sessions/:id/replay`

The complete persisted event stream, plus the integrity report. **Read-only:**
no spawn, no `open("/proc/...")`, no write. Two consecutive calls return a
byte-identical event fingerprint.

```json
{
  "sessionId": "exec_…",
  "status": "COMPLETED",
  "events": [ … ],
  "integrity": {
    "valid": true,
    "errors": 0,
    "warnings": 0,
    "corruptPayloads": 0,
    "summary": { "eventCount": 20, "firstSequence": 0, "lastSequence": 19, "terminalType": "execution.completed" },
    "violations": [ … ]
  },
  "result": { "exitCode": 0, "signal": null, "durationMs": 3010, "isSuccess": true, "status": "COMPLETED", "error": null }
}
```

## Events (SSE)

### `GET /api/sessions/:id/events`

Two frame types, and they mean different things:

```
id: 7
event: caps.event
data: {"id":"evt_…","sessionId":"exec_…","sequence":7,"type":"process.exited", …}

event: stream.end
data: {"sessionId":"exec_…","status":"COMPLETED","exitCode":0,"signal":null,"durationMs":3010}
```

* Only `caps.event` carries an `id:`, and that id is the canonical sequence
  within the session. A native `EventSource` therefore reconnects with a
  meaningful `Last-Event-ID`.
* `stream.end` carries **no `id:`**, so `Last-Event-ID` can only ever hold a
  sequence that exists.
* The delivery order is subscribe-with-buffer → read → send → flush, so a
  client never misses a persisted event because it connected at the wrong
  moment.
* `Last-Event-ID` is parsed only if it is a non-negative integer; anything else
  is treated as absent rather than coerced.

### `GET /api/live/stream`

The same ordering, across every session, with a bounded preload of the most
recent events.

## Terminal

### `POST /api/terminal/execute`

```json
{ "commandLine": "seq 1 2000 | head -1 2> head.err", "timeoutMs": 30000 }
```

Executes a **whole command line** rather than one command: pipelines, `2>` /
`2>>` stderr redirection, and every other redirection form in the grammar
published by `GET /api/terminal/grammar`. This is the only route that accepts
`2>`.

```json
{
  "sessionId": "exec_...",
  "stageCount": 2,
  "commands": ["seq", "head"],
  "resolvedExecutables": ["/usr/bin/seq", "/usr/bin/head"],
  "timeoutMs": 30000,
  "eventsUrl": "/api/sessions/exec_.../events"
}
```

Validation runs **first and in full**: a line with one unacceptable stage runs
nothing at all, rather than running the stages that happened to be valid. Each
stage's command is replaced by the absolute path the gateway verified before
the line reaches the engine, so the argv recorded in the event stream is that
verified path, not a name the child would resolve against its own `PATH`.

| Code | Status | When |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 400 | body shape is wrong |
| `TERMINAL_SYNTAX` | 400 | the line does not parse |
| `TERMINAL_POLICY` | 403 | a stage is refused by policy; the response names `stageIndex` |
| `CONCURRENCY_LIMIT_REACHED` | 429 | the gateway is at `maxConcurrent` |

## Control

### `POST /api/sessions/:id/terminate`

```json
{ "signal": "SIGINT" }
```

`signal` ∈ `SIGINT` (default), `SIGTERM`, `SIGKILL`, `SIGQUIT`, `SIGTSTP`.

`202` on delivery, `404` if the session is not running, `409 NOT_RUNNING` if it
is already terminal, `409 SIGNAL_FAILED` with a reason otherwise. The
delayed escalation re-verifies the target's kernel start time and refuses to
fire if the PID was recycled.

### `GET /api/processes`

The live process table, with the most recent telemetry payload for each.

## Analytics

| Endpoint | Returns |
| --- | --- |
| `GET /api/analytics/overview` | counts, percentiles, exit/signal distributions, and the telemetry aggregate |
| `GET /api/analytics/commands` | per-command baselines (durations, RSS, rates) |
| `GET /api/analytics/compare?ids=a,b` | exactly two session ids; a third is a 400, not a silent truncation |

## Export and report

### `GET /api/sessions/:id/export?format=json|csv`

An unknown `format` is a **400**, not a silent fallback to JSON. Both formats
include the integrity report.

### `GET /api/sessions/:id/report`

A Markdown observation report: the event timeline, the observed process
resources with their provenance, the lifecycle verdict (including the errno and
reason when `execvp()` failed), an explicit provenance section, and a
limitations section naming what this report cannot tell you.

## Playground and retention

| Endpoint | Purpose |
| --- | --- |
| `GET /api/playground/examples` | curated, runnable examples |
| `POST /api/retention/sweep` | run the retention sweep now; reports what it removed, and says so plainly when retention is disabled |

## Host system (`/api/system/*`)

The whole-**host** observer, which is a different subject from `/api/processes`
(that one reports CAPS-owned executions). Every figure here is read from
`/proc` or `/sys` and carries its own provenance; an absent source is
`UNAVAILABLE` with a reason, never zero. See
[`host-telemetry.md`](host-telemetry.md) and
[`observability-model.md`](observability-model.md).

| Endpoint | Returns |
| --- | --- |
| `GET /api/system/capabilities` | `subsystems[]` — each id, label, kernel source, `available`, and what it does and does not measure; `notImplemented[]` with a reason per item (measured hardware frequency, per-process network, thermal control, syscall tracing, eBPF); the sampling `cadence`; and the host `stream` limits |
| `GET /api/system/snapshot` | the current whole-host snapshot: CPU aggregate and per-core, memory, load, PSI pressure, thermal, frequency, disk, network, and collector health. **503 `NO_SNAPSHOT`** when the collector has not produced one yet |
| `GET /api/system/processes` | the host process inventory. Query `limit`, `live`, `withPss`, `state`. Also returns `pssSupported` (probed once at startup) and `pssNote`; PSS is omitted from rows that did not carry it so an absent PSS cannot be read as zero |
| `GET /api/system/processes/:identity` | one process **by identity**, not by PID. `:identity` must match `<pid>@<startTicks>#<bootId>`; a bare PID is a **400**, because a PID alone is not an identity — it is reused. **404 `PROCESS_NOT_FOUND`** when no live process currently holds it, which means either it exited or its PID was taken by a different process. Re-reads procfs at request time and settles ownership and the parent link against the same context the list route uses, so one identity cannot answer differently in two views |
| `GET /api/system/thermal` | thermal zones and hwmon devices with their own `type` and `label`, plus `absentReason`. Nothing is written to sysfs |
| `GET /api/system/frequency` | cpufreq policy and per-frequency data, plus `absentReason`. Policy and governor figures only; no hardware frequency is measured |
| `GET /api/system/analytics` | time-window aggregates over persisted host samples: per metric, `mean`, `percentiles`, and `series`, each reporting how many samples carried a value and how many did not. Also the retention policy in force, what a sweep deletes, and what it never deletes |
| `GET /api/system/health` | collector health, identity (`bootId`, sample counts), current stream subscriber count, storage stats, `pssSupported`, and the cadence |
| `GET /api/system/stream` | the host telemetry SSE stream. Subscribe-then-read with delivery paused, so no event published during the backlog read is lost; `Last-Event-ID` resumes. **503 `STREAM_LIMIT_REACHED`** past the permitted client count |
| `POST /api/system/retention/sweep` | run the **host** sweep now. Body `{ "olderThanHours": 24 }`; returns the cutoff, what was removed, and the storage stats afterwards |

## Catalog

Every allowlisted command with its **probed** state and its live argument
schema. This is the source a client should read to know what a command accepts
rather than hard-coding a second list.

| Endpoint | Returns |
| --- | --- |
| `GET /api/catalog` | `summary`, `trustedDirectories` (where a command may be resolved from, in order), every `command` entry, the published `grammar` (`supported[]` and `notSupported[]`, each with a reason, plus the parser limits: 16 stages, 4096 arguments per stage, 20000 token bytes, 65536 line bytes), and `refusedByPolicy` |
| `GET /api/catalog/:name` | one command's probed entry: resolved path, availability, and its argument schema. **404** for an unknown name |
| `GET /api/catalog/:name/help` | the generated help for one command, including why an argument is refused |
| `GET /api/catalog/help` | generated help for every command |
| `GET /api/catalog/categories` | the commands grouped by category |

## Terminal validation

| Endpoint | Returns |
| --- | --- |
| `POST /api/terminal/validate` | parses and policy-checks a command line **without running it**: `valid`, `stageCount`, and per stage the `index`, `command`, `argv`, `resolvedExecutable` with its `resolutionNote`, `redirections`, `stdinSource`, `stdoutDest`, plus the effective `limits`. Refusals keep the execute route's codes: **400 `TERMINAL_SYNTAX`**, **403 `TERMINAL_POLICY`** with `stageIndex` and a `hint` for a well-known-but-forbidden command. This is the same validation `POST /api/terminal/execute` runs first, so what it accepts is what execution will accept |
| `GET /api/terminal/grammar` | the published grammar on its own, for an editor or autocomplete |
