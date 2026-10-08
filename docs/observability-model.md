# CAPS observability model

CAPS records lifecycle facts emitted by its C monitor and adds a gateway
envelope for transport and persistence. A visualization must keep those sources
distinguishable, and it must never show a value the kernel did not report.

## Canonical statement: what CAPS observes, and what it does not

This section is the single reference. `README.md` and the API responses repeat
it; where another document disagrees, this one is correct.

### Observed

* the exact `fork()` → `execvp()` → `waitpid()` lifecycle of one command;
* the argv the executed program actually received;
* the exit code, the terminating signal, or — when `execvp()` never succeeded —
  the errno, the 126/127 status, and a machine-readable reason;
* the target's own stdout, verbatim, and its stderr, line-classified;
* per-sample `/proc/<pid>/{stat,status,io}` telemetry for **one** PID: the one
  CAPS reported in `PROCESS_STARTED`.

### Not observed

* **Descendants of the tracked process.** The sampler follows a single PID and
  discovers nothing else. There is no process tree, no sibling discovery, and
  no per-descendant metric. `caps_fork_tree` therefore demonstrates fork
  *activity of one tracked process*; the descendant topology exists at the
  kernel level and is asserted by that workload's own C test, but the gateway
  never sees it.
* **Syscall traces, eBPF probes, and cgroup accounting.** Only kernel-exposed
  procfs counters are read.
* **Network I/O.** `/proc/<pid>/io` is not per-device, and no socket counter is
  collected.
* **A file-descriptor census.**
* **The low-level `open`/`dup2`/`close` events behind a redirection.** Redirection
  *is* supported — `<`, `>`, `>>`, `2>`, `2>>`, on a single command or on one
  stage of a pipeline — and the engine reports `REDIRECTION_OPENED` and
  `REDIRECTION_FAILED` for it. What is not modelled is the descriptor-level
  syscall trail underneath: nothing below the `open`/`dup2` pair is observed.
* **Any metric on a PID other than the sampled one.**

### The one output-channel caveat

CAPS diagnostics and the executed program's stderr share a single file
descriptor, because the child inherits it. They are separated **line-wise**,
not at descriptor level: the classification is exact for CAPS's own lines
(every one begins with `caps: ` or is a monitor JSON object) and a best effort
for the target's. Every `/api/sessions/:id/output` response states this rather
than implying a clean split.

## Sources and confidence

| Displayed value | Source | Meaning |
| --- | --- | --- |
| Command and argument vector | Validated gateway request | `command` and `args` arrive as separate fields; web execution does not tokenize a raw shell command line. The child's `argv[0]` is the gateway's **verified absolute path**, not the allowlist name. |
| Child PID | `process.started` from CAPS | PID of the child created by `fork()`. |
| Exit code / signal | `process.exited` and `signal.received` | Interpreted from the raw `waitpid()` status by the C engine, with an explicit `outcome`. A signal exit uses shell-style `128 + signal` as an application convention. |
| Exec failure | `process.exec_error` | Emitted when `execvp()` never succeeded. Carries `exit_code` (126 or 127), `errno`, `errno_name`, and a stable `reason`. A close-on-exec status pipe is what lets CAPS distinguish a real exec failure from an application that exits 126 or 127 by itself. |
| Wait failure | `process.wait_failed` | A permanent `waitpid()` failure. The outcome is genuinely unknown, and is reported as such rather than guessed. |
| Duration | `CLOCK_MONOTONIC` in CAPS | Milliseconds measured from process launch through reap. |
| Event timestamp | Gateway receive time | Wall clock when the gateway reads the monitor event; not a kernel timestamp. |
| Event sequence | Gateway per-session counter | Contiguous from 0, one terminal event, terminal last. Used by SQLite and by SSE resume. |
| Linux PID | `process.started` from CAPS | Actual child PID; procfs snapshots are restricted to this PID while the execution remains tracked. |
| CAPS engine PID | Node `child_process.spawn` result | Gateway-observed Linux PID of the CAPS monitor. A process-tree edge is shown only when the observed PPID matches it. |
| PPID, process group, SID, command name, state | `/proc/<pid>/stat` and `/proc/<pid>/status` | Kernel-exposed attributes read for the tracked PID; start ticks are checked to reject PID reuse. |
| RSS, virtual size, threads, context switches | `/proc/<pid>/status` | **OBSERVED.** Missing entries, fields, or permissions yield `UNAVAILABLE` with a reason, never zero. |
| User/system CPU time | `/proc/<pid>/stat` utime/stime | Tick counters converted with `getconf CLK_TCK`; **DERIVED**, because the conversion is not a single procfs field. If the tick rate cannot be read, both values are unavailable. |
| Start time and elapsed time | `/proc/<pid>/stat` start ticks plus `/proc/uptime` and `btime` | **DERIVED.** The identity value is `btime + startTicks/CLK_TCK`, a pure function of kernel values that is stable for the life of the process. |
| CPU utilization | Two valid CPU-time samples and the monotonic sampler interval | **DERIVED.** The first sample is unavailable; a counter that *decreases* between samples is also unavailable, because a decrease means the identity changed rather than that nothing was measured. A multithreaded process can exceed 100%. |
| Block-device I/O | `/proc/<pid>/io` read_bytes/write_bytes | **OBSERVED.** Legitimately `0` while the page cache absorbs the write; that is the kernel telling the truth, not a missing metric. |
| Character I/O | `/proc/<pid>/io` rchar/wchar | **OBSERVED.** Counts characters passed to `read()`/`write()` including page-cache hits. These are not disk throughput and are never presented as such. |

