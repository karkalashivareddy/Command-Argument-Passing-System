#ifndef CAPS_SIGNALS_H
#define CAPS_SIGNALS_H

/*
 * Minimal signal model for caps.  This is deliberately NOT job control.
 *
 * Model:
 *   - The parent process ignores SIGINT for its whole lifetime
 *     (signals_parent_init).  Ctrl+C in the terminal sends SIGINT to
 *     the entire foreground process group; the parent discards it, so
 *     the REPL survives.
 *   - Because POSIX exec preserves SIG_IGN across exec (only *caught*
 *     signals are reset to default), a child that inherits the parent's
 *     SIG_IGN would also ignore Ctrl+C.  Therefore the child explicitly
 *     restores SIGINT to SIG_DFL immediately after fork() and before
 *     execvp() (signals_child_reset), so the executed program keeps the
 *     normal "die on Ctrl+C" behavior.
 *   - All other signals retain their default dispositions (SIGTERM,
 *     SIGQUIT, SIGSEGV, ...).  A SIGTERM therefore still terminates
 *     caps normally.
 *
 * Error policy: both functions return 0 on success and -1 on failure.
 * A failure is reported (never swallowed) and the caller decides how to
 * proceed; neither function pretends a failed sigaction() succeeded.
 *
 * Limitations (documented honestly):
 *   - At the prompt, Ctrl+C does nothing (no line-cancellation UI) and
 *     does not abort the current read.
 *   - No process groups, no foreground/background assignment, no
 *     WUNTRACED/WCONTINUED job status machinery.
 */

/*
 * Ignore SIGINT in the parent.  Returns 0 on success; on failure reports
 * the error via caps_error() and returns -1 (the REPL may continue in a
 * degraded state where Ctrl+C can also kill the parent).
 */
int signals_parent_init(void);

/*
 * Restore SIGINT to SIG_DFL in the child, after fork() and before
 * execvp().  Returns 0 on success, -1 on failure.  The failure is NOT
 * reported here (the child must not use stdio after fork()); the caller
 * reports it with write(2) and may continue to exec.
 */
int signals_child_reset(void);

#endif /* CAPS_SIGNALS_H */
