# Real-Time Execution Monitoring

Status: **implemented and shipped** (originally Phase 11 of the 1.x plan; see
[`../CHANGELOG.md`](../CHANGELOG.md) for the shipped 2.0.0 event contract)

`caps --monitor` attaches an observational event stream to command
execution. Events are emitted **at the moment each lifecycle step
occurs** and written immediately to **stderr**; nothing is buffered
until the end of the run. The monitor never changes what the shell
does: it is a write-only observer, and normal `caps` builds (no
`--monitor`) pass a `NULL` sink and pay no cost.

Source: `include/monitor.h`, `src/monitor.c`, and the emit points in
`src/process.c` / `src/main.c`.

---

## 1. Invocation

```text
caps --monitor [--json] [<command> [argument ...]]
```

| Form                                   | Effect                                            |
| -------------------------------------- | ------------------------------------------------- |
| `caps --monitor`                       | interactive REPL with events                      |
| `caps --monitor echo hi`               | one-shot execution with events                    |
| `caps --monitor --json`                | interactive REPL, one JSON object per line        |
| `caps --monitor --json echo hi`        | one-shot, one JSON object per line                |

Events go to stderr; the command's own stdout is untouched, so
`caps --monitor --json ls > files.txt` keeps stderr machine-readable
while stdout stays clean.

In `--json` REPL mode the banner and the `caps>` prompt are suppressed
so that every stderr line is a JSON object. In text mode the banner and
prompt are shown as usual.

Requesting `--monitor` is explicit, so a monitor that cannot be created
is a startup failure: caps prints `caps: monitor setup failed` and exits
non-zero instead of silently running without the requested event stream.
Normal (non-monitor) execution is unaffected.

---

## 2. Why it is genuinely real time

- Emission is **event-driven inside the existing foreground lifecycle**:
  `main` emits on read/parse/dispatch, `process_exec` emits on
  redirection open, `fork`, and `waitpid` completion.
- The sink flushes after every event (`fflush`), so a reader sees each
  event without waiting for the next.
- There is **no monitoring thread, no polling, no `sleep()`**, and no
  background reader. The monitor cannot fabricate progress it did not
  observe.

---

## 3. The event model

Fifteen event types, exactly as declared in `include/monitor.h`:

| Event                | Emitted when                                        | Key fields             |
| -------------------- | --------------------------------------------------- | ---------------------- |
| `COMMAND_RECEIVED`   | a non-empty line was read (REPL) or argv given      | `command`              |
| `PARSED`             | tokenization + redirection split succeeded          | `command` (rejoined)   |
| `COMMAND_PARSE_ERROR`| tokenizer/redirection syntax error                  | `command` (raw line)   |
| `PIPELINE_PARSED`    | a line parsed into **more than one** stage          | `stages`, `stage` (`-1`), `command` |
| `REDIRECTION_OPENED` | all redirection files opened (only if `nredirs > 0`)| `command`              |
| `REDIRECTION_FAILED` | an `open()` failed; command aborted                 | `command`              |
| `PIPELINE_STARTED`   | the first pipeline stage forked; carries the group the rest join | `pid`, `pgid`, `stage`, `stages`, `outcome`, `command` |
| `PROCESS_STARTED`    | `fork()` returned a child pid                       | `pid`, `pgid`, `stage`, `stages`, `command`, `argv` |
| `PROCESS_EXITED`     | `waitpid()` reaped a child                          | `pid`, `pgid`, `stage`, `stages`, `exit_code`, `duration_ms`, `outcome`, `command` |
| `SIGNAL_RECEIVED`    | child was terminated by a signal                    | `pid`, `pgid`, `stage`, `stages`, `signal`, `outcome`, `command` |
| `EXEC_ERROR`         | child reports its saved `execvp()` errno through a close-on-exec status pipe | `pid`, `exit_code`, `errno`, `errno_name`, `reason`, `outcome`, `command` |
| `WAIT_FAILED`        | `waitpid()` failed permanently, so the process outcome is unknown | `exit_code: null`, `errno`, `reason`, `duration_ms`, `outcome`, `command` |
| `EXECUTION_FAILED`   | CAPS could not launch the child at all               | `exit_code: null`, `errno`, `reason`, `duration_ms`, `outcome`, `command` |
| `PIPELINE_COMPLETED` | every stage of a pipeline was reaped; carries the last stage's outcome | `pid`, `pgid`, `stages`, `stage` (`-1`), `outcome`, `command` |
| `SESSION_SUMMARY`    | end of session                                      | session counters       |

