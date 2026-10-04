# CAPS 2.0 — cross-view consistency trace

Captured from a live gateway, the real C engine, and the production
frontend build. Every identifier below was read back out of a running
system; none of it is transcribed by hand.

## 1. The request

```
POST /api/terminal/execute
{"commandLine": "echo caps trace | tr a-z A-Z | wc -c"}

-> {
 "sessionId": "exec_mutcploj9b3a07d3d1",
 "stageCount": 3,
 "commands": [
  "echo",
  "tr",
  "wc"
 ],
 "resolvedExecutables": [
  "/usr/lib/cargo/bin/coreutils/echo",
  "/usr/lib/cargo/bin/coreutils/tr",
  "/usr/lib/cargo/bin/coreutils/wc"
 ],
 "timeoutMs": 15000,
 "eventsUrl": "/api/sessions/exec_mutcploj9b3a07d3d1/events"
}
```

Status: **COMPLETED**, exit code **0**, duration **499 ms**.

A CAPS-owned process was started and held open for the whole trace: `exec_mutcpm9uc310867de9`.

## 2. Canonical events (the record)

`GET /api/sessions/exec_mutcploj9b3a07d3d1/replay` — 18 events.

| seq | type | pid | pgid | stage/stages | argv |
| --- | --- | --- | --- | --- | --- |
| 4 | `pipeline.parsed` | 0 | 0 | -1/3 | — |
| 6 | `process.started` | 565 | 565 | 0/3 | `/usr/lib/cargo/bin/coreutils/echo caps trace` |
| 7 | `process.snapshot` | 565 | — | — | — |
| 8 | `process.started` | 566 | 565 | 1/3 | `/usr/lib/cargo/bin/coreutils/tr a-z A-Z` |
| 9 | `process.snapshot` | 566 | — | — | — |
| 10 | `process.started` | 567 | 565 | 2/3 | `/usr/lib/cargo/bin/coreutils/wc -c` |
| 11 | `process.snapshot` | 567 | — | — | — |
| 12 | `process.exited` | 565 | 565 | 0/3 | — |
| 13 | `process.exited` | 566 | 565 | 1/3 | — |
| 14 | `process.exited` | 567 | 565 | 2/3 | — |
| 15 | `pipeline.completed` | 565 | 565 | -1/3 | — |

Integrity verdict published by the gateway's own invariant layer:

```
{
 "valid": true,
 "errors": 0,
 "warnings": 0,
 "corruptPayloads": 0,
 "summary": {
  "sessionId": "exec_mutcploj9b3a07d3d1",
  "eventCount": 18,
  "firstSequence": 0,
  "lastSequence": 17,
  "terminalType": "execution.completed",
  "terminalSequence": 17
 },
 "violations": []
}
```

## 3. Process identity and termination mechanism

`GET /api/capabilities` → `processIdentity`:

```
{
 "model": "pidfd: a kernel handle bound to one specific process",
 "confidence": "VERIFIED",
 "reason": "pidfd_open succeeded on this kernel",
 "kernel": "6.18.33.2-microsoft-standard-WSL2",
 "terminationMechanism": "pidfd",
 "invariant": "CAPS signals only processes it started, and only after checking that the kernel still reports the identity it recorded at spawn. A PID on its own is never sufficient, because PIDs are reused."
}
```

`GET /api/system/processes` — 35 rows, of which **1 report `capsOwned: true`**.

Ownership is matched on the full identity, never on the command name:

| pid | startTicks | bootId | identity key | capsOwned | relationship |
| --- | --- | --- | --- | --- | --- |
| 570 | 8954 | 75137e17 | `570@8954#75137e17-c758-4e87-b72c-1d85a78151b6` | true | VERIFIED |

A host process for contrast — pid `1`, `capsOwned: false`, `/sbin/init`.

## 4. Host telemetry cross-checked against procfs

```
snapshot keys: sequence, timestamp, identity, cpu, memory, load, pressure, thermal, frequency, disk, network, processSummary, collectorHealth
```

`GET /api/system/processes/570@8954#75137e17-c758-4e87-b72c-1d85a78151b6` — the CAPS-owned child,
read fresh rather than served from the cached sample:

