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

### Setup failures are reported, not ignored

`signals_parent_init()` and `signals_child_reset()` both return `int`
(0 on success, -1 if `sigaction()` fails):

- **Parent setup fails:** `signals_parent_init()` prints
  `caps: sigaction(SIGINT, SIG_IGN): <strerror(errno)>` — the actual
  syscall failure, reported once by the function that owns the syscall —
  and `main` keeps running. The REPL remains usable; only the Ctrl+C
  protection is degraded, and the user is told so. `main` deliberately
  does not print a second, redundant warning for the same failure.
- **Child reset fails:** the child prints
  `caps: warning: failed to reset SIGINT in child; the executed program
  may ignore Ctrl+C` (via `write(2)`, before `exec`), then proceeds to
  `execvp()`. The launched program may therefore ignore Ctrl+C, which
  is exactly the condition being warned about.

Reporting the degradation is preferable to silently pretending signal
handling succeeded.

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
- No process groups: all commands run in caps's own process group.
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
