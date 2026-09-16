#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include "process.h"
#include "utils.h"

/*
 * Report an exec failure from inside the child process.
 *
 * After fork() the child shares a copy of the parent's stdio buffers.
 * Using fprintf()/exit() here could flush duplicated buffers and tear
 * the parent's pending output.  We therefore format into a small
 * stack buffer and write(2) directly to stderr, then _exit().
 * write() and strlen() are in the POSIX async-signal-safe set; this
 * is the minimal, correct child-side failure path.
 */
static void child_exec_failure(const char *command)
{
    char buf[256];
    int n;

    if (errno == ENOENT)
        n = snprintf(buf, sizeof buf, "caps: command not found: %s\n", command);
    else if (errno == EACCES)
        n = snprintf(buf, sizeof buf, "caps: %s: permission denied\n", command);
    else
        n = snprintf(buf, sizeof buf, "caps: %s: %s\n", command,
                     strerror(errno));

    if (n > 0) {
        size_t len = (size_t)n;
        if (len > sizeof buf - 1)
            len = sizeof buf - 1;
        (void)write(STDERR_FILENO, buf, len);
    }
}

int process_exec(char *const argv[], int *raw_status)
{
    pid_t pid;
    int status;

    if (raw_status != NULL)
        *raw_status = 0;

    if (argv == NULL || argv[0] == NULL) {
        caps_error("no command provided");
        return EXIT_FAILURE;
    }

    pid = fork();
    if (pid < 0) {
        caps_error("fork: %s", strerror(errno));
        return EXIT_FAILURE;
    }

    if (pid == 0) {
        execvp(argv[0], argv);
        child_exec_failure(argv[0]);
        if (errno == EACCES)
            _exit(126);
        _exit(127);
    }

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