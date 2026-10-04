# CAPS host telemetry

What the **host** collector observes, which is a different thing from what the
execution layer observes for a CAPS-owned child.

- Per-child telemetry for one execution: [`telemetry.md`](telemetry.md)
- What is observed vs not observed, and why: [`observability-model.md`](observability-model.md)
- Resource admission and thermal gating: [`guardrails.md`](guardrails.md)

---

## 1. The envelope

Every host figure is a `SystemMetric<T>`:

```ts
{ value, unit, source, timestamp, provenance, reason }
```

| Field | Why it is not optional |
| --- | --- |
| `value: T \| null` | `null` means the kernel published nothing usable. It is never `0`. |
| `unit` | `bytes`, `kib/s`, `percent`, `celsius`, `hz`, `USER_HZ`, `1`. |
| `source` | The exact file and field, e.g. `/proc/<pid>/stat field 22`. |
| `timestamp` | When the read happened, not when the counter was last written. |
| `provenance` | `OBSERVED`, `DERIVED`, or `UNAVAILABLE`. |
| `reason` | Always present when `provenance` is `UNAVAILABLE`. |

### Provenance vocabulary

| Value | Meaning |
| --- | --- |
| `OBSERVED` | Read directly from a kernel file. |
| `DERIVED` | Computed from two or more observed values. The inputs are named in `source`. |
| `UNAVAILABLE` | Not obtainable on this host or at this instant. `value` is `null` and `reason` says why. |
| `GATEWAY` | Produced by the gateway itself (for example a `child_process.spawn` pid). Present in the execution-scoped stream, not in host metrics. |

There is no fourth state. A figure that cannot be had is `UNAVAILABLE`; it is
never rounded to zero, never interpolated, and never carried over from a previous
sample.

---
## 2. Sources actually read, and where each is served

Everything the collector measures is served from **one** endpoint,
`GET /api/system/snapshot`, as a named block. There are no per-subsystem routes:
a dashboard that wants CPU and memory reads one coherent sample rather than
several that may straddle a collection boundary.

| Block in `/api/system/snapshot` | Source | Per-subsystem extras |
| --- | --- | --- |
| `cpu` | `/proc/stat` | — |
| `memory` | `/proc/meminfo` | — |
| `load` | `/proc/loadavg` | — |
| `pressure` | `/proc/pressure/{cpu,memory,io}` | — |
| `thermal` | `/sys/class/thermal`, `/sys/class/hwmon` | `/api/system/thermal` |
| `frequency` | `/sys/devices/system/cpu/cpufreq/*` | `/api/system/frequency` |
| `disk` | `/proc/diskstats`, `/proc/self/mountinfo` | — |
| `network` | `/proc/net/dev` | — |
| `processSummary` | derived from the inventory below | `/api/system/processes`, `/api/system/processes/:identity` |
| `collectorHealth` | internal | `/api/system/health`, `/api/system/capabilities` |

The complete route list is in [`web-api.md`](web-api.md).

`GET /api/system/capabilities` lists each subsystem with its source, whether it is
available, and a note. It is the authoritative answer to "can this host report
that at all".


---

## 3. CPU — `/proc/stat`

`/proc/stat` publishes **cumulative** `USER_HZ` counters. Nothing in the file is
a rate, so a rate requires two samples:

```
busy% = Δ(total − idle − iowait) / Δ(total) × 100
```

`iowait` is excluded from busy because time spent waiting on I/O is not time
doing work. `busyPlusIowaitPercent` is published **alongside** `busyPercent`
rather than folded into it, so a reader can see both without recomputing.

| Field | Meaning |
| --- | --- |
| `cpu.utilization.{busy,idle,iowait,user,nice,system,irq,steal,busyPlusIowait}Percent` | percentages over `intervalMs` |
| `cpu.utilization.intervalMs` | the measured interval the deltas were taken over |
| `cpu.perCore[]` | `{ index, busyPercent, idlePercent, iowaitPercent }`, one per `cpuN` line |
| `cpu.coreCount` | logical CPUs, `OBSERVED` from the `cpuN` line count |
| `cpu.currentTimes` / `cpu.previousTimes` | the raw `Cpus:` line that the deltas came from |

