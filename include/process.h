#ifndef CAPS_PROCESS_H
#define CAPS_PROCESS_H

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
                 int *raw_status);

/* Print a human-readable summary of a raw wait() status (per WIFEXITED
 * / WIFSIGNALED) to stderr, naming the command that produced it. */
void process_report_status(const char *command, int status);

#endif /* CAPS_PROCESS_H */