#ifndef CAPS_PROCESS_H
#define CAPS_PROCESS_H

/*
 * Run an external command using fork() + execvp() + waitpid().
 *
 * argv must be NULL-terminated (argv[argc] == NULL) and argv[0] must
 * be the command name.
 *
 * Returns the child's outcome following shell conventions:
 *   - child exited with code N            -> N
 *   - child terminated by signal S        -> 128 + S
 *   - execvp() failed, file not found     -> 127
 *   - execvp() failed, permission denied  -> 126
 *   - fork()/waitpid() failure            -> EXIT_FAILURE
 *
 * The child never returns into the caller: after a failed execvp()
 * it reports the error on stderr and terminates with _exit().
 */
int process_exec(char *const argv[]);

/* Print a human-readable summary of a raw wait() status (per WIFEXITED
 * / WIFSIGNALED) to stderr, naming the command that produced it. */
void process_report_status(const char *command, int status);

#endif /* CAPS_PROCESS_H */