**The first sample after boot has no predecessor**, so every utilisation field is
published as `UNAVAILABLE` with the reason *"First CPU sample for this boot:
utilization needs two samples separated by a measured interval"* and
`value: null` — never `0%`. `cpu.coreCount` is available immediately, because it
is a count and not a rate.

This is `DERIVED`, and the `reason` on `currentTimes`/`previousTimes` names both
inputs.

---

## 4. Memory — `/proc/meminfo`

| Field | Provenance | Note |
| --- | --- | --- |
| `totalBytes` | OBSERVED | `MemTotal` |
| `freeBytes` | OBSERVED | `MemFree` — **not** what is available |
| `availableBytes` | OBSERVED, `estimate: true` | `MemAvailable`. The kernel's own estimate of what is available without swapping. Flagged `estimate: true` in the payload and described in its `reason`. |
| `usedBytes` | DERIVED | `total − available` |
| `usedPercent` | DERIVED | `(total − available) / total × 100` |
| `buffersBytes`, `cachedBytes`, `reclaimableBytes` | OBSERVED | page cache components, itemised rather than summed into one opaque figure |
| `anonPagesBytes`, `sharedBytes`, `slabBytes` | OBSERVED | |
| `activeBytes`, `inactiveBytes`, `dirtyBytes`, `writebackBytes` | OBSERVED | |
| `swapTotalBytes`, `swapFreeBytes`, `swapUsedBytes`, `swapPercent`, `swapCachedBytes` | OBSERVED / DERIVED | |

`usedPercent` is the figure to alert on, not `freeBytes`: page cache is
reclaimable, and `MemFree` on its own says almost nothing on a healthy host.

---

## 5. Load average is not CPU utilisation

| Field | Provenance |
| --- | --- |
| `load1`, `load5`, `load15` | OBSERVED from `/proc/loadavg` |
| `load1PerCpu` | DERIVED — `load1 / coreCount` |
| `runnable`, `totalThreads`, `lastPid` | OBSERVED |

`load.load1.reason` says it outright: *"Exponentially-damped average of runnable
and uninterruptible-sleep tasks. NOT CPU utilization and NOT a queue depth."*

Two things follow, and both are the standard way a load chart misleads:

1. **Scale differs.** `load1PerCpu` exists precisely so the raw number can be read
   against capacity: a load of 1.0 per CPU means one runnable task per CPU, and
   the raw load is unbounded.
2. **It includes uninterruptible sleep.** A process blocked in `D` state counts
   toward load while consuming no CPU, so load can rise while utilisation falls.

No field converts load into a utilisation percentage, because that conversion is
a model and not a measurement. CPU utilisation is reported separately, from §3.

---

## 6. Pressure (PSI) — `/proc/pressure/*`

Requires `CONFIG_PSI`. Each of `cpu`, `memory`, `io` is independently
unavailable, and reports its own `reason` when the kernel omits the file.

`pressure` is an **array**, one entry per resource:

```
{ resource: "cpu" | "memory" | "io",
  some: { avg10, avg60, avg300 },
  full: { avg10, avg60, avg300 } }
```

- `some` — at least one task stalled.
- `full` — every non-idle task stalled. Absent for `io` on many kernels.
- Each average is a **percentage of wall time** over that window, `OBSERVED`
  from `psi(5)`, and each carries its own `reason` naming the window.

Three independent resources means three independent absences: a host without PSI
reports three unavailable entries, not a fabricated zero for any of them.

---

## 7. Memory accounting — RSS is not PSS

| Figure | Source | Cost | Use |
| --- | --- | --- | --- |
| RSS | `/proc/<pid>/status` `VmRSS` | cheap | one process's resident set |
| PSS | `/proc/<pid>/smaps_rollup` `Pss` | **expensive** | sums correctly across a host |

