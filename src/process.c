#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <sys/wait.h>
#include <unistd.h>

#include "process.h"
#include "signals.h"
#include "utils.h"

/*
 * Report an exec/dup2 failure from inside the child process.
 *
 * After fork() the child shares a copy of the parent's stdio buffers.
 * Using fprintf()/exit() here could flush duplicated buffers and tear
 * the parent's pending output.  We therefore format into a small
 * stack buffer and write(2) directly to stderr, then _exit().
 * write() and strlen() are in the POSIX async-signal-safe set; this
 * is the minimal, correct child-side failure path.
 */
static void child_fatal_printf(const char *fmt, ...)
{
    char buf[256];
    va_list ap;

    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);

    if (n > 0) {
        size_t len = (size_t)n;
        if (len > sizeof buf - 1)
            len = sizeof buf - 1;
        (void)write(STDERR_FILENO, buf, len);
    }
}

static void child_exec_failure(const char *command)
{
    if (errno == ENOENT)
        child_fatal_printf("caps: command not found: %s\n", command);
    else if (errno == EACCES)
        child_fatal_printf("caps: %s: permission denied\n", command);
    else {
        const char *e = strerror(errno);
        child_fatal_printf("caps: %s: %s\n", command, e ? e : "unknown error");
    }
}

static int open_redirections(redirection_t *redirs, int nredirs)
{
    for (int i = 0; i < nredirs; i++) {
        int flags;

        switch (redirs[i].type) {
        case CAPS_REDIR_IN:
            flags = O_RDONLY;
            break;
        case CAPS_REDIR_APPEND:
            flags = O_WRONLY | O_CREAT | O_APPEND;
            break;
        default:
            flags = O_WRONLY | O_CREAT | O_TRUNC;
            break;
        }

        redirs[i].fd = open(redirs[i].path, flags, 0644);
        if (redirs[i].fd < 0) {
            caps_error("%s: %s", redirs[i].path, strerror(errno));
            for (int j = 0; j < i; j++)
                close(redirs[j].fd);
            return -1;
        }
    }
    return 0;
}

static void close_redirections(redirection_t *redirs, int nredirs)
{
    for (int i = 0; i < nredirs; i++) {
        if (redirs[i].fd >= 0)
            close(redirs[i].fd);
    }
}

/*
 * Called in the child, after fork() and before execvp(): wire the
 * already-open redirection descriptors onto stdin/stdout.
 * Never returns on failure.
 */
static void apply_redirections(redirection_t *redirs, int nredirs)
{
    for (int i = 0; i < nredirs; i++) {
        int target = (redirs[i].type == CAPS_REDIR_IN) ? STDIN_FILENO
                                                       : STDOUT_FILENO;
        if (dup2(redirs[i].fd, target) < 0) {
            child_fatal_printf("caps: dup2: %s\n", strerror(errno));
            _exit(1);
        }
        close(redirs[i].fd);
    }
}

int process_exec(char *const argv[], redirection_t *redirs, int nredirs,
                 int *raw_status)
{
    pid_t pid;
    int status;

    if (raw_status != NULL)
        *raw_status = 0;

    if (argv == NULL || argv[0] == NULL) {
        caps_error("no command provided");
        return EXIT_FAILURE;
    }

    if (open_redirections(redirs, nredirs) < 0)
        return EXIT_FAILURE;

    pid = fork();
    if (pid < 0) {
        caps_error("fork: %s", strerror(errno));
        close_redirections(redirs, nredirs);
        return EXIT_FAILURE;
    }

    if (pid == 0) {
        signals_child_reset();
        apply_redirections(redirs, nredirs);
        execvp(argv[0], argv);
        child_exec_failure(argv[0]);
        if (errno == EACCES)
            _exit(126);
        _exit(127);
    }

    close_redirections(redirs, nredirs);

    for (;;) {
        pid_t done = waitpid(pid, &status, 0);

        if (done == pid)
            break;
        if (done < 0 && errno == EINTR)
            continue;
        caps_error("waitpid: %s", strerror(errno));
        return EXIT_FAILURE;
    }

    if (WIFEXITED(status)) {
        if (raw_status != NULL)
            *raw_status = status;
        return WEXITSTATUS(status);
    }

    if (WIFSIGNALED(status)) {
        if (raw_status != NULL)
            *raw_status = status;
        return 128 + WTERMSIG(status);
    }

    return EXIT_FAILURE;
}

void process_report_status(const char *command, int status)
{
    if (WIFEXITED(status)) {
        if (WEXITSTATUS(status) != 0)
            caps_error("'%s' exited with status %d", command,
                       WEXITSTATUS(status));
    } else if (WIFSIGNALED(status)) {
        caps_error("'%s' terminated by signal %d", command, WTERMSIG(status));
    }
}