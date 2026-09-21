#ifndef CAPS_PROCESS_H
#define CAPS_PROCESS_H

#include <sys/types.h>

#include "monitor.h"

/*
 * I/O redirection for an external command.
 *
 * path is owned by the redirection array and is released by
 * parser_free_redirections() (see parser.h).  fd is scratch state used
 * by process_exec() only: it holds the opened file descriptor while the
 * command is launched and is always closed before process_exec()
 * returns.
 */
typedef enum {
    CAPS_REDIR_IN = 0,   /* <  : read from file (stdin)  */
    CAPS_REDIR_OUT,      /* >  : write/truncate file     */
    CAPS_REDIR_APPEND    /* >> : write/append file       */
} caps_redir_type_t;

typedef struct {
    caps_redir_type_t type;
    char *path;
    int fd;
} redirection_t;

/*
 * Run an external command using fork() + execvp() + waitpid().
 *
 * argv must be NULL-terminated (argv[argc] == NULL) and argv[0] must
 * be the command name.  redirs/nredirs describe optional std-io
 * redirection applied to the child before exec (may be NULL/0).
 *
 * mon may be NULL; when non-NULL, process_exec() emits the observable
 * lifecycle events (redirection opened/failed, process started, process
 * exited, signal received, exec error) into the monitor as they occur.
 *
 * If raw_status is not NULL it receives the raw wait() status as
 * returned by waitpid(), suitable for WIFEXITED/WEXITSTATUS and
 * WIFSIGNALED/WTERMSIG.
 *
 * Returns the child's outcome following shell conventions:
 *   - child exited with code N            -> N
 *   - child terminated by signal S        -> 128 + S
 *   - execvp() failed, file not found     -> 127
 *   - execvp() failed, permission denied  -> 126
 *   - redirection open(), fork()/waitpid() failure -> EXIT_FAILURE
 *
 * The child never returns into the caller: after a failed execvp() it
 * reports the error on stderr and terminates with _exit().
 */
int process_exec(char *const argv[], redirection_t *redirs, int nredirs,
                 int *raw_status, caps_monitor_t *mon);

/*
 * Wait for one specific child to change state and store its raw wait()
 * status in *status.
 *
 * Returns 0 on success, -1 on a terminal waitpid() failure.  EINTR is
 * retried because the wait was interrupted, not the child; any other
 * errno is permanent -- ECHILD means the child was already reaped, and
 * options == 0 with a valid status pointer rules out EINVAL/EFAULT.  On
 * a terminal failure the outcome is unknown and the caller must not use
 * *status.
 */
int process_wait_child(pid_t pid, int *status);

/* Print a human-readable summary of a raw wait() status (per WIFEXITED
 * / WIFSIGNALED) to stderr, naming the command that produced it. */
void process_report_status(const char *command, int status);

#endif /* CAPS_PROCESS_H */