RSS counts every page mapped into a process, including pages shared with
others, so **summing RSS across processes double-counts shared memory**. PSS
divides each shared page among its mappers, which is why it is the only figure
that can be totalled.

PSS is deliberately **not** in the fast cadence: it makes the kernel walk page
tables, and an observability product that does that every second is itself a load
problem. It is read on a slow cadence for a bounded number of processes, or on
demand for one process via `GET /api/system/processes/:identity`.
`collectorHealth.pssSkipped` counts the processes whose PSS was not read because
the budget was full.

Consequently **PSS is `UNAVAILABLE` on most rows at any given instant**, with a
`reason` naming the cadence. That is normal and expected, and it is never
rendered as `0`.

---

## 8. Disk and network — rates, and what they do not cover

### Disk — `/proc/diskstats`

`disk.devices[]` — one entry per whole device:

| Field | Provenance |
| --- | --- |
| `device`, `name` | kernel `major:minor` and name |
| `readsCompleted`, `writesCompleted` | OBSERVED, cumulative |
| `sectorsRead`, `sectorsWritten` | OBSERVED, cumulative, 512-byte units |
| `readBytes`, `writeBytes` | DERIVED — sectors × 512, per `proc_diskstats(5)` |
| `readBytesPerSec`, `writeBytesPerSec`, `readsPerSec`, `writesPerSec` | DERIVED over the sample interval |
| `ioMillis`, `inFlight`, `busyPercent` | OBSERVED / DERIVED |

`readBytes.reason` states the important caveat: the 512-byte sector is *"the
kernel's accounting unit, not necessarily the device's native block size."*

`inFlight` is a **gauge, not a counter** — it is the number of requests in flight
at that instant and is deliberately not differenced.

`disk.filesystems[]` comes from `/proc/self/mountinfo` and carries capacity and
inode figures per mount point.

Only whole devices are reported. Partitions are **not** summed into their parent
devices, which would double-count.

### Network — `/proc/net/dev`

`network.interfaces[]` — one entry per interface:

| Field | Provenance |
| --- | --- |
| `rxBytes`, `txBytes`, `rxPackets`, `txPackets` | OBSERVED, cumulative |
| `rxBytesPerSec`, `txBytesPerSec` | DERIVED over the sample interval |
| `rxErrors`, `txErrors`, `rxDropped`, `txDropped` | OBSERVED, cumulative |
| `operState`, `linkSpeedMbps`, `mtu`, `operStateSource` | OBSERVED |

Loopback is included and labelled; it is often the largest interface on a
gateway host.

### The limitation is a field, not just a sentence

`network.perProcessBytes` is published as a metric, and it is permanently:

```json
{ "value": null, "unit": "bytes", "provenance": "UNAVAILABLE",
  "source": "/proc/net/dev (no per-process source exists)",
  "reason": "Linux exposes no per-process network byte counters in procfs. Attributing traffic to a process requires an eBPF probe on the socket layer or a netfilter accounting hook, neither of which CAPS installs. The interface counters in this snapshot are host-wide totals and cannot be split per process. Reporting 0 here would be a fabrication, so this field is UNAVAILABLE." }
```

A client cannot mistake the interface totals for per-process figures, because the
API says in machine-readable form that the split is not available and why.

Similarly, `readBytes`/`writeBytes` on a process row are that **process's own**
`/proc/<pid>/io` counters — a different mechanism from the device totals above,
and labelled with its own source.

---

## 9. Thermal and CPU frequency

Discovery is read-only. CAPS **never writes** to `/sys/class/thermal`,
`/sys/class/hwmon`, or any `cpufreq` interface.

- **Sensors are enumerated, not assumed.** Anything found under a thermal zone
  or hwmon device is listed with its `type`, `label`, and current reading, and it
  is called a sensor by that name. An arbitrary hwmon voltage or fan input is
  **not** labelled "CPU temperature".
