# Ground-truth verification record

Every figure the gateway reports, compared against the raw kernel file it claims
to come from. Captured on the verification host with the real C engine built and
a real gateway running.

- **Result: 59 checks passed, 0 failed.**
- Re-run the suite: from `web/backend`,
  `npx vitest run src/telemetry/system/groundtruth.test.ts`. See
  [testing.md](testing.md) for the suite commands, and
  [host-telemetry.md](host-telemetry.md) for what each figure means.

## Method

Three rules made the result trustworthy rather than decorative:

1. **Nothing trusts the gateway's parsing.** Each expected value is computed
   here from `/proc` or `/sys` with an independent expression.
2. **No assertion may pass on an empty response.** Every fetch is checked for
   parseable JSON first. An earlier draft of this script requested six
   `/api/system/*` endpoints that do not exist; each returned an empty string, and
   every comparison silently "passed". Host blocks are all served from
   `/api/system/snapshot`, and that is now what is read.
3. **Volatile counters are checked by invariant, not by equality.** `load1`,
   `MemAvailable`, and loopback traffic all move between the snapshot and the
   `/proc` read. Demanding bit-equality across that gap would be asserting the
   host is frozen. What is asserted instead is the exact *internal* relationship
   plus agreement with the kernel to within the counter's own drift.

## Environment

| | |
| --- | --- |
| Kernel | `6.18.33.2-microsoft-standard-WSL2` (WSL2 guest) |
| Logical CPUs | 12 |
| pidfd | available — `pidfd_open succeeded on this kernel` |
| Thermal sensors | none |
| cpufreq | not exposed |

---

## 1. CPU — `/proc/stat`

| Check | Result |
| --- | --- |
| First-sample utilisation is `UNAVAILABLE` with `value: null`, never `0` | PASS |
| Utilisation becomes `DERIVED` once two samples exist | PASS |
| `busyPercent` within 0..100 | PASS |
| `iowaitPercent` reported separately, not folded into busy | PASS |
| `perCore.length` equals the `cpuN` line count in `/proc/stat` | PASS — 12 |
| `cpu.coreCount` equals the `cpuN` line count | PASS — 12 |

The first sample's stated reason: *"First CPU sample for this boot: utilization
needs two samples separated by a measured interval."*

## 2. Memory — `/proc/meminfo`

| Check | Result |
| --- | --- |
| `MemTotal` matches the kernel exactly | PASS |
| `MemAvailable` provenance is `OBSERVED` | PASS |
| `MemAvailable` carries `estimate: true` in the payload | PASS |
| `usedBytes === totalBytes - availableBytes`, exactly | PASS |
| `MemAvailable` agrees with the kernel to within 0.01% of total | PASS |
| `0 < MemAvailable < MemTotal` | PASS |
| `usedPercent` provenance is `DERIVED` | PASS |

## 3. Load — `/proc/loadavg`

| Check | Result |
| --- | --- |
| `load1` is a non-negative observed count | PASS |
| Agrees with `/proc/loadavg` to within its own drift | PASS |
| `unit` is `1`, **not** a percentage | PASS |
| `load1PerCpu === load1 / coreCount` | PASS |
| `load1` is `OBSERVED`, `load1PerCpu` is `DERIVED` | PASS |

## 4. Pressure — `/proc/pressure/*`

| Resource | In `/proc` | Reported |
| --- | --- | --- |
| `cpu` | yes | `OBSERVED` = 0.19% |
| `memory` | yes | `OBSERVED` = 0% |
| `io` | yes | `OBSERVED` = 0.71% |

Each file is judged independently, so a host missing one reports that one
`UNAVAILABLE` rather than a fabricated zero for all three.

## 5. Disk — `/proc/diskstats`

`readBytes` equals `sectorsRead × 512` for every reported device:

| Device | readBytes | Kernel |
| --- | --- | --- |
| `sda` | 173 745 152 | matches |
| `sdb` | 6 636 544 | matches |
| `sdc` | 2 015 232 | matches |
| `sdd` | 645 084 160 | matches |

