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
 * Limitations (documented honestly):
 *   - At the prompt, Ctrl+C does nothing (no line-cancellation UI) and
 *     does not abort the current read.
 *   - No process groups, no foreground/background assignment, no
 *     WUNTRACED/WCONTINUED job status machinery.
 */
void signals_parent_init(void);
void signals_child_reset(void);

#endif /* CAPS_SIGNALS_H */