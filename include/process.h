#ifndef CAPS_PROCESS_H
#define CAPS_PROCESS_H

/*
 * Run an external command using fork() + execvp() + waitpid().
 *
 * argv must be NULL-terminated (argv[argc] == NULL) and argv[0] must
 * be the command name.
 *
 * If raw_status is not NULL it receives the raw wait() status as
 * returned by waitpid(), suitable for WIFEXITED/WEXITSTATUS and
 * WIFSIGNALED/WTERMSIG.  This lets the interactive REPL report the
 * child's outcome without repeating the decoding logic.
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
int process_exec(char *const argv[], int *raw_status);

/* Print a human-readable summary of a raw wait() status (per WIFEXITED
 * / WIFSIGNALED) to stderr, naming the command that produced it. */
void process_report_status(const char *command, int status);

#endif /* CAPS_PROCESS_H */