Ordering for a normal external command:

```text
COMMAND_RECEIVED
PARSED
[REDIRECTION_OPENED]        # only when a redirection was parsed
PROCESS_STARTED
PROCESS_EXITED              # or: SIGNAL_RECEIVED then PROCESS_EXITED
[SESSION_SUMMARY]           # when the session ends
```

Ordering for a pipeline, which adds the three envelope events:

```text
COMMAND_RECEIVED
PARSED
PIPELINE_PARSED             # only when the line has more than one stage
PIPELINE_STARTED            # stage 0 forked; carries the pgid the rest join
PROCESS_STARTED             # every stage, in stage order, immediately after the fork
PROCESS_EXITED              # per stage, in whatever order the stages actually finish
PIPELINE_COMPLETED
[SESSION_SUMMARY]
```

Stage lifecycle events are **not** interleaved by stage index: stage 1 can be
reaped before stage 0. That is real reaping order, not a sorted view, which is
why `stage` is on every event and a consumer sorts rather than assumes.

Built-ins emit `COMMAND_RECEIVED` and `PARSED` but no process events
(they never fork). A parse failure emits `COMMAND_RECEIVED` then
`COMMAND_PARSE_ERROR`.

### Fields every process event carries, and why

`pgid`, `stage`, and `stages` are emitted **unconditionally**, on every process
and pipeline event:

- `stages` is the number of stages in the execution and `stage` is this event's
  index. A single command reports stage `0` of `1`. `PIPELINE_PARSED` and
  `PIPELINE_COMPLETED` describe the pipeline as a whole rather than one stage,
  so they carry `stage: -1` alongside the real `stages` count — a value that
  cannot be confused with a stage index, which is what makes "which stage?" and
  "which pipeline?" separable without inferring either from the event type.
- `pgid` is the process group. A pipeline gets its own group with stage 0 as
  leader, which is what makes a timeout reach every stage. A single command has
  no group of its own, so its `pgid` is `0`: the field is always present, and its
  value is what says whether the pipeline case applies.

Emitting them always means no consumer has to infer "was this a pipeline?" from
the absence of a field, and `stage: -1` means "not a stage event" explicitly
rather than by omission.

`outcome` is the machine-readable terminal verdict, one of `COMPLETED`,
`EXITED`, `SIGNALED`, `EXEC_FAILED`, `LAUNCH_FAILED`, `WAIT_FAILED`. It is
emitted separately from `exit_code` because "the program ran and exited 3" and
"the program was killed by signal 9" both have an exit code, and only one of
them is an ordinary failure.

`argv` is emitted on `PROCESS_STARTED` alongside the joined `command` label,
because the label alone is lossy: an element containing a space and two elements
that do not both render as the same text. Re-splitting the label would be a
second lexer, and two lexers eventually disagree about one quoting case — always
in the unsafe direction, where the record says what ran and it is wrong. The
vector is bounded, and truncation is **explicit**: when elements are dropped,
`argv_truncated: true` appears with `argv_elements_dropped` and
`argv_elements_total`, and `argv[0]` is always kept whatever the budget.

---

## 4. Output formats

### Text (default)

```text
[12:34:56.789] COMMAND_RECEIVED       echo hi
[12:34:56.789] PARSED                 echo hi
[12:34:56.790] PROCESS_STARTED        pid=12345
[12:34:56.792] PROCESS_EXITED         pid=12345 status=0 duration=2ms
Session Summary
---------------
Commands: 1
Succeeded: 1
Failed: 0
Signals: 0
Exec errors: 0
Launch/wait errors: 0
Average duration: 2.0 ms
```

Text mode carries the same `exec_errors` and `launch/wait errors` counters as the
JSON summary, for the same reason: the summary is a statement about what was
observed, not a success claim. When `duration_ms` is unavailable, the text line
prints `duration=UNAVAILABLE` rather than `duration=0ms`.