## 6. Network — `/proc/net/dev`

`eth0` counters match exactly. Loopback is a live counter carrying the gateway's
own traffic, so it is checked for consistency and non-negativity rather than
equality.

`network.perProcessBytes` is `UNAVAILABLE` with `value: null`, and its reason is
the machine-readable form of the limitation:

> Linux exposes no per-process network byte counters in procfs. Attributing
> traffic to a process requires an eBPF probe on the socket layer or a netfilter
> accounting hook, neither of which CAPS installs. The interface counters in this
> snapshot are host-wide totals and cannot be split per process. Reporting 0 here
> would be a fabrication, so this field is UNAVAILABLE.

## 7. Thermal and CPU frequency

| Check | Result |
| --- | --- |
| No thermal sensor exists on this host | PASS — reported `UNAVAILABLE` with the reason |
| No arbitrary sensor is labelled "CPU temperature" | PASS |
| `cpufreq` publishes no policies here | PASS — `UNAVAILABLE`, not fabricated |

The stated reason names the condition and says why nothing is synthesised:

> No supported temperature sensor is exposed by this Linux environment.
> `/sys/class/thermal` contains no thermal zones and `/sys/class/hwmon` exposes no
> temperature inputs. This is the expected result under WSL2, inside most virtual
> machines, and on hardware whose driver does not publish a thermal sensor. CAPS
> does not synthesise a temperature from CPU load, because such a curve would be
> indistinguishable from a measurement while being entirely invented.

## 8. Process inventory

| Check | Result |
| --- | --- |
| Every metric carries a `source` and a `unit` | PASS — 961 metrics over 31 rows |
| Every `UNAVAILABLE` metric carries a `reason` | PASS |
| No `UNAVAILABLE` metric carries a non-null value | PASS — 170 such metrics, all `null` |
| Every identity matches `/proc/<pid>/stat` field 22 exactly | PASS — 31 of 31 |
| `bootId` matches `/proc/sys/kernel/random/boot_id` | PASS |
| PSS never exceeds RSS | PASS |
| PSS availability | `UNAVAILABLE` on all 31 rows — the documented slow cadence |

Field 22 is `starttime` in clock ticks since boot. Matching it for every row is
the direct check that no process is being misidentified.

## 9. Process identity mechanism

Published from a real probe rather than a constant:

```json
{ "confidence": "VERIFIED", "terminationMechanism": "pidfd",
  "kernel": "6.18.33.2-microsoft-standard-WSL2",
  "reason": "pidfd_open succeeded on this kernel" }
```

## 10. Guardrails: configured vs enforced

| Guardrail | Configured | Enforced |
| --- | --- | --- |
| Wall time | 30 000 ms | true |
| Wall-time ceiling | 120 000 ms | true |
| stdout | 65 536 bytes | true |
| stderr | 1 048 576 bytes | true |
| CPU time | 0 ms | **false** — unset means unlimited |
| Address space | 0 bytes (`RLIMIT_AS`) | **false** — unset means unlimited |
| Concurrency | 4 | true |

`enforced: false` for the two child-side limits is correct: they are unset, and
unset means *unlimited* (`RLIM_INFINITY`), not *zero*. Reporting them as
enforced would claim a containment that is not in force.

---

## What this pass does not cover

| Not verified here | Why | Verified by |
| --- | --- | --- |
| Clang | no Clang and no install rights on this host | CI |
| Thermal hardware behaviour | no sensor present | `thermalGuard.test.ts`, synthetic sysfs fixtures |
| Real cpufreq values | not exposed by WSL2 | `frequency.ts`, synthetic fixtures |
| PID **reuse** under real recycling | cannot be forced on demand | `tests/test_pidfd.sh` with a real zombie and a deliberately mismatched identity |
| Per-process network | does not exist in Linux | the `UNAVAILABLE` assertion above |

These are environment limitations, stated rather than worked around, and none of
them invalidates the release.
