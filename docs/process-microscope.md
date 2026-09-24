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