- **No sensor means `UNAVAILABLE`, with the reason.** Not `0 °C`, not a
  fabricated estimate, and the guard does not run.
- **Frequency policy is separate from sensors.** `/sys/devices/system/cpu/cpufreq`
  exposes `scaling_cur_freq`, `scaling_min_freq`, `scaling_max_freq`, and the
  `*_governor` per policy. On a host where `cpufreq` is absent — which includes
  most WSL2 guests — this whole subsystem reports `UNAVAILABLE`.

Full detail, including the guard's decision table: [`guardrails.md`](guardrails.md).

---

## 10. The process inventory

`GET /api/system/processes` returns one row per discovered PID. Every field is a
metric, because each can be unreadable for a specific reason.

### 10.1 Identity is a triple

```
pid @ startTicks # bootId
```

A PID alone is not an identity: Linux recycles PIDs, and on a long-lived host the
same number can be a different process an hour later.

- `startTicks` is field 22 of `/proc/<pid>/stat` — clock ticks since boot. It is
  a pure kernel value, stable for the life of the process, and different for
  every later process that reuses the PID.
- `bootId` is `/proc/sys/kernel/random/boot_id`. `startTicks` is only meaningful
  within one boot, so the boot id scopes it.

The key is the stable string form used across the API, the database, and the
UI.

### 10.2 Ownership is matched on that identity

`capsOwned: true` means **the gateway started this process and the recorded
identity still matches**. It is computed by comparing the row's full key against
the identities of live CAPS sessions.

It is never a command-name match. Two failure modes that a name match would
produce, and does not:

- a host process whose arguments merely mention `caps` would be claimed as
  ours, and claimed as signalable;
- a real CAPS workload whose argv happens not to contain the word would be
  denied.

A process whose PID matches a finished session but whose start ticks do not is a
different process that inherited the number. It is reported `capsOwned: false`.

### 10.3 Parent links carry their own confidence

`ppid` is observed, but a PPID value is not a verified parent relationship: a
process re-parented to init on its parent's exit still reports that PPID.
`relationshipConfidence` therefore states how far the link can be trusted:

| Value | Meaning |
| --- | --- |
| `VERIFIED` | The kernel reports a PPID, **and** that process was itself read in the same sample. Both ends are observed. |
| `UNVERIFIED` | The PPID value was read, but that process is not in the sample — it exited, it is outside the sampled namespace, or the sample budget excluded it. The row is a leaf as far as CAPS can prove, not definitively a root. |
| `UNAVAILABLE` | The PPID itself could not be read. |

A tree view may only draw a `VERIFIED` edge as a real edge.

### 10.4 Row state is not the same as process state

`rowState` describes the row's relationship to the collector:

| State | Meaning |
| --- | --- |
| `LIVE` | Every requested field was read. |
| `EXITED` | The process vanished between enumerating `/proc` and reading it. Routine on a busy host. |
| `DISAPPEARED` | The PID was **replaced** between enumeration and read. The row is discarded rather than showing one process's command beside another's memory. |
| `PERMISSION_DENIED` | Another user's process with `hidepid=2`, or no `CAP_SYS_PTRACE`. Fields that *were* readable are still populated. |
| `UNAVAILABLE` | `/proc/<pid>/stat` was readable but did not parse. |

`sampled: false` means the per-process budget was spent before this process was
reached, so the row carries identity fields only. That is a statement about the
**sample**, not about the process, and it says so.

### 10.5 The field list

