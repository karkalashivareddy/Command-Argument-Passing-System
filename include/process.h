#ifndef CAPS_PROCESS_H
#define CAPS_PROCESS_H

#include <sys/types.h>

#include "monitor.h"

/*
 * I/O redirection for an external command.
 *
 * path is owned by the redirection array and is released by
 * parser_free_redirections() (see parser.h).  fd is scratch state used
 * by process_exec() only: it holds the opened file descriptor while
 * the command is launched and is always closed before process_exec()
 * returns.
 */
typedef enum {
    CAPS_REDIR_IN = 0,   /* <   : read from file (stdin, fd 0)  */
    CAPS_REDIR_OUT,      /* >   : write/truncate file (fd 1)   */
    CAPS_REDIR_APPEND,   /* >>  : append file (fd 1)            */
    CAPS_REDIR_ERR_OUT,  /* 2>  : write/truncate file (fd 2)   */
    CAPS_REDIR_ERR_APPEND/* 2>> : append file (fd 2)            */
} caps_redir_type_t;

typedef struct {
    caps_redir_type_t type;
    char *path;
    int fd;
    /*
     * The standard descriptor this redirection replaces: 0 for `<`, 1 for
     * `>`/`>>`, 2 for `2>`/`2>>`.
     *
     * It is stored rather than derived at use time so that the redirection
     * array is a complete description of the wiring.  Deriving it from
     * `type` with a switch would work, but it would put the fd knowledge in
     * two places, and a new redirection type would silently default to
     * stdout -- which is exactly the bug that sends a program's error output
     * into its data file.
     */
    int target_fd;
} redirection_t;

/* The standard descriptor a redirection type replaces. */
static inline int caps_redir_fd(caps_redir_type_t type)
{
    switch (type) {
    case CAPS_REDIR_IN:         return 0;
    case CAPS_REDIR_ERR_OUT:
    case CAPS_REDIR_ERR_APPEND: return 2;
    case CAPS_REDIR_OUT:
    case CAPS_REDIR_APPEND:
    default:                    return 1;
    }
}

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

/* ------------------------------------------------------------------ pipeline
 *
 * A pipeline is a list of stages connected by real pipes.  Each stage is a
 * complete command: its own argv, its own redirections, its own PID, and its
 * own lifecycle.  The connection between stage i and stage i+1 is an OS pipe
 * file descriptor, not a string.
 *
 * These types live here, not in parser.h, because a stage owns a
 * redirection_t and parser.h already includes this header.  Defining them in
 * parser.h and including parser.h from here would be a circular include and
 * would leave the struct definition invisible to whichever header was read
 * second.
 *
 * `stdin_source` and `stdout_dest` are display strings describing where a
 * stage's standard input came from and where its standard output went
 * ("pipe:stage0", "inherit", "workspace/out.txt", ...).  They are evidence
 * for the reader; the actual wiring is performed by process_exec_pipeline()
 * from the pipe descriptors, never from these strings.
 */

typedef struct {
    char **argv;              /* NULL-terminated, owned by the pipeline   */
    int argc;
    redirection_t *redirs;    /* owned by the pipeline                   */
    int nredirs;
    /* Display-only description of the resolved wiring. */
    char stdin_source[64];
    char stdout_dest[64];
} caps_stage_t;

typedef struct {
    caps_stage_t *stages;
    int count;
} caps_pipeline_t;

/*
 * Run a pipeline as real processes connected by real pipes.
 *
 * For `a | b` CAPS performs:
 *
 *     pipe(p)                       ->  p[0] read end, p[1] write end
 *     fork()                          stage 0:  dup2(p[1], STDOUT), close p[0], p[1]
 *     fork()                          stage 1:  dup2(p[0], STDIN),  close p[0], p[1]
 *     execvp() in each child
 *     waitpid() on each child
 *
 * So the two programs are connected by a kernel pipe object.  There is no
 * string concatenation, no `sh -c`, and no parent-side copying of bytes: the
 * data path is the same one a real shell would build.
 *
 * Each stage becomes its own process with its own PID, process group, and
 * lifecycle events.  A three-stage pipeline is three processes, not one
 * process described three times.
 *
 * PROCESS GROUP
 * -------------
 * The first child is made a process-group leader with setpgid(0, 0) before
 * exec.  Subsequent children join that group.  This is what makes the whole
 * pipeline addressable as one unit for a timeout or a SIGINT: signalling the
 * group reaches a sleeping stage 0 and the stage 1 consumer together, instead
 * of orphaning stage 0 when stage 1 exits first.
 *
 * There is a deliberate race here and it is the POSIX one: the child may
 * exec before the parent's setpgid lands.  The child therefore also calls
 * setpgid(0, 0) for stage 0, which is idempotent when the parent already won
 * the race and a no-op success when the child won it.  setpgid() returning
 * EPERM after the child has already exec'd is expected and is not an error.
 *
 * EXIT STATUS
 * -----------
 * A pipeline's status is the LAST stage's status, matching shell convention:
 * `producer | consumer` reports whether the consumer succeeded.  Every stage's
 * own status is still recorded and observable, so a failure in stage 0 is not
 * hidden by a successful stage 1.
 */
int process_exec_pipeline(caps_pipeline_t *pipeline, int *last_raw_status,
                          caps_monitor_t *mon);

#endif /* CAPS_PROCESS_H */
