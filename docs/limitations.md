# Limitations

What CAPS 2.0 does **not** do. Written down so that a reader does not have to
discover a boundary by hitting it.

Every item here is a property of the implementation or of Linux, not a roadmap
item. Things that are merely "not built yet" live in
[`future-roadmap.md`](future-roadmap.md) instead.

---

## 1. Execution model

| Limitation | Why | What happens instead |
| --- | --- | --- |
| **No shell.** There is no `sh -c`, no glob expansion, no `$VAR`, no command substitution, no `&&`/`\|\|`/`;` chaining, no heredocs, no brace expansion, no tilde expansion. | A shell is a second language with its own quoting rules, and two lexers eventually disagree about one quoting case — always in the unsafe direction. | The **execution path** uses exactly **one** lexer, `parser_tokenize()` in the C engine, which honours quoting and backslash escapes. The browser and the gateway both call it (`--inspect`, `--run-line`) rather than re-implementing it. The legacy whitespace-only `parser_parse()` survives only behind `caps --parse`, which is a debug view and is never what runs. |
| **Not every Linux command.** Only an explicit allowlist, and per-command argument schemas. | An allowlist that grows without review is not an allowlist. | `GET /api/catalog` lists every command with its live argument schema. Unknown commands are **refused with a reason**, not attempted. |
| **Pipelines are `|`-only.** No `&&`, no `\|\|`, no redirection chaining across a pipeline. | Each of those needs its own execution semantics. | Pipes, redirections, and per-stage timeouts are supported; the connectives are not. |
| **`stderr` redirection is a terminal-route feature only.** `POST /api/sessions` accepts only `in`, `out`, and `append`, and rejects a `stderr` slot with 400. | The monitor protocol shares the child's `stderr` descriptor, so a redirected `stderr` is a redirection of the same stream CAPS diagnostics travel on. | `2>` and `2>>` are implemented and exercised on `POST /api/terminal/execute`. Both routes validate the target against the workspace policy; the engine opens each component descriptor-relatively with `openat()` and `O_NOFOLLOW`, uses `O_NONBLOCK`, and checks the opened file type. |
| **One command per execution request**, or one pipeline. | — | A pipeline is a single execution with N stages, not N executions. |

### `du` takes files, not directories

The workspace policy is **`confined-files`**: a path argument is resolved inside
the workspace and must be a **regular file**. A directory argument is refused.

`du .` and `du -sh .` are therefore both rejected, even though `du` normally
defaults to the current directory. This is the workspace confinement doing its
job: permitting directory arguments would let `du` walk the host filesystem and
report on paths the operator never granted.

Admitting directory traversal would require opening the sandbox to directory
reads, which is a security change, not a documentation change. The catalog's
`detail` field and the generated help say this in the same words.

---

## 2. Observability boundaries

| Limitation | Why |
| --- | --- |
| **No per-process network I/O.** | Linux publishes no per-process byte counters in procfs. There is no `/proc/<pid>/netstat`. Any figure would be inferred from socket state, which is a model, not a measurement. Host interface counters are reported; per-process attribution is not attempted. |
| **Disk I/O rates are device-level.** `/proc/diskstats` counts the device. | Including page-cache effects, and not attributable to a process. Per-process counters come from `/proc/<pid>/io` and are labelled as such. |
| **Replay is not live telemetry.** | Replay reconstructs from persisted events. It executes nothing and inspects no live PID. The UI labels the mode and the SSE attachment is disabled while replaying. |
| **Demo and Playground pages are not host telemetry.** | They create real CAPS executions and show real CAPS telemetry. They are not a source of host figures. |
| **One host.** | No aggregation across machines, no remote agent, no clustering. |
| **No complete process-tree telemetry.** | The gateway samples every direct PID reported by CAPS, including each pipeline stage. It does not discover arbitrary descendants forked by those processes. |
| **Thermal and cpufreq are frequently unavailable.** | A host with no thermal zone, or a container without `/sys` mounted, reports `UNAVAILABLE` with a reason. Nothing is modelled or estimated. |
| **PSS is usually absent.** | `smaps_rollup` makes the kernel walk page tables. It is read on a slow cadence for a bounded number of processes. Absent on most rows at any instant, which is stated rather than filled in. |
| **Load average is not CPU utilisation.** | Load is a queue-depth count including uninterruptible sleep. This project never converts it to a percentage. |
| **No eBPF, no tracing, no `perf`.** | |
| **No packet capture.** | Would require privileges CAPS does not assume. |

---

## 3. Host and platform

| Limitation | Detail |
| --- | --- |
| **Linux only.** | The engine is POSIX C using `fork`/`execvp`/`waitpid`/`pipe`/`setpgid`/`setrlimit`. The gateway's telemetry is `/proc` and `/sys`. A non-Linux host reports telemetry and pidfd as unavailable rather than pretending. |
| **WSL2 is not bare metal.** | Verified on WSL2 (`6.18.33.2-microsoft-standard-WSL2`). Two consequences, both reported honestly rather than worked around: `/sys/devices/system/cpu/cpufreq` is typically absent, so CPU frequency is `UNAVAILABLE`; and thermal discovery depends on what the guest exposes. |
| **Virtual-machine metrics are host metrics.** | On WSL2, `/proc/stat` and `/proc/meminfo` describe the guest. They are real readings of the guest kernel, and are labelled by source, but they are not physical-host figures. |
| **The workspace is a confinement boundary, not a jail.** | The gateway confines accepted paths, and the engine opens redirection components with `openat()` / `O_NOFOLLOW` and checks the final descriptor type. This is **not** a security sandbox: it does not use namespaces, seccomp, or cgroups. |

