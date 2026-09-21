#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "builtin.h"
#include "utils.h"

/*
 * Parse an exit-status argument with strtol() and full validation.
 *
 * Rejects: empty strings, non-numeric strings, partially numeric strings
 * ("12abc"), overflow/underflow (ERANGE), and values outside the range a
 * process can exit with (0..255).  Nothing is silently interpreted: invalid
 * input yields -1 and the caller reports a diagnostic.
 */
static int parse_exit_status(const char *s, int *out)
{
    char *end = NULL;
    long v;

    if (s == NULL || *s == '\0')
        return -1;

    errno = 0;
    v = strtol(s, &end, 10);
    if (errno == ERANGE || end == s || *end != '\0')
        return -1;
    if (v < 0 || v > 255)
        return -1;

    *out = (int)v;
    return 0;
}

static builtin_result_t builtin_exit(int argc, char *const argv[],
                                     int last_status, int *status)
{
    if (argc >= 2) {
        int value;

        if (parse_exit_status(argv[1], &value) != 0) {
            caps_error("exit: invalid status: '%s' (expected an integer "
                       "in the range 0..255)", argv[1]);
            *status = 1;
            return CAPS_BUILTIN_HANDLED;
        }
        *status = value;
        return CAPS_BUILTIN_EXIT;
    }

    *status = last_status;
    return CAPS_BUILTIN_EXIT;
}

static builtin_result_t builtin_cd(int argc, char *const argv[],
                                   int *status)
{
    const char *target;

    if (argc >= 2) {
        target = argv[1];
    } else {
        target = getenv("HOME");
        if (target == NULL) {
            caps_error("cd: HOME is not set");
            *status = 1;
            return CAPS_BUILTIN_HANDLED;
        }
    }

    if (chdir(target) != 0) {
        caps_error("cd: %s: %s", target, strerror(errno));
        *status = 1;
        return CAPS_BUILTIN_HANDLED;
    }

    *status = 0;
    return CAPS_BUILTIN_HANDLED;
}

builtin_result_t builtin_run(int argc, char *const argv[], int last_status,
                             int *status)
{
    if (argc < 1 || argv == NULL || argv[0] == NULL)
        return CAPS_NOT_BUILTIN;

    if (strcmp(argv[0], "exit") == 0)
        return builtin_exit(argc, argv, last_status, status);
    if (strcmp(argv[0], "cd") == 0)
        return builtin_cd(argc, argv, status);
    if (strcmp(argv[0], "help") == 0) {
        builtin_print_help();
        *status = 0;
        return CAPS_BUILTIN_HANDLED;
    }

    return CAPS_NOT_BUILTIN;
}

void builtin_print_help(void)
{
    fprintf(stderr,
            "Built-in commands:\n"
            "  help         show this message\n"
            "  exit [N]     exit the shell with status N (default: last status)\n"
            "  cd [dir]     change the working directory in this shell\n"
            "\n"
            "Every other command is run as an external program through\n"
            "fork() + execvp(); its arguments are passed as the program's\n"
            "argv[1..]. The parent then waits with waitpid().\n");
}