`GET /api/capabilities` publishes this classification per metric
(`observedMetrics`, `derivedMetrics`, `gatewayMetrics`, `metricProvenance`), so
no client has to infer it.

## Event path

```
Browser -> Gateway : POST structured command + args
Gateway -> CAPS    : spawn argv (shell:false, absolute verified path)
CAPS    -> Gateway : JSON monitor event on stderr
Gateway -> SQLite  : persist normalized event and sequence
Gateway -> Browser : SSE caps.event frame
Browser -> Gateway : reconnect with Last-Event-ID (a real session sequence)
Gateway -> Browser : replay persisted events after that sequence
```

The event store is the history of record. The event inspector shows the
canonical envelope, not a byte-for-byte copy of the original C line.

The SSE handler subscribes with a buffer **before** it reads the store, then
sends the backlog, then flushes the buffer. A client therefore never misses a
persisted event because it connected at the wrong moment. See
[architecture.md](architecture.md#5-sse-delivery-order).

## Out of scope today

No syscall tracer and no independent successful-`execvp()` acknowledgement
event; exec success is reported through the `outcome` field of the exit event.
The `/proc` sampler is scoped to registry-owned CAPS children, reads
immediately after `process.started`, then every 500 ms, and stops on the
observed child's exit, exec error, or the execution's finalization. Each
`process.snapshot` is persisted before SSE publication; replay reads the stored
snapshot events with no re-execution and no live procfs access. Before
sampling, the gateway verifies that the child's observed PPID matches the CAPS
PID returned by its own spawn call and that its start ticks stay constant.

## References

* POSIX [`wait()` / `waitpid()`](https://pubs.opengroup.org/onlinepubs/9699919799/functions/wait.html) — the parent obtains status for its child process.
* Linux [`fork(2)`](https://man7.org/linux/man-pages/man2/fork.2.html), [`execve(2)`](https://man7.org/linux/man-pages/man2/execve.2.html), [`waitpid(2)`](https://man7.org/linux/man-pages/man2/waitpid.2.html) — process creation, image replacement, reaping.
* Linux [`/proc/<pid>/stat`](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html) — the identity and state fields CAPS reads, including field 22 (`starttime`) used for PID-reuse detection.
* Linux [`/proc`](https://man7.org/linux/man-pages/man5/proc.5.html) — `io`, `status`, and the `btime` line in `/proc/stat`.
* OpenTelemetry [process attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/process/) — established names for `process.pid`, `process.parent_pid`, and `process.state`.
* UI concepts were reviewed from [Microsoft Process Monitor](https://learn.microsoft.com/sysinternals/downloads/procmon), [htop](https://github.com/htop-dev/htop), [`strace(1)`](https://man7.org/linux/man-pages/man1/strace.1.html), and [Grafana Live](https://grafana.com/docs/grafana/latest/setup-grafana/set-up-grafana-live/): inspectable events, process trees, filtering, syscall evidence, and event-driven updates. CAPS borrows these interaction concepts without claiming their broader telemetry.