| Field | Source | Provenance |
| --- | --- | --- |
| `pid`, `ppid`, `threads`, `state` | `/proc/<pid>/stat` | OBSERVED |
| `name` | `/proc/<pid>/cmdline`, else `comm` | OBSERVED |
| `cmdline` | `/proc/<pid>/cmdline` | OBSERVED; empty for a kernel thread, which is a fact |
| `stateName` | decoded from the state letter | OBSERVED |
| `uid`, `gid` | `/proc/<pid>/status` | OBSERVED |
| `cpuTimeMs` | `utime + stime` × `1000 / _SC_CLK_TCK` | DERIVED |
| `cpuPercent` | Δ`cpuTimeMs` / Δwall | DERIVED |
| `rssBytes` | `VmRSS` | OBSERVED |
| `pssBytes` and the rest of the smaps set | `/proc/<pid>/smaps_rollup` | OBSERVED or UNAVAILABLE by cadence |
| `virtualMemoryBytes` | `VmSize` | OBSERVED |
| `swapBytes` | `VmSwap` | OBSERVED |
| `minorFaults`, `majorFaults` | `/proc/<pid>/stat` | OBSERVED |
| `readBytes`, `writeBytes` | `/proc/<pid>/io` | OBSERVED |
| `voluntary/nonVoluntaryContextSwitches` | `/proc/<pid>/status` | OBSERVED |
| `processGroupId`, `sessionId` | `/proc/<pid>/stat` | OBSERVED |
| `cpuAffinity` | `/proc/<pid>/status` | OBSERVED |
| `schedulerRuntimeNs`, `schedulerWaitNs`, `schedulerTimeslices` | `/proc/<pid>/schedstat` | UNAVAILABLE where the kernel omits it |

### 10.6 What is deliberately not collected

- **Per-process network I/O.** Linux publishes no such procfs counter.
- **Other processes' `environ`.** Not readable without privilege and not
  relevant.
- **Command output of other processes.** Only CAPS-owned children have their
  output captured, and only because CAPS created the pipe.

---

## 11. Cadence, collector health, and retention

| Cadence | Default | Work |
| --- | --- | --- |
| fast | 1 s | CPU, memory, load, pressure, thermal, frequency, disk, network |
| discovery | 2 s | enumerate `/proc` and build process rows |
| slow | 5 s | the fuller per-process read |
| PSS | 30 s | `smaps_rollup`, bounded number of processes |

`collectorHealth` publishes the collector's own condition as metrics:

| Field | Meaning |
| --- | --- |
| `lastCollectionMs` | wall time the last full snapshot took |
| `errors` | cumulative collector errors since the last reset |
| `recentErrors` | the messages themselves, bounded |
| `pssSkipped` | processes whose PSS was not read because the budget was full |

The live cadence is published at `GET /api/system/processes` as `cadance`, so a
client never has to guess it.

Every snapshot is persisted when retention is enabled.
`GET /api/system/analytics` publishes the retention window in force, so a chart
never implies a longer history than the store holds. The policy is also reported
at `/api/ready`:

```json
"retention": { "days": 0, "enabled": false, "policy": "disabled: every session is kept" }
```

`/api/system/health` reports the collector's condition on its own, and
`/api/system/stream` delivers the same snapshots over SSE with resume and gap
detection.

---

## 12. Verified against raw Linux

Every claim in this document has been checked against the raw kernel file it
describes. The recorded result is
**[`ground-truth-verification.md`](ground-truth-verification.md)**: 59 checks,
0 failures, covering CPU delta arithmetic, `MemTotal`/`MemAvailable`/`used`,
load as a count, per-file PSI availability, RSS versus PSS, device versus process
I/O, thermal and cpufreq absence, and identity agreement with
`/proc/<pid>/stat` field 22 for every row.

The in-repo suite that guards the same ground is
`web/backend/src/telemetry/system/groundtruth.test.ts`:

```bash
cd web/backend && npm test
```

---

## See also

- [`telemetry.md`](telemetry.md) — per-execution telemetry for CAPS-owned children
- [`observability-model.md`](observability-model.md) — what is not observed, and why
- [`guardrails.md`](guardrails.md) — limits, thermal admission, termination identity
- [`process-microscope.md`](process-microscope.md) — identity verification in the UI
- [`ground-truth-verification.md`](ground-truth-verification.md) — this contract, checked against raw `/proc`
- [`../SECURITY.md`](../SECURITY.md) — threat model
