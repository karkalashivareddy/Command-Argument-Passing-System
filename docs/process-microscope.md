# Process microscope

CAPS exposes one execution-scoped Linux child, not an operating-system-wide process table. Procfs reads are tied to the child PID from CAPS `PROCESS_STARTED`; the gateway has no arbitrary-PID inspection API. A sample is accepted only when the child PPID matches the gateway-spawned CAPS process and the PID start ticks remain stable.

| Field | Availability |
| --- | --- |
| Child PID | Available after `PROCESS_STARTED` |
| CAPS engine PID | Observed from the gateway's `child_process.spawn` result |
| Parent PID / PPID | Observed from `/proc/<pid>/status`; graph edge appears only when it matches the CAPS engine PID |
| Linux session ID / SID | Observed from `/proc/<pid>/stat` |
| Process group ID | Observed from `/proc/<pid>/stat` |
| Kernel state / command name | Observed from `/proc/<pid>/stat` |
| Working directory | Known to gateway configuration, but not currently recorded per process |
| Engine duration | Available on `PROCESS_EXITED` |
| Live duration | Gateway wall clock elapsed estimate while session is active |
| Start time / elapsed | Derived from `/proc/<pid>/stat` start ticks and `/proc/uptime` |
| User/system CPU time | Derived from procfs tick counters using Linux `getconf CLK_TCK` |
| RSS / virtual memory / thread count / context switches | Observed from `/proc/<pid>/status` |
| CPU utilization | Derived from two valid CPU time samples and monotonic sample elapsed time |
| File descriptors | Unavailable; not collected |

The sampler reads immediately after `PROCESS_STARTED`, then every 500 ms, and stops on `process.exited` or `process.exec_error`. Procfs failures are represented by a null value, `UNAVAILABLE` provenance, and a reason. Each snapshot is stored as `process.snapshot`, so history and replay use recorded data instead of rereading `/proc`.

The process graph shows the CAPS parent only when the observed child PPID matches the gateway-spawned CAPS PID. The target appears once; `execvp()` replaces the child image without changing its PID and is not rendered as a second process. A close-on-exec status pipe identifies actual `execvp()` errors. A later ordinary process exit supports a derived successful-exec state; if a signal arrives, the UI leaves the exec outcome unavailable because termination may have preceded exec.
## Execution-scoped identity, and why a PID is not an identity

The microscope identifies a process by `sessionId + pid + processStartTime`, not
by PID:

- **Session scope.** A selection belongs to one execution. Opening a different
  session clears the selection, and the correlation layer refuses an identity
  whose session does not match, so a stale process can never be presented as if it
  belonged to the session on screen.
- **Start-time guard.** The kernel start time is derived from `/proc/<pid>/stat`
  field 22 anchored to `/proc/stat` `btime` and the clock-tick rate. It is a
  pure function of kernel values, so it is the same string for every sample of one
  process. Two processes that share a PID therefore compare unequal, and a
  recycled PID is refused rather than silently matched.
- **Degradation is stated, never hidden.** When a process genuinely has no derived
  start time - the gateway-spawned CAPS engine, which is never procfs-sampled - the
  match falls back to session + PID and the UI reports `session+pid` rather than
  implying a full match.
- Sample filtering applies PID *and* start time together. Selecting a process can
  never show another process's numbers as its own, even transiently between two
  samples.

## Unavailable stays unavailable

A field the kernel did not report is shown as `UNAVAILABLE` with the backend's
own reason, and is never rendered as `0`:

| Situation | What the UI shows |
| --- | --- |
| First sample of a session, any rate | `UNAVAILABLE` - a rate needs two valid samples separated by a measured interval |
| Gateway-spawned CAPS engine | No resource values at all; a structural node, with the reason stated under the legend |
| procfs entry gone, or permission denied | `UNAVAILABLE` with the kernel-side reason |
| Working directory, file descriptors | `UNAVAILABLE` - not collected |
| Field absent from a stored snapshot | `UNAVAILABLE`, and the rest of the view still renders |

## One process evidence, two views

The 3D process space and the 2D inspector are two renderings of the same
identity, resolved by the same pure correlation layer and driven by the same
execution-time cursor. Selecting a process in either view selects the same
identity in the other, and both show the same sample at the same cursor. The 3D
shell reuses this same component rather than rebuilding an inspector, so the two
cannot disagree.

## Scope of what is observed

The microscope observes the **one execution-scoped Linux child** CAPS creates, plus
the gateway-spawned CAPS process itself. It is not an operating-system-wide process
table, and this project does not implement eBPF, cgroup, syscall-level, network or
host-wide observability. Descendants created by that child are not sampled, so the
topology is a chain and the limits are stated on screen. `execvp()` replaces the
child image without changing its PID, so it is a transition on the same identity
and is never rendered as a second process.