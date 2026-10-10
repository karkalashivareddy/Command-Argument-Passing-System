# Controlled workload lab

CAPS ships five first-party C workloads. They exist so the observatory has
something **real and bounded** to observe: every number the UI shows comes
from the kernel reading `/proc/<pid>` for a process CAPS actually forked and
`execvp()`'d. Nothing is simulated, estimated, or back-filled.

```
workloads/workload_common.h   shared bounds, deadlines, stop handlers
workloads/caps_cpu_burn.c     sustained arithmetic on one core
workloads/caps_memory_burn.c  page-touching anonymous mapping
workloads/caps_io_burn.c       bounded file I/O in a private workspace
workloads/caps_mixed_burn.c    all three interleaved for one PID
workloads/caps_fork_tree.c     bounded parent -> children -> grandchild
```

## Build and test

```bash
make workloads            # build build/workloads/caps_*
make test-workloads       # 60 assertions against the real binaries
make test-workloads-asan  # same suite under ASan + UBSan (leak detection on)
```

Both `make` and `make test-workloads` are wired into the default flow. ASan
matters most here: each workload owns a temporary workspace, and the memory
and mixed workloads own an anonymous mapping, so a leak would be a real bug.

## Usage

| Workload | Arguments | What it makes observable |
| --- | --- | --- |
| `caps_cpu_burn` | `[seconds]` | `cpuUserMs`, `cpuSystemMs`, `cpuPercent` |
| `caps_memory_burn` | `[seconds] [mib]` | `rssBytes`, `virtualMemoryBytes`, `minorFaults` |
| `caps_io_burn` | `[seconds] [mib]` | `rcharBytes`, `wcharBytes`, `readBytes`, `writeBytes` |
| `caps_mixed_burn` | `[seconds] [mib] [io-mib]` | CPU, RSS, and I/O correlated on one PID |
| `caps_fork_tree` | `[seconds] [children]` | fork activity of ONE tracked process |

Omitted trailing arguments fall back to the binary's own default, which is
the same default the gateway materializes. Run any binary with no arguments
to see its defaults.

## Safety envelope

These are hard ceilings, enforced in three independent places: the C
constants, the C argument parser, and the gateway catalog. A bug in one layer
still cannot run an unbounded workload.

| Bound | Value | Constant |
| --- | --- | --- |
| Duration | 1..30 s | `CAPS_WL_MIN_DURATION_S`, `CAPS_WL_MAX_DURATION_S` |
| Resident target | 1..256 MiB | `CAPS_WL_MAX_MEMORY_MIB` |
| Workspace I/O | 1..64 MiB total written | `CAPS_WL_MAX_IO_MIB` |
| Fork children | 1..4 | `CAPS_WL_MAX_FORK_CHILDREN` |
| stdout per run | a few status lines | checked by the test suite |

No workload uses a shell, opens a socket, touches `/dev`, writes outside its
own temporary directory, or spawns an unbounded number of processes. Output
is bounded to a few hundred bytes.

### Workspace confinement

`caps_io_burn` and `caps_mixed_burn` write to a workspace they create
themselves with `mkdtemp()` under `$TMPDIR` (falling back to `/tmp`). The
path is **never** taken from `argv`, so no traversal is expressible. The
whole tree is removed on every exit path, including signal delivery, and the
test suite asserts that no `caps-io-*` or `caps-mixed-*` directory is left
behind.

### Signals

Every workload installs handlers for `SIGINT` and `SIGTERM` and exits with
the documented stop code `4` (see `CAPS_WL_EXIT_STOPPED`). An unhandled
signal death is a test failure, because the gateway would otherwise record
it as a crash rather than a clean stop.

## Gateway integration

`web/backend/src/execution/workloadCatalog.ts` is the single source of truth
for the profiles, and its bounds mirror `workload_common.h` exactly.

- **Paths are never client-supplied.** Each profile resolves to
  `build/workloads/<id>`, derived from the fixed id.
- **Availability is probed, not assumed.** `available` is the result of a
  real `access(X_OK)` + `isFile()` check, reported with
  `availabilityProvenance: "OBSERVED"`. A missing binary yields
  `available: false` plus the reason `binary not found or not executable
  (run: make workloads)` — the UI shows that instead of failing at spawn
  time.
- **Arguments are strictly positional.** `3.5`, `1e3`, `0x10`, `+3`, ` 3`,
  `3s`, and extra arguments are all rejected with `400` before anything is
  spawned. This keeps the gateway parser and the C `strtol` parser from ever
  disagreeing.
- **The transport timeout must exceed the runtime budget.** Requesting a 20 s
  workload with `timeoutMs: 1000` is rejected with `TIMEOUT_TOO_SHORT`,
  because otherwise the sample series would be cut off before the workload
  ended on its own.

## What the I/O counters really mean

`/proc/<pid>/io` exposes two different families, and the gateway reports both
without pretending they are the same thing:

- `rcharBytes` / `wcharBytes` (kernel `rchar`, `wchar`) count bytes moved through the
  syscall layer. A real read/write loop always moves them.
- `readBytes` / `writeBytes` count bytes that reached a block device. While
  the page cache absorbs writes these legitimately stay `0`.

So a green `caps_io_burn` run shows `wchar` in the megabytes and possibly
`write_bytes: 0`. That is not a missing metric; it is the kernel telling the
truth about where the data went. The test suite asserts on the character
counters and reports the block counters for information.

## Observability contract

This is the part worth being precise about, because it is where a workload
description can start promising more than the observatory delivers.

`execvp()` keeps the same PID, so it changes the program without changing the
process identity. That transition **is** observable: the record shows the
command image before and after it, on the same node.

`fork()` gives each new process a new PID, and the gateway **does not
discover it**. The telemetry sampler follows each direct PID CAPS reports in
`PROCESS_STARTED` (one for a command, one per pipeline stage); nothing walks
`/proc` looking for unreported descendants. So:

* `caps_fork_tree` demonstrates **fork activity of one tracked process**: the
  parent performs a bounded, deterministic number of forks and reaps them, and
  the observatory reports the tracked process's own CPU time, page faults, and
  lifetime across that activity.
* It does **not** make descendants observable. There is no node, no edge, and
  no metric for any process the child created.
* The fork count and the reaping are visible to the workload's own test suite,
  which reads `/proc` directly and asserts the topology exists at the kernel
  level. That is a test of the C program, not a gateway capability.

Each profile therefore carries an explicit `observationScope` in
`web/backend/src/execution/workloadCatalog.ts`, stating both what is sampled
and what is not, and `/api/capabilities` publishes it so the UI cannot imply
coverage the sampler does not provide.

## Out of scope

eBPF, cgroup accounting, syscall tracing, and network I/O are **not**
collected. `/api/capabilities` states this explicitly under
`telemetry.notCollected` rather than implying the coverage exists.
