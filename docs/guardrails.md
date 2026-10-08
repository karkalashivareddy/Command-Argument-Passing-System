# Guardrails: what is enforced, and by whom

A limit that is *configured* and a limit that is *in force* are different facts.
This project keeps them separate everywhere, because an unenforced limit that
looks enforced is worse than no limit at all: it invites a reader to believe the
program is contained when it is not.

`GET /api/capabilities` publishes every guardrail as three separable fields —
`configured`, `enforced`, and a note — precisely so the two cannot be conflated.
`GET /api/system/capabilities` and the **System** screen render the same data.

- What is measured: [`host-telemetry.md`](host-telemetry.md)
- Threat model: [`../SECURITY.md`](../SECURITY.md)
- Termination identity: [§6](#6-termination-and-process-identity)

---

## 1. The two enforcement points

| Where | What it can enforce | Mechanism |
| --- | --- | --- |
| **Gateway** | wall time, concurrency, stdout/stderr bytes, thermal admission | refuses or truncates around the child |
| **Child, before `execvp`** | address space, CPU time, file size, core dumps | `setrlimit(2)` in the forked child |

The child-side limits are applied in the forked child **immediately before
`execvp`**, which is the only ordering in which they are guaranteed to be in
force for the whole life of the executed program. A limit that cannot be
established is reported through the status pipe like any other launch failure, so
"configured" and "in force" diverge as a **recorded fact** rather than silently.

---

## 2. Wall time

| | |
| --- | --- |
| Configured | `CAPS_DEFAULT_TIMEOUT_MS`, per-request `timeoutMs`, capped by `CAPS_MAX_TIMEOUT_MS` |
| Enforced by | the gateway |
| Failure | `status: TIMED_OUT`, with the engine's own outcome retained separately |

The timeout is **not** a bare `kill`. See [§6](#6-termination-and-process-identity):
the graceful signal is sent first, and the escalation to `SIGKILL` is bound to the
process identity recorded at spawn.

The timeout applies to the **pipeline as a whole**, not per stage, and the
pipeline shares one process group precisely so the timeout reaches every stage.

---

## 3. Concurrency

`CAPS_MAX_CONCURRENT`. A request beyond the limit is **refused**, not queued.

Queueing would convert a load problem into a latency problem and hide both: the
caller would wait, and the fact that the gateway was saturated would never appear
in a record. A refusal is visible immediately.

---

## 4. Output channels

`stdout` and `stderr` are bounded **separately**, and truncation is **recorded**
rather than silently applied.

Separate bounds are not a detail. An unbounded `stderr` fills its pipe and
deadlocks a child that is otherwise healthy — the classic way a program that
prints diagnostics appears to hang.

| | |
| --- | --- |
| Configured | `CAPS_MAX_OUTPUT_BYTES` for `stdout`, `CAPS_STDERR_MAX_BYTES` for `stderr` |
| Enforced by | the gateway |
| On overflow | the retained tail is kept at a character boundary and the earlier output is discarded; the session records that truncation happened |

Two properties of that mechanism are worth stating plainly, because both are
easy to overstate:

- **The bound is on what the gateway RETAINS, not on what the child produces.**
  The child is never stopped, signalled, or paused for writing output. Both
  pipes are drained continuously, so a chatty program cannot block on a full
  pipe and cannot deadlock. What is bounded is the gateway's memory.
- **Truncation keeps the tail.** For a terminal view the last thing a program
  said is the useful part, and it is the part that explains a failure; the
  earlier bytes are dropped.

The CAPS monitor protocol does **not** travel on a separate descriptor. The
engine writes the monitor to `stderr` (`caps_monitor_create(stderr, ...)` in
`src/main.c`), and the child inherits that descriptor, so CAPS diagnostics and
the program's own error output share **one** stream. They are separated
**line-wise**, by the frame prefix, not at descriptor level. This is asserted end
to end by the smoke suite, which checks that a program's `stderr` contains no
protocol frames.

---

## 5. Child resource limits — `setrlimit`

Set in the child before `execvp`. All are configured through the environment and
are **unlimited when unset**, not zero.

| Limit | Gateway variable | Engine variable | What it bounds |
| --- | --- | --- | --- |
| `RLIMIT_AS` | `CAPS_ADDRESS_SPACE_LIMIT_BYTES` | `CAPS_LIMIT_ADDRESS_SPACE_BYTES` | Virtual address space |
| `RLIMIT_CPU` | `CAPS_CPU_BUDGET_MS` | `CAPS_LIMIT_CPU_SECONDS` | CPU time, as the kernel counts it |
| `RLIMIT_FSIZE` | — | `CAPS_LIMIT_FILE_BYTES` | Size of a file the child may create |
| `RLIMIT_CORE` | — | always `0` | Core dumps are never written |

An operator sets the **gateway** names. `sanitizedEnv()` in
`web/backend/src/execution/runner.ts` translates them into the **engine** names
that the forked child actually reads, and passes only those plus a small
pass-through set (`PATH`, `LANG`, `HOME`, `TERM`). Two consequences of that
translation:

- **The CPU budget rounds UP to whole seconds.** `CAPS_CPU_BUDGET_MS` is
  millisecond-granular because that is how CPU time is reported everywhere else,
  but `RLIMIT_CPU` counts in seconds, so `sanitizedEnv()` emits
  `Math.ceil(ms / 1000)`. The ceiling is therefore never tighter than the
  configured one — a 1500 ms budget becomes a 2 s kernel limit. `0` means the
  variable is not passed at all and the limit is unlimited.
- **The gateway's `stderr` cap is not the engine's file-size cap.**
  `CAPS_STDERR_MAX_BYTES` bounds how much `stderr` the gateway retains; it is
  never translated to anything the engine sees. `CAPS_LIMIT_FILE_BYTES` is
  `RLIMIT_FSIZE` and bounds the size of a file the child may create. They are
  unrelated mechanisms and one does not stand in for the other.

Four points that are commonly got wrong:

- **`RLIMIT_AS` is virtual address space, not physical memory.** A program with
  a large mapping fails under `RLIMIT_AS` while using little RAM. The UI labels
  it "virtual address space" for that reason.
- **`RLIMIT_CPU` is CPU time, not wall time.** A process blocked on I/O accrues
  none of it, which is why a program can be alive for an hour and still be well
  inside its CPU limit.
- **Unlimited means unlimited.** An unset limit produces `RLIM_INFINITY`, not
  `0`. `tests/test_limits.sh` asserts this directly, because the alternative — a
  zeroed limit — refuses to start every program.

The suite asserts against the **child's own** `/proc/<pid>/limits`, not against
the parent's intent, so it verifies what the kernel actually applied.

---

## 6. Termination and process identity

### The identity model

```
pid @ startTicks # bootId
```

A PID on its own is **never** sufficient, because Linux recycles PIDs. The
gateway records the child's start ticks at `process.started` — the safest instant,
because the child was just forked by this gateway and an unreaped child keeps its
PID reserved.

### The mechanism, and what it guarantees

`GET /api/capabilities` publishes `processIdentity` from a **real probe**, never a
constant:

| Field | Meaning |
| --- | --- |
| `confidence` | `VERIFIED`, `UNVERIFIED`, or `UNAVAILABLE` |
| `terminationMechanism` | `pidfd`, `start-ticks`, or `unavailable` |
| `reason` | always non-empty; states what was measured |
| `invariant` | the rule, in the client's own words |

| Confidence | Mechanism | Guarantee |
| --- | --- | --- |
| `VERIFIED` | `pidfd` | A `pidfd` is a kernel handle bound to one specific process. The kernel never re-points it even if the PID is recycled, and `pidfd_send_signal` through it cannot reach an unrelated process. |
| `UNVERIFIED` | start ticks | The identity was validated against `/proc/<pid>/stat` before the signal. Weaker than a kernel handle, and labelled so. |
| `UNAVAILABLE` | none | CAPS **will not signal**. No identity, no signal. |

`pidfd` requires `pidfd_open(2)` and `pidfd_send_signal(2)`. Node exposes neither,
so `src/pidfd.c` builds a small helper binary (`build/caps_pidfd`) that the
gateway execs. Where the helper is not built or the syscall is unavailable, the
probe reports why and the start-ticks path runs — as a labelled fallback, not a
silent one.

### Refusal is the safe direction

When a `pidfd` **is** available and declines — because the target is not the
process that was tracked — there is deliberately **no fallback to a bare
`kill`**. The kernel has just told us the target is not ours, and a bare kill
would discard exactly the information that made the refusal safe.

Refusing always errs the recoverable way: an un-signalled workload leaks a
process, which is visible and recoverable; a wrong kill destroys something the
gateway never observed, which is neither.

The mechanism that actually delivered a signal is recorded per outcome, so
"terminated" always travels with "how".

---

## 7. Thermal admission

**Disabled by default.** It is opt-in because it changes which programs are
allowed to start, and that decision belongs to the operator.

| | |
| --- | --- |
| Enabled by | `CAPS_THERMAL_GUARD_ENABLED` (default `false`) |
| Sensor | `CAPS_THERMAL_GUARD_SENSOR` (`auto` \| `package`), or exactly one of `CAPS_THERMAL_GUARD_SENSOR_NAME` / `CAPS_THERMAL_GUARD_SENSOR_PATH` |
| Thresholds | `CAPS_THERMAL_GUARD_WARNING_C`, `CAPS_THERMAL_GUARD_CRITICAL_C` |
| Action | `CAPS_THERMAL_GUARD_ACTION` (`WARN` \| `TERM` \| `TERM_THEN_KILL`), `CAPS_THERMAL_GUARD_TERM_GRACE_MS` |
| Enforced by | `ExecutionRunner.start()`, **before** anything is persisted or spawned |
| Discovery | read-only over `/sys/class/thermal` and `/sys/class/hwmon` |

### Where it sits in the execution path

Every workload CAPS starts goes through the guard, on both entry points — the
structured `/api/sessions` request and the `/api/terminal/execute` command line:

1. the guard evaluates the configured thresholds against a **fresh** sysfs read,
   so the decision reflects the temperature at the moment the workload would
   start rather than at the moment the process was constructed;
2. the decision is written into the session's `execution.created` event,
   including the sensor path, the raw millidegree value, the threshold and a
   one-sentence reason — whether it allowed or refused;
3. a refusal creates and finalises the session with `FAILED` and answers
   `503 THERMAL_REFUSED`. Nothing is forked, and the refusal is still visible in
   history, in replay and over SSE, so "why did nothing run?" is answerable
   without asking the process that returned the error.

A refusal is a **pre-spawn** decision, so `TERM` and `TERM_THEN_KILL` both mean
"do not start". There is no process yet to escalate against, and escalating
against one would mean signalling something CAPS did not decide to run.

### What it does not do

- **It never writes to sysfs, hwmon, or cpufreq.** No governor change, no
  throttling, no reset. It observes and then refuses or permits.
- **It never protects host processes.** It governs admission of CAPS-owned
  children only. Nothing here can throttle the machine.
- **It never fabricates a reading.** No sensor means the guard *runs*, evaluates,
  and returns `UNAVAILABLE_ALLOW`: the workload starts, and the record states
  that this admission carries **no** thermal justification. It does not fall
  back to a modelled temperature, because an absent sensor is not evidence of a
  cool machine.
- **It does not call an arbitrary sensor "CPU temperature."** Whatever is found
  under a thermal zone or hwmon device is listed with its own `type` and `label`.
  A voltage input or a fan tachometer is reported as what it is.

### The decision table

| State | Action |
| --- | --- |
| Guard disabled | `DISABLED` — permit, and say no sensor was read |
| No sensor found | `UNAVAILABLE_ALLOW` — permit, and record that the guard could not operate |
| Reading unavailable for the selected sensor | `UNAVAILABLE_ALLOW` — permit, and record why |
| Below `WARNING_C` | `ALLOW` — permit |
| At or above `WARNING_C` | `WARN_ONLY` with `WARN`, or `REFUSE_TERM` with `TERM` / `TERM_THEN_KILL` |
| At or above `CRITICAL_C` | `WARN_ONLY` with `WARN`, or `REFUSE_KILL` with `TERM` / `TERM_THEN_KILL` |

Every decision is recorded with the sensor, the reading, the threshold it crossed,
and the action taken. The record is what makes the guard auditable after the
fact, and it is what `GET /api/system/thermal` and `GET /api/capabilities` report
verbatim.

Configuration is validated on startup and invalid values are refused rather than
clamped, because a silently clamped threshold is a threshold the operator did not
choose.

---

## 8. The guardrail matrix

| Guardrail | Configured | Enforced | Enforced by |
| --- | --- | --- | --- |
| Wall time | yes | yes | the gateway's own `setTimeout`; there is no timeout in the C engine at all |
| Concurrency | yes | yes | gateway (refusal, `429 CONCURRENCY_LIMIT_REACHED`, never queued) |
| stdout bytes | yes | yes, with recorded truncation | gateway, bounded retention |
| stderr bytes | yes | yes, with recorded truncation | gateway, bounded retention, separate cap |
| CPU time | yes | yes | `RLIMIT_CPU` applied to the child **before `execvp`**, so the kernel enforces it and sends `SIGXCPU` |
| Address space | yes | yes | `RLIMIT_AS` applied to the child before `execvp` |
| File size | yes | yes | child `RLIMIT_FSIZE` |
| Core dumps | always off | yes | child `RLIMIT_CORE=0` |
| Thermal | opt-in | yes when enabled | gateway, pre-spawn |
| Process identity | always | yes | pidfd or start ticks |
| Network | — | **not enforced** | Linux exposes no per-process counter to enforce against |

The last row is listed so the table is complete: it is the one thing a reader
might expect to find and cannot.

---

## 9. What is configured but NOT enforced

Stated plainly, because the alternative is a reader assuming coverage:

- **Network rate limiting.** There is no cgroup or netfilter management here, so
  no network limit is claimed.
- **Disk I/O rate limiting.** `RLIMIT_FSIZE` bounds how large a created file may
  be; it does not bound bytes per second. I/O rates are measured, not capped.
- **Process count per execution.** A program may fork. Only the pipeline's own
  stages are identity-tracked; a grandchild CAPS did not record is not signalled.
- **Memory pressure protection.** The collector reports pressure; nothing acts on
  it.

---

## 10. Verified by

| Claim | Suite |
| --- | --- |
| `RLIMIT_AS`/`CPU`/`FSIZE`/`CORE` reach the child **of every pipeline stage as well as a single command**; unset means unlimited | `tests/test_limits.sh` (29 assertions, reads each stage's own `/proc/<pid>/limits`) |
| pidfd binds, signals, and refuses a recycled PID | `tests/test_pidfd.sh` (21 assertions, with a real zombie from `tests/helpers/zombie_maker.c`) |
| Thermal decision table, sensor discovery, refusal to fabricate | `web/backend/tests/unit/thermalGuard.test.ts`, `thermalGuardConfig.test.ts` |
| Thermal guard is actually consulted when a workload starts | `web/backend/tests/unit/thermalAdmission.test.ts` |
| Timeout escalates through a verified identity | `web/backend/tests/api/server.test.ts` |
| Guardrails are published as `configured` vs `enforced`, and an unconfigured limit says so | `web/backend/tests/unit/thermalGuardConfig.test.ts` ("publishes configured, enforced, and mechanism for every limit") |
| Concurrent execution is refused, not queued | `web/backend/tests/api/server.test.ts` |

A real zombie cannot be produced from a shell — bash reaps its own jobs and an
orphaned child is re-parented to init, which reaps it immediately — so the pidfd
suite drives a helper that holds an unreaped child, and the assertions actually
execute instead of being skipped.

---

## See also

- [`host-telemetry.md`](host-telemetry.md) — every metric, its source, and its provenance
- [`../SECURITY.md`](../SECURITY.md) — threat model and out-of-scope list
- [`architecture.md`](architecture.md) — module boundaries and invariants
- [`testing.md`](testing.md) — how to run everything above
