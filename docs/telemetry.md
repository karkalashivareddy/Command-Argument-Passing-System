# Process telemetry

How the observatory measures a real process, what each number means, and what it
deliberately does not collect.

## Layering

```
src/telemetry/types.ts        snapshot contract, metric keys, categories
src/telemetry/collector.ts    reads /proc/<pid>/{stat,status,io} + /proc/uptime
src/telemetry/derive.ts       cpuPercent, I/O rates, fault rates
src/telemetry/sampler.ts      one loop per reported PID, identity checks, lifecycle
src/telemetry/capabilities.ts /api/capabilities metadata, derived from the collector
src/execution/runner.ts       launch, events, persistence — never parses procfs
```

The runner owns orchestration. The sampler owns cadence and identity per
CAPS-reported process. The
collector owns parsing. The derive module owns arithmetic. A metric is read in
exactly one place, so a value shown in the UI, in an export, and in a report
comes from the same line of code.

## The sample

One `process.snapshot` event per tracked PID per tick, 500 ms, containing
**every** metric key the collector knows about. Each PID has an independent rate
baseline. Each value carries its own provenance:

```json
{
  "wcharBytes":       { "value": 8388688, "provenance": "OBSERVED",   "source": "/proc/100/io" },
  "wcharBytesPerSec": { "value": 3200975, "provenance": "DERIVED",    "source": "sample delta" },
  "cpuPercent":       { "value": null,      "provenance": "UNAVAILABLE",
                        "source": "/proc/100/stat",
                        "reason": "First sample for this process: a rate needs two valid samples separated by a measured interval" }
}
```

A complete snapshot is deliberate: a missing key is indistinguishable from a
metric that was never collected. `markUnavailable()` fills all of them, so the
UI can always say what it does not know instead of rendering an empty row.

## Rules that are not negotiable

- **A rate needs two valid samples.** The first snapshot of a process reports
  every rate as `UNAVAILABLE` with that reason. Nothing is invented or
  zero-filled.
- **A flat counter is a real zero rate.** If `wcharBytes` does not move across a
  measured interval, the rate is `0`, not missing.
- **A counter that goes backwards is a reset, not a negative rate.** Such a
  sample's rates are `UNAVAILABLE` with a reason.
- **CPU is process CPU, never system-wide.** `cpuPercent` is a delta of
  `cpuTimeMs` (user + system, from kernel ticks) over the measured wall
  interval, expressed as a percentage of **one** core. It exceeds 100% when
  several threads run in parallel.
- **Character I/O is not disk throughput.** `rcharBytes`/`wcharBytes` count
  characters passed to `read()`/`write()`, including page-cache hits.
  `readBytes`/`writeBytes` count bytes that reached the block layer. Both are
  cumulative counters; both have derived per-second rates.
- **Missing means missing.** `UNAVAILABLE` is never rendered as `0`.

## Identity: proving the PID is the CAPS-owned child

A PID on its own is not evidence. Before every sample the sampler checks:

1. `/proc/<pid>/stat` still exists and its `PPID` equals the gateway-spawned CAPS
   process PID.
2. Start ticks (field 22) are unchanged, within a 2 s tolerance, so a recycled
   PID cannot inherit the old process's history.
3. `capsEnginePid` matches the engine PID the runner holds for this session.

A mismatch stops sampling for that execution; it never silently follows the new
owner of the PID.

## Lifecycle

The sampler starts on each `process.started` and takes an immediate first
sample, so a short command or pipeline stage still gets real telemetry. It
stops for that PID on `process.exited`, `process.exec_error`, identity loss, or
session finalization; gateway shutdown stops all samplers.
The runner stops the sampler **before** emitting the terminal event, so nothing
can be appended after the end of an execution. `publishSnapshot()` additionally
refuses to emit for a finalized or unknown session and strips the internal
`identityStartTicks` field before persistence.

Events are persisted before they are published over SSE, and sequence numbers
are assigned once, by the event repository.

## What is not collected

`/api/capabilities` lists this too, under `telemetry.unsupported`:

| Not collected | Why |
| --- | --- |
| syscall tracing | no strace/ptrace in the gateway's contract |
| eBPF | no privileged instrumentation |
| cgroup accounting | no cgroup setup, so no per-cgroup IO/memory pressure |
| network I/O | procfs exposes no socket byte counters |
| file descriptors | not read from `/proc/<pid>/fd` |
| request latency | needs block-layer tracing |

Each command or pipeline stage directly reported by CAPS is sampled. Arbitrary
descendants forked by those programs are not discovered. See the
[process coverage decision](process-coverage-decision.md) for the contract and
tradeoffs.

## Replay

Replay reads the persisted SQLite events and nothing else. It never re-runs the
command, never reads procfs, and never creates a PID.

## Frontend view model

`web/frontend/src/lib/telemetry.ts` is the only place the UI turns a metric
into a number:

| Function | Contract |
| --- | --- |
| `collectSamples` | snapshot events → samples with one shared time origin |
| `sampleAt` | nearest sample to a cursor; ties resolve to the later sample |
| `buildResourceTracks` | five tracks: CPU, RSS, syscall I/O, block I/O, faults |
| `thinIndices` | display-only thinning that keeps the first, last, and every peak |
| `buildInspector` | one real sample, grouped, with the backend's own reasons |
| `deriveRuntimePeaks` | mirrors the gateway's `computeRuntimePeaks` exactly |
| `buildVisualStates` | the Process Space view-model contract, see below |

Gaps in a track are drawn as gaps (`connectNulls={false}`), so an unavailable
rate is visible instead of being smoothed away.

## Process Space view

The 3D Process Space is implemented. It uses the same recorded samples and
shared selection model as the 2D views; it does not collect telemetry of its
own. Its visual state is derived from persisted samples:

| Field | Source | 3D use |
| --- | --- | --- |
| `cpu` | `cpuPercent` / session peak | emission rate and core glow |
| `memory` | `rssBytes` / session peak | body volume and pressure colour |
| `io` | max byte rate / session peak | ring pulses, colour by read vs write |
| `faults` | max fault rate / session peak | stutter and texture intensity |
| `atMs`, `timestamp`, `sequence` | event | scrub position and ordering |
| `pid`, `capsEnginePid`, `state`, `command` | identity | node identity and layout |
| `raw` | observed values | labels and tooltips |
| `unavailable` | backend reasons | render "no data", never a zero |

Normalized values are `0..1` against the **observed session peak**. A `null` in
any field means the kernel did not report it and remains missing data in the 3D
view. See [the 3D Process Space design](three-dimensional-observatory.md) for
rendering, accessibility, and fallback behavior.