### JSON (`--json`)

One object per line (the `SESSION_SUMMARY` object carries no `time`):

```json
{"event":"COMMAND_RECEIVED","time":"12:34:56.789","command":"echo hi"}
{"event":"PARSED","time":"12:34:56.789","command":"echo hi"}
{"event":"PROCESS_STARTED","time":"12:34:56.790","pid":12345,"pgid":12345,"stage":0,"stages":1,"command":"echo hi","argv":["echo","hi"]}
{"event":"PROCESS_EXITED","time":"12:34:56.792","pid":12345,"pgid":12345,"stage":0,"stages":1,"exit_code":0,"duration_ms":2,"outcome":"COMPLETED","command":"echo hi"}
{"event":"SESSION_SUMMARY","commands":1,"succeeded":1,"failed":0,"signals":0,"timed":1,"exec_errors":0,"launch_errors":0,"observed_cleanly":true,"average_duration_ms":2.0}
```

`SESSION_SUMMARY` always carries `exec_errors`, `launch_errors`, and
`observed_cleanly` in addition to the counters. They are not conditional:
`exec_errors` counts `EXEC_ERROR` events, `launch_errors` counts
`EXECUTION_FAILED` and `WAIT_FAILED`, and `observed_cleanly` is
`exec_errors == 0 && launch_errors == 0`. A session where nothing could be
launched still emits the summary with `observed_cleanly: false`, which is the
only place that fact appears as a single boolean.

Field notes:

- `time` is a display-only wall-clock stamp from `CLOCK_REALTIME`
  (`HH:MM:SS.mmm`). If the realtime clock or its `localtime_r()`
  conversion cannot be read, the field is the fixed placeholder
  `??:??:??.???` — the event is still emitted, so a failing clock
  degrades a display field instead of corrupting the JSON.
- `duration_ms` is real elapsed time from `CLOCK_MONOTONIC`, measured in
  `process.c` between `fork()` and reap. It is not the wall-clock difference,
  and it is **unavailable, never zero**, when the monotonic clock cannot be
  sampled at either end: `elapsed_ms()` in `src/process.c` returns `-1` for
  that case, and `src/monitor.c` emits the JSON literal `null`. A field that
  could be `0` cannot also mean "not measured", so the two are kept distinct
  here too. A real measurement is always `>= 0`.
- `command` is a **bounded** label: the event builder joins `argv` into a
  fixed 256-byte buffer (`caps_join_argv`), so a command line longer than
  that is truncated **in the label only**. Execution always receives the
  complete, untruncated `argv`. The label cap keeps every JSON line
  well-formed and finite.
- Command strings are JSON-escaped (quotes, backslashes, control
  characters), preserving the one-object-per-line guarantee.
- On `SIGNAL_RECEIVED`, `signal` is the signal number; the following
  `PROCESS_EXITED` carries `exit_code = 128 + signal`.
- `EXEC_ERROR` is raised only when the child reports the saved `errno`
  from a failed `execvp()` through the close-on-exec status pipe. A
  program that successfully execs and exits with `126` or `127` is
  therefore reported as `PROCESS_EXITED` with that exit code.

---

## 5. What the monitor is not

- It is not a profiler, tracer, or `ptrace` front end.
- It does not observe the child's internal system calls, only the
  parent-side lifecycle facts (`fork`, reap, status).
- It does not synchronize execution; disabling it changes nothing about
  behavior or timing guarantees.
- It has no persistence: events live only in the stderr stream.

---

## 6. Testing

`tests/test_monitor.sh` runs `caps --monitor` and `--monitor --json`
against the deterministic `status_probe` helper and asserts:

- exact event **ordering** for success, signal, and exec-error runs;
- exactly one `PROCESS_EXITED`, with the expected `exit_code`;
- presence of `duration_ms >= 0`;
- the REPL sequence across two commands and the session summary
  counters;
- every JSON line parses as an object (validated with `jq` when
  available; otherwise a shape check and the absence of interleaved
  non-JSON lines);
- a 2000-character argument reaches the program intact while the event
  label stays bounded, proving the display cap never truncates `argv`.

`make test` and `make test-asan` both run it.
