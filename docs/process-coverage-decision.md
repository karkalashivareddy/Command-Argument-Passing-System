# Process coverage decision

## Tracking contract

CAPS observes the process IDs it directly creates and reports in
`process.started`: one process for a command, or one process per stage for a
pipeline. The gateway samples each reported process independently and verifies
its `/proc` parent PID and start time against the CAPS engine event. A pipeline
stage is not treated as a descendant of another stage; all stages are direct
children of CAPS and share the process group reported by the C engine.

Processes forked by a command are outside the tracking contract. CAPS does not
promise complete process-tree coverage, and process-group membership is a
lifecycle/signal property, not evidence that every process in the group was
observed. The bounded `caps_fork_tree` workload demonstrates this limit.

## Design alternatives

| Design | What it can establish | Races and limits | Decision |
| --- | --- | --- | --- |
| Track the one direct child | Exact `fork`/`exec`/`waitpid` lifecycle and `/proc` samples for a single command. | It does not cover a pipeline with more than one direct child unless each reported PID gets its own sampler. Forked descendants are invisible. | Keep as the single-command case. |
| Discover descendants through `/proc` | Best-effort parent/child relationships from PID, PPID, and start time while entries remain readable. | Scans race with short-lived children, PID reuse, reparenting, permissions, and namespace visibility. A child that exits between scans may never be seen; a reparented child may no longer be attributable. It cannot prove complete coverage. | Do not implement as a complete-monitoring feature. Any future prototype must say best effort and attach source/confidence to each edge. |
| Use process groups for lifecycle | Signal the known pipeline group as one unit; process-group membership is useful for pipeline cancellation. | A process may leave its original group. Group IDs are numeric and do not independently pin identity. Group membership does not provide per-process telemetry or establish parentage. | Keep for pipeline lifecycle. Do not infer descendant coverage from it. |
| Use cgroups for workload accounting | Kernel accounting and bulk cleanup for processes that remain in the workload cgroup; v2 controllers can expose resource and pressure data. | Availability and delegation vary by host, systemd configuration, containers, and kernel. A process may escape unless migration/creation permissions and policies are controlled. It is extra isolation/accounting infrastructure and does not replace event-level `exec` evidence. | Out of scope under the documented local single-user model. Revisit only with an explicit supported-host contract and tests. |
| Use Linux pidfds | Stable references to individual processes for waiting/signalling where supported; CAPS capability-probes the helper and records the mechanism used. | A pidfd refers to one process, not a process tree or process group. It does not discover short-lived children and requires runtime kernel support. The gateway retains a start-time-checked fallback when unavailable. | Keep for individually tracked process identity and delayed signalling. Do not claim tree coverage from it. |

## Relationship evidence and confidence

For each tracked command process, the `process.started` event from CAPS is the
source of the PID and pipeline stage. A procfs snapshot is accepted only when
the process start time is consistent with that event and `/proc/<pid>/stat`
reports the gateway-spawned CAPS PID as PPID. That confirms the direct
CAPS-to-stage relationship for the sample. Pipeline membership comes from the
CAPS-reported process-group ID; it does not imply a parent/child edge between
stages. No relationship is emitted for a descendant that CAPS did not report.

If procfs is missing, unreadable, or inconsistent, telemetry is unavailable
with a reason and sampling for that PID stops. The gateway does not substitute
zeroes or follow a recycled PID. Persisted telemetry remains part of the
canonical event history, so replay uses the same per-PID evidence as live views.

## Platform assumptions

The engine requires a POSIX/Linux process model. Per-process telemetry requires
readable procfs entries; host telemetry additionally probes available procfs
and sysfs sources. pidfd support is detected at runtime and is not assumed from
a fixed kernel version. CAPS does not require cgroups and does not claim
container or sandbox isolation. WSL2 is a Linux guest environment and reports
guest-kernel values.

See [the observability model](observability-model.md) for the public scope and
[the architecture](architecture.md) for lifecycle and event ordering.