---

## 4. Security boundaries

Stated so the guarantee is not over-read. Full model in
[`../SECURITY.md`](../SECURITY.md).

- **Loopback by default.** The gateway refuses to start in loopback mode bound to
  a non-loopback host. Remote binding requires `CAPS_BIND_MODE=remote` **and**
  `CAPS_AUTH_TOKEN`.
- **No authentication in loopback mode.** Anything that can reach the port can
  execute allowlisted commands. That is the intended trust boundary for a local
  tool, and it is why the bind mode is a startup invariant rather than a
  request-time check.
- **`kill`, `pkill`, and `killall` are refused.** They can reach processes CAPS
  does not own, and `killall` performs no identity verification at all. CAPS
  signals only what it started, and the identity model is precise about when the
  check happens: the kernel identity — PID plus the start-time field of
  `/proc/<pid>/stat` — is captured at spawn and re-verified before **every
  delayed** escalation and for **every** signal delivered through `pidfd`. The
  *first* signal of a terminate or a timeout is a plain `kill(2)` to the PID the
  gateway itself just forked and has not yet reaped, and an unreaped child keeps
  its PID reserved, so it cannot have been recycled at that instant. That
  distinction is published rather than blurred, because
  [`../SECURITY.md`](../SECURITY.md) documents it and a reviewer will compare
  the two.
- **No container, namespace, or cgroup isolation.** A confined workspace is not a
  privilege boundary.
- **`RLIM_INFINITY` when a limit is unset.** Limits are opt-in. The UI publishes
  which are in force; nothing is silently assumed.
- **Single-operator tool.** No roles, no per-user policy, no audit trail beyond
  the session store.

---

## 5. Performance and scale

| Limitation | Detail |
| --- | --- |
| **The host collector samples the whole host.** | On a host with thousands of processes the per-process read is **budgeted** (`CAPS_MAX_SAMPLED_PROCESSES`, default 400). Rows past the budget carry identity fields only and say `sampled: false`. They are not silently zeroed and not silently dropped. |
| **PSS is off the fast path.** | For the reason in §2. |
| **The database grows until retention removes it.** | With `CAPS_RETENTION_DAYS=0` nothing is deleted. `/api/ready` publishes the policy in force. |
| **Discovery cadence bounds how fast a new process appears.** | Default 2 s. `capsOwned` therefore **converges** rather than appearing instantly — the UI reflects that rather than claiming immediacy. |
| **Single writer.** | One collector, one timer, synchronous on purpose: a collector returning promises would let two collections interleave their previous state, which is exactly how a delta gets computed against the wrong sample. |

---

## 6. Testing boundaries

| Limitation | Detail |
| --- | --- |
| **The browser suite is behavioural, not visual.** | `scripts/browser-smoke.sh` checks the production HTTP/SSE/replay path, and `web/frontend/scripts/browser-smoke.mjs` checks Chromium keyboard, reduced-motion, mobile navigation, route history, a real execution, and the WebGL fallback. It does **not** diff pixels: there is no visual-regression infrastructure here. |
| **Clang and sanitizer availability depend on the verification host.** | `scripts/verify-linux.sh` requires GCC, Clang, Node 22.5+, npm, Chromium dependencies, and the listed POSIX tools. CI and the documented WSL2 verification environment run both GCC and Clang suites with ASan/UBSan. |
| **Sanitizer runs need bounded allocators under memory pressure.** | `allocator_may_return_null=1` and `hard_rss_limit_mb` are set for the workload suites so an exhausted environment becomes an ordinary test failure instead of losing the VM. |
| **Real zombies need a helper.** | A shell cannot produce one; the pidfd suite drives `tests/helpers/zombie_maker.c`. |

---

## 7. What "the truth model" does and does not promise

It promises that every reported figure carries a value, a unit, a source, a
timestamp, a provenance, and — when unavailable — a reason. That `UNAVAILABLE` is
never zero, and that a missing capability is stated rather than simulated.

It does **not** promise that every figure is available on every host. On a host
without `CONFIG_PSI`, PSI is absent. On a host without thermal zones, the guard
does not run. On WSL2, CPU frequency is unavailable. Those are correct outputs,
not failures.

---

## See also

- [`../README.md`](../README.md) — what the project is
- [`observability-model.md`](observability-model.md) — the observed/not-observed statement
- [`host-telemetry.md`](host-telemetry.md) — every metric and its provenance
- [`guardrails.md`](guardrails.md) — what is enforced, and what is not
- [`../SECURITY.md`](../SECURITY.md) — threat model
- [`future-roadmap.md`](future-roadmap.md) — what is planned rather than limited
