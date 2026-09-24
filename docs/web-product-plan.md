# CAPS — Process Execution Observatory: Product Plan

**Tagline:** *See what a command becomes.*

## 1. Problem

A traditional terminal hides the entire operating-system lifecycle. Type
`echo Hello Shiva` and you see only `Hello Shiva`. The pipeline that made
that happen — parsing, `argv[]`, `fork()`, `execvp()`, `waitpid()`,
signals, exit status — is invisible. For an Operating Systems student the
terminal is a black box at the exact moment when the OS is most
interesting.

## 2. Product

CAPS Observatory is a real-time web observatory wrapped around the
existing **CAPS** command engine, a small educational C11/POSIX
implementation of `fork()` → `execvp()` → `waitpid()` execution.

The browser never executes commands itself. Every command is executed by
the real CAPS binary:

```
Browser → Web Gateway → ./caps → fork() → execvp() → waitpid()
     → monitor JSON → Web Gateway → SSE → Browser
```

The web layer is the observability + control + education layer. The C
engine remains the authoritative execution engine. No `shell: true`, no
`system()`, no `popen()`, no `child_process.exec()`.

## 3. Positioning (honest)

- CAPS is **not** a Bash replacement. It has a narrower execution scope
  (whitespace tokenization, no quoting/pipelines/job control) and exists
  to make the POSIX process lifecycle legible.
- CAPS Observatory is an **interactive operating-system laboratory**:
  every animation corresponds to a real event, every metric comes from
  real executions, every PID/exit/signal value comes from the operating
  system.
- No fake telemetry, no fake PIDs, no fake CPU/memory, no fake AI.

## 4. Core differentiators

1. **Execution Flight Recorder** — every command becomes a real event
   timeline (`COMMAND_RECEIVED → PARSED → PROCESS_STARTED → …`) streamed
   live over SSE and replayable afterward.
2. **Real process lifecycle visualization** — parent/fork/child/exec/wait
   topology driven by real event data.
3. **ARGV inspector** — the exact structured argument vector that was
   handed to `execvp()`.
4. **Signal laboratory** — run a real process, send a real signal, watch
   the real `waitpid()` interpretation.
5. **Redirection visualizer** — real `open()`/`dup2()`/`close()` file
   descriptor flow.
6. **Real analytics** — P50/P95/P99, success/failure, exit-code, signal
   and command distributions computed from stored executions only.

## 5. User journeys

### Journey A — First run: “See what a command becomes”

1. Land on `/` (Overview), engine shows `ENGINE ONLINE`, stream
   `LIVE STREAM CONNECTED`.
2. Type `echo Hello Shiva`, press `[ EXECUTE ]`.
3. The Execution Pipeline animates: INPUT → PARSE → ARGV → FORK → EXEC →
   WAIT → RESULT as real events arrive.
4. Open the argv inspector, see `argc = 3`, `argv[0]=echo`,
   `argv[1]=Hello`, `argv[2]=Shiva`, `argv[3]=NULL`.
5. Open the execution detail, replay it, see it in history and analytics.

### Journey B — Signals

1. Go to `/signals`. Run `sleep 10`.
2. See `RUNNING` with the real child PID.
3. Press `SEND SIGINT`.
4. The real `SIGNAL_RECEIVED signal=2` then `PROCESS_EXITED exit_code=130`
   events appear. No faking.

### Journey C — Redirection

1. Go to `/redirection`. Run `echo Hello > demo.txt`.
2. The fd diagram animates through `open()` → `dup2(fd, STDOUT_FILENO)`
   → `close(fd)` → `execvp()` using real `REDIRECTION_OPENED` events and
   the real flags (`O_WRONLY|O_CREAT|O_TRUNC`).

### Journey D — Faculty demo

`/demo` walks: overview → execute → argv → fork → SIGINT → redirection →
replay → analytics. Everything is real execution.

## 6. Metrics of success

- The observer can explain, after one run, exactly what fork/exec/wait
  did to their command.
- Every claimed value on screen maps to a field in a stored CAPS event or
  the structured request.
- `make test` and `make test-asan` continue to pass untouched.
- The full chain works: browser → API → `./caps` → real `fork()`/`execvp()`
  → real events → SSE → live UI → history → replay → analytics.

## 7. Non-goals (this release)

- No pipelines (`|`), job control, quoting, globbing, env expansion.
- No remote/multi-user execution; localhost-only by default.
- No CPU/memory/`/proc` telemetry (not implemented → shown `Unavailable`).
- No PostgreSQL/Kafka/Docker/Redis (not needed locally).
- No fake/fabricated observability of any kind.