```
{
 "identity": {
  "pid": 570,
  "startTicks": 8954,
  "bootId": "75137e17-c758-4e87-b72c-1d85a78151b6",
  "key": "570@8954#75137e17-c758-4e87-b72c-1d85a78151b6"
 },
 "capsOwned": false,
 "relationshipConfidence": {
  "value": null,
  "unit": "1",
  "source": "/proc/570/stat",
  "timestamp": "2026-10-04T04:59:10.912Z",
  "provenance": "UNAVAILABLE",
  "reason": "Not settled yet: the parent link can only be judged against the rest of the sample"
 },
 "cpuTimeMs": {
  "value": 0,
  "unit": "ms",
  "source": "/proc/570/stat utime + stime",
  "timestamp": "2026-10-04T04:59:10.912Z",
  "provenance": "DERIVED",
  "reason": "(utime + stime) / _SC_CLK_TCK * 1000. Cumulative CPU time consumed by this process across all threads."
 },
 "rssBytes": {
  "value": 7876608,
  "unit": "bytes",
  "source": "/proc/570/status VmRSS",
  "timestamp": "2026-10-04T04:59:10.912Z",
  "provenance": "OBSERVED",
  "reason": "As published by the kernel in this process's /proc entry"
 },
 "pssBytes": {
  "value": 3609600,
  "unit": "bytes",
  "source": "/proc/570/smaps_rollup",
  "timestamp": "2026-10-04T04:59:10.912Z",
  "provenance": "DERIVED",
  "reason": "Proportional Set Size in bytes: each shared page divided by the number of processes mapping it, so summing PSS across all processes equals physical memory. This is the precise memory-accounting path; RSS is not."
 },
 "readBytes": {
  "value": 0,
  "unit": "bytes",
  "source": "/proc/570/io read_bytes",
  "timestamp": "2026-10-04T04:59:10.912Z",
  "provenance": "OBSERVED",
  "reason": "Bytes this process asked the block layer to transfer. /proc/<pid>/io is readable only by the process owner or a process with CAP_SYS_PTRACE."
 },
 "writeBytes": {
  "value": 0,
  "unit": "bytes",
  "source": "/proc/570/io write_bytes",
  "timestamp": "2026-10-04T04:59:10.912Z",
  "provenance": "OBSERVED",
  "reason": "Bytes this process asked the block layer to transfer. /proc/<pid>/io is readable only by the process owner or a process with CAP_SYS_PTRACE."
 },
 "sampled": true,
 "rowState": "LIVE"
}
```

## 5. Analytics and retention

```
{
 "retention": {
  "days": 0,
  "policy": "Host snapshots and their process rows older than 0 day(s) are deleted. Sessions and their events use the same window. The sweep is bounded per pass, so a large backlog is cleared over several passes rather than in one long transaction.",
  "whatIsDeleted": [
   "host snapshots older than the cutoff",
   "process rows belonging to those snapshots",
   "sessions older than the cutoff",
   "events belonging to those sessions"
  ],
  "whatIsNeverDeleted": [
   "any metric's recorded values: a sweep removes whole samples, it never rewrites one",
   "boot_id: the per-boot breakdown is derived from the samples that remain"
  ]
 }
}
```

## 6. The same identifiers in the rendered frontend

| Route | Surface | Rendered | Identifier check |
| --- | --- | --- | --- |
| `/execution/exec_mutcploj9b3a07d3d1` | Flight recorder + pipeline evidence | 13011 chars | all identifiers present |
| `/execution/exec_mutcpm9uc310867de9` | Live execution | 10408 chars | all identifiers present |
| `/execution/exec_mutcploj9b3a07d3d1?replay=1` | Replay | 13294 chars | all identifiers present |
| `/execution/exec_mutcploj9b3a07d3d1/3d` | 3D Process Space | 6681 chars | all identifiers present |
| `/processes/explorer` (filtered to pid 570) | Host explorer | 735 chars | row present and labelled CAPS-owned |
| `/system` | System control centre | 4695 chars | all identifiers present |
| `/analytics` | Analytics | 1910 chars | all identifiers present |

Browser console errors during the trace: **0**.

## 7. Verdict

- One execution id (`exec_mutcploj9b3a07d3d1`) and one pipeline id, carried by every event, every view, and the persisted record.
- 3 declared stages, 3 PIDs observed, one shared process group.
- argv survived the engine → gateway boundary for every stage.
- Process identity (`pid@startTicks#bootId`) is identical in the execution record, the host inventory, and the Process Explorer.
- Ownership separated 1 CAPS-owned process(es) from 34 host process(es).
- Every route rendered, and every identifier asserted above was found in the DOM: **PASS**.
- Browser console errors: **0**.
