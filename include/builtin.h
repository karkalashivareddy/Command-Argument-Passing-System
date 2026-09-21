#ifndef CAPS_BUILTIN_H
#define CAPS_BUILTIN_H

typedef enum {
    CAPS_NOT_BUILTIN = 0,   /* not a built-in; caller should exec it */
    CAPS_BUILTIN_HANDLED,   /* built-in ran; *status holds its result */
    CAPS_BUILTIN_EXIT       /* built-in requested REPL termination */
} builtin_result_t;

/*
 * Try to run argv[0] as a built-in command.
 *
 * argv must be NULL-terminated.  For every non-NOT_BUILTIN result the
 * command's exit status is stored in *status.  last_status is the exit
 * status of the previously executed command (used by "exit" without an
 * explicit status).
 *
 * Built-ins run in the parent (caps) process.  This matters for cd:
 * chdir() only affects the calling process, so a child process could
 * never change the shell's working directory.
 */
builtin_result_t builtin_run(int argc, char *const argv[], int last_status,
                             int *status);

void builtin_print_help(void);

#endif /* CAPS_BUILTIN_H */
