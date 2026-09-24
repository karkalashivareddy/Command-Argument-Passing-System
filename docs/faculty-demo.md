# Faculty demonstration guide

The demo route provides curated examples. The following sequence explains the current implementation without claiming telemetry it does not collect.

## 1. Argument passing

Run `echo Hello Shiva` from the execution form. Open the argument inspector to see the request's `argv[]` entries and its NULL terminator. Web input is already structured as `command` plus `args`; it does not pass through CAPS's interactive tokenizer.

## 2. Process lifecycle

Run `sleep 10`. The recorder reports the real target PID, verifies its PPID against the gateway-spawned CAPS PID, and streams `/proc` snapshots at a 500 ms backend interval. State, RSS, virtual memory, threads, context switches, and CPU time carry observed/derived labels. CPU utilization appears only after successive valid samples.

## 3. Signal

Open Signals, start `sleep 30`, then send SIGINT. The event stream records the observed signal and process result. Status `128 + signal` is a shell-style interpretation used by CAPS, not a status value returned by the kernel as a single integer.

## 4. Redirection

Use the redirection lab with a workspace-relative target. CAPS performs the actual `open()`, child `dup2()`, and `close()` setup before exec. The monitor event confirms open success or failure; the descriptor operations themselves are guaranteed by the inspected engine path, not individual syscall events.

## 5. Exit 127 distinction

The allowlisted `status_probe exit 127` integration helper demonstrates a program that started and exited 127. A missing executable name is denied by the web allowlist before fork, so it cannot produce a gateway `EXEC_ERROR`; the C monitor integration test verifies that path directly.

## 6. Replay and analytics

Open a completed execution and use replay. It traverses SQLite-backed process events and procfs snapshots; it does not rerun the command or read live procfs. Analytics aggregates terminal sessions and stored snapshots and shows its sample counts.

For what is measured and what remains unavailable, see [the observability model](observability-model.md).
