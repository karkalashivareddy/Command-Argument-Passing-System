#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include "process.h"

int process_exec(char *const argv[])
{
    pid_t pid;
    int status;

    if (argv == NULL || argv[0] == NULL) {
        fprintf(stderr, "caps: no command to execute\n");
        return EXIT_FAILURE;
    }

    pid = fork();
    if (pid < 0) {
        fprintf(stderr, "caps: fork: %s\n", strerror(errno));
        return EXIT_FAILURE;
    }

    if (pid == 0) {
        execvp(argv[0], argv);

        if (errno == ENOENT)
            fprintf(stderr, "caps: command not found: %s\n", argv[0]);
        else
            fprintf(stderr, "caps: %s: %s\n", argv[0], strerror(errno));

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
        fprintf(stderr, "caps: waitpid: %s\n", strerror(errno));
        return EXIT_FAILURE;
    }

    if (WIFEXITED(status))
        return WEXITSTATUS(status);

    if (WIFSIGNALED(status))
        return 128 + WTERMSIG(status);

    return EXIT_FAILURE;
}

void process_report_status(const char *command, int status)
{
    if (WIFEXITED(status)) {
        if (WEXITSTATUS(status) != 0)
            fprintf(stderr, "caps: '%s' exited with status %d\n",
                    command, WEXITSTATUS(status));
    } else if (WIFSIGNALED(status)) {
        fprintf(stderr, "caps: '%s' terminated by signal %d\n",
                command, WTERMSIG(status));
    }
}