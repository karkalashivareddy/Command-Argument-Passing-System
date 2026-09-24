# Future roadmap

CAPS should add measurement only when it can preserve source, scope, and failure semantics.

1. **Current:** C process lifecycle events, structured argv gateway, SQLite history, SSE recovery, replay, and tracked-PID `/proc` snapshots.
2. **Current release:** PID-scoped state, PPID, process group/session, RSS, virtual size, CPU time/utilization, threads, and context-switch snapshots.
3. **Current observability platform:** flight-recorder resource curves (RSS + CPU over time), lifecycle event annotations, replay-cursor synchronization across panels, peaks & moments cards, event-type filtering, per-session sequence integrity, per-command baselines, two-session comparison, JSON/CSV export, and a Markdown observation report. All values stay `OBSERVED | DERIVED | UNAVAILABLE`; every visualization reads the persisted event store and never re-executes.
4. **Richer process topology:** observe descendants and group membership after the engine defines ownership, lifetime, and signal-delivery semantics. The current graph contains only the CAPS process and its directly observed child.
5. **Pipes and IPC labs:** implement bounded, tested descriptor graphs in the C execution path.
6. **Syscall-level teaching:** use a dedicated tracing mode with explicit overhead and platform limits; do not infer syscalls from high-level events.
7. **eBPF:** optional Linux-only collector after privilege requirements and kernel compatibility are designed.
8. **Container/cgroup experiments:** attach telemetry to explicit cgroup scope and document namespace identity.
9. **Multi-host observability:** defer until transport authentication, identity, tenancy, and threat model are designed.
