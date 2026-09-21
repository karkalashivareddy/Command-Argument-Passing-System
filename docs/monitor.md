# Real-Time Execution Monitoring

Status: **implemented (Phase 11)**

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

| Event                | Emitted when                                        | Key fields             |
| -------------------- | --------------------------------------------------- | ---------------------- |
| `COMMAND_RECEIVED`   | a non-empty line was read (REPL) or argv given      | `command`              |
| `PARSED`             | tokenization + redirection split succeeded          | `command` (rejoined)   |
| `COMMAND_PARSE_ERROR`| tokenizer/redirection syntax error                  | `command` (raw line)   |
| `REDIRECTION_OPENED` | all redirection files opened (only if `nredirs > 0`)| `command`              |
| `REDIRECTION_FAILED` | an `open()` failed; command aborted                 | `command`              |
| `PROCESS_STARTED`    | `fork()` returned a child pid                       | `pid`, `command`       |
| `PROCESS_EXITED`     | `waitpid()` reaped a normally-exited child          | `pid`, `exit_code`, `duration_ms` |
| `SIGNAL_RECEIVED`    | child was terminated by a signal                    | `pid`, `signal`        |
| `EXEC_ERROR`         | child exited `126`/`127` (exec failed)              | `pid`, `command`       |
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

Built-ins emit `COMMAND_RECEIVED` and `PARSED` but no process events
(they never fork). A parse failure emits `COMMAND_RECEIVED` then
`COMMAND_PARSE_ERROR`.

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
Average duration: 2.0 ms
```

### JSON (`--json`)

One object per line (the `SESSION_SUMMARY` object carries no `time`):

```json
{"event":"COMMAND_RECEIVED","time":"12:34:56.789","command":"echo hi"}
{"event":"PARSED","time":"12:34:56.789","command":"echo hi"}
{"event":"PROCESS_STARTED","time":"12:34:56.790","pid":12345,"command":"echo hi"}
{"event":"PROCESS_EXITED","time":"12:34:56.792","pid":12345,"exit_code":0,"duration_ms":2,"command":"echo hi"}
{"event":"SESSION_SUMMARY","commands":1,"succeeded":1,"failed":0,"signals":0,"timed":1,"average_duration_ms":2.0}
```

Field notes:

- `time` is a display-only wall-clock stamp from `CLOCK_REALTIME`
  (`HH:MM:SS.mmm`).
- `duration_ms` is real elapsed time from `CLOCK_MONOTONIC`, measured in
  `process.c` between `fork()` and reap. It is not the wall-clock
  difference.
- Command strings are JSON-escaped (quotes, backslashes, control
  characters), preserving the one-object-per-line guarantee.
- On `SIGNAL_RECEIVED`, `signal` is the signal number; the following
  `PROCESS_EXITED` carries `exit_code = 128 + signal`.
- `EXEC_ERROR` is raised when the child exits `126` or `127`. This is a
  **heuristic**: those codes are the shell convention for a failed
  `exec`, and the event reports that the child exited with such a code —
  a program that itself exits `127` without an exec failure is
  indistinguishable at this layer.

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
  non-JSON lines).

`make test` and `make test-asan` both run it.
