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
 * A failure is reported (never swallowed) and the caller REFUSES rather
 * than proceeding: main() refuses to start, and process.c refuses to
 * execvp(), because running with an inherited SIG_IGN would hand the
 * executed program a signal disposition CAPS never promised.  Neither
 * function pretends a failed sigaction() succeeded, and no caller
 * degrades past it.
 *
 * Limitations (documented honestly):
 *   - At the prompt, Ctrl+C does nothing (no line-cancellation UI) and
 *     does not abort the current read.
 *   - No foreground/background assignment, no `&`, no job control, and no
 *     WUNTRACED/WCONTINUED job status machinery.  A PIPELINE does get its
 *     own process group (setpgid in process.c, stage 0 as leader) so a
 *     signal can reach every stage; that is signal delivery, not job
 *     control, and there is no interactive process group per command.
 */

/*
 * Ignore SIGINT in the parent.  Returns 0 on success; on failure reports
 * the error via caps_error() and returns -1.  The caller (main) REFUSES
 * to start on -1: a caps that cannot ignore SIGINT would be killed by
 * Ctrl+C while a child runs, so it must not run at all.
 */
int signals_parent_init(void);

/*
 * Restore SIGINT to SIG_DFL in the child, after fork() and before
 * execvp().  Returns 0 on success, -1 on failure.  The failure is NOT
 * reported here (the child must not use stdio after fork()); the caller
 * reports it with write(2) and REFUSES to exec, writing the errno to the
 * status pipe and _exit()ing 126, on both the single-command path and
 * each pipeline stage.
 */
int signals_child_reset(void);

#endif /* CAPS_SIGNALS_H */
