# Signal Handling

Status: **implemented (Phase 7)**

This document describes caps's signal model and its honest limits.

---

## 1. What caps implements

A small, deliberate model — **not** job control:

| Behavior | Mechanism |
| -------- | --------- |
| SIGINT (Ctrl+C) while a foreground child runs | the child keeps the default disposition, so it dies; `waitpid()` reports `WIFSIGNALED`, `WTERMSIG == SIGINT`, and caps maps it to exit 130 (`128 + 2`) |
| The parent survives Ctrl+C | the parent ignores SIGINT for its entire lifetime |
| A producer in `producer \| consumer` whose consumer exits first | the child has SIGPIPE at its default disposition, so the kernel kills it; the engine records `SIGNAL_RECEIVED` with `signal = 13` and exit 141 (`128 + 13`) |
| SIGTERM, SIGQUIT, SIGSEGV, ... | default dispositions (a SIGTERM still terminates caps) |
| SIGCHLD | default; caps reaps synchronously with `waitpid()`, so no SIGCHLD handler is needed |

### Setup failures are fatal, not degraded

`signals_parent_init()` and `signals_child_reset()` both return `int`
(0 on success, -1 if `sigaction()` fails), and both callers **refuse to
carry on**. The policy is fail-closed:

- **Parent setup fails:** `signals_parent_init()` reports the actual
  syscall failure (`caps: sigaction(SIGINT, SIG_IGN): <strerror(errno)>`)
  and `main` prints `cannot initialise the signal model; refusing to
  start` and returns `EXIT_FAILURE` (`src/main.c`). If SIGINT cannot be
  ignored, Ctrl+C would also kill caps while a child runs, and the
  guarantee "the REPL survives Ctrl+C" would be false while the process
  behaved as though it were true.
- **Child reset fails:** the child reports it with `write(2)` before any
  stdio, writes the errno to the status pipe, and `_exit(126)`s
  **without calling `execvp()`** (`src/process.c`, on both the
  single-command path and each pipeline stage). POSIX `exec` preserves
  `SIG_IGN`, so exec'ing with the reset undone would hand the program a
  disposition CAPS never promised — it would survive Ctrl+C, and a
  pipeline producer would take `EPIPE` instead of dying of `SIGPIPE`.

The refusal travels on the status pipe like any other launch failure, so
the parent classifies it rather than guessing. Running a program whose
signal semantics are wrong would be worse than not running it.

---

## 2. Why the child states its own dispositions

The key POSIX rule (`exec(3p)`, `execve(2)`):

> Signals set to be *caught* by the calling process reset to the default
> action across `exec`.  Signals set to be *ignored* remain ignored.

Sequence in caps:

1. Parent starts, sets SIGINT to `SIG_IGN`
   (`signals_parent_init()`).
2. Parent `fork()`s — the child inherits `SIG_IGN`.
3. Child calls `signals_child_reset()`: **both** SIGINT and SIGPIPE are set to
   `SIG_DFL`, explicitly, rather than left as inherited.
4. Child calls `execvp()` — because the child is using the *default*
   dispositions (not ignored), the new program starts with `SIG_DFL` for both.

If step 3 were omitted, SIG_IGN would survive `exec`, and Ctrl+C would
be silently discarded by the running program too — exactly the bug
minimal shells get wrong.

### SIGPIPE is the second half of the same rule

The engine ignores SIGINT in the parent, so it must restore it in the child.
It also **inherits** whatever SIGPIPE disposition the process that launched it
had. POSIX keeps an ignored signal ignored across `exec`, so a host shell, a
package manager, a container runtime, or a CI step wrapper that sets SIGPIPE to
`SIG_IGN` for its own reasons changes what `producer | consumer` means inside the
engine:

- the producer takes `EPIPE` instead of dying,
- it prints `Broken pipe` and exits with its own non-zero status,
- and there is no signal anywhere in the event stream.

That is not a slower version of the correct behaviour; it is a different one.
The same command line has to mean the same thing in every environment, so the
child disposition is **stated**, not inherited. `tests/test_pipeline.sh` asserts
the property under `trap '' PIPE`, and `tests/helpers/sigpipe_writer.c` is the
first-party producer that proves it without depending on any `yes` implementation.

Resource limits are stated for the same reason; see
[guardrails.md](guardrails.md).

---

## 3. How Ctrl+C behaves

A terminal Ctrl+C sends SIGINT to **the whole foreground process
group**, which contains both caps and the running child:

```text
terminal Ctrl+C
      |
      v   SIGINT
foreground process group
   /            \
  v              v
caps (parent)   child (running program)
  SIG_IGN        SIG_DFL
  survives       terminates
                     |
                     v
              waitpid() -> WIFSIGNALED(2)
              caps reports: terminated by signal 2
              caps : map to exit 130
```

---

## 4. Why caps reports rather than handles child signals

`waitpid()` without `WUNTRACED`/`WCONTINUED` returns exactly one
outcome per child: it exited or it died from a signal.  The macros
`WIFEXITED`/`WEXITSTATUS` and `WIFSIGNALED`/`WTERMSIG` decode that
outcome.  "Handling" the signal inside the child would change the 
program's behavior; caps would rather observe and report it.

---

## 5. Honest limitations

- At the prompt, Ctrl+C does **nothing** — the parent ignores SIGINT,
  and there is no line-cancellation UI (a full interactive `readline`
  would be needed).
- One process group per **pipeline**, not per interactive command.
  `process_exec_pipeline()` calls `setpgid()` so the stages are one
  addressable unit with stage 0 as the group leader, and `pgid` is
  reported on `PROCESS_STARTED` / `PROCESS_EXITED` as evidence. A
  single command has no group of its own. That exists so a signal can
  reach every stage; it is signal delivery, not job control.
- No foreground/background jobs.
- No `SIGTSTP` (Ctrl+Z) stop/resume support.
- No `WUNTRACED`/`WCONTINUED` job-status reporting.

These are outside the project's scope and are recorded as future work.

---

## 6. Testing

Automated coverage:

- child resolving SIGINT to the default disposition is verified with
  the deterministic `status_probe signal 2` helper (a child that *kept*
  SIG_IGN would return 0 instead of dying with signal 2);
- the parent's SIG_IGN is verified by sending SIGINT to a live caps
  process and confirming it survives and still reaps its child
  correctly;
- the `128 + signal` exit-code mapping for SIGTERM/SIGSEGV/SIGINT.
