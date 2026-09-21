#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "monitor.h"
#include "process.h"
#include "signals.h"
#include "utils.h"

/*
 * Report an exec/dup2/signal failure from inside the child process.
 *
 * Note: this is NOT a signal-handler context and is NOT claimed to be
 * async-signal-safe — vsnprintf()/strerror() are fine here for that
 * reason.  The real constraint is different: after fork() the child
 * shares a copy of the parent's stdio buffers, so fprintf()/exit()
 * would flush duplicated buffers and garble the parent's pending
 * output.  We therefore write(2) directly to stderr and _exit(), never
 * touching buffered stdio.
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

/* Elapsed time on the monotonic clock; never displayed as wall-clock. */
static long long monotonic_ms(void)
{
    struct timespec ts;

    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + (long long)ts.tv_nsec / 1000000;
}

static void emit_event(caps_monitor_t *mon, caps_event_type_t type, pid_t pid,
                       int status, long long duration_ms, char *const argv[])
{
    caps_event_t ev;
    char cmd[256];

    if (mon == NULL)
        return;

    memset(&ev, 0, sizeof ev);
    ev.type = type;
    ev.pid = pid;
    ev.status = status;
    ev.duration_ms = duration_ms;

    if (argv != NULL) {
        caps_join_argv(argv, cmd, sizeof cmd);
        ev.command = cmd;
    } else {
        ev.command = NULL;
    }

    caps_monitor_emit(mon, &ev);
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
    /*
     * Best-effort cleanup: by the time these descriptors are closed the
     * primary operation (fork or child launch) has either succeeded or
     * already failed, so a close() error is not actionable.
     */
    for (int i = 0; i < nredirs; i++) {
        if (redirs[i].fd >= 0)
            (void)close(redirs[i].fd);
    }
}

/*
 * Called in the child, after fork() and before execvp(): wire the
 * already-open redirection descriptors onto stdin/stdout.
 *
 * Descriptor ownership rule: a descriptor is closed only when it is NOT
 * already the destination.  If fd == target, dup2(fd, fd) is a no-op and
 * the follow-up close(fd) would close the very descriptor just
 * installed — the destructive pattern that breaks redirection when a
 * standard descriptor (0/1/2) was already closed and open() reused its
 * slot.  Never returns on failure.
 */
static void apply_redirections(redirection_t *redirs, int nredirs)
{
    for (int i = 0; i < nredirs; i++) {
        int fd = redirs[i].fd;
        int target = (redirs[i].type == CAPS_REDIR_IN) ? STDIN_FILENO
                                                       : STDOUT_FILENO;

        if (fd == target)
            continue; /* keep the descriptor; it already is the target */

        if (dup2(fd, target) < 0) {
            child_fatal_printf("caps: dup2: %s\n", strerror(errno));
            _exit(1);
        }
        close(fd);
    }
}

int process_exec(char *const argv[], redirection_t *redirs, int nredirs,
                 int *raw_status, caps_monitor_t *mon)
{
    pid_t pid;
    int status;
    long long start_ms = 0;

    if (raw_status != NULL)
        *raw_status = 0;

    if (argv == NULL || argv[0] == NULL) {
        caps_error("no command provided");
        return EXIT_FAILURE;
    }

    if (open_redirections(redirs, nredirs) < 0) {
        emit_event(mon, CAPS_EVENT_REDIRECTION_FAILED, 0, 0, 0, argv);
        return EXIT_FAILURE;
    }
    if (nredirs > 0)
        emit_event(mon, CAPS_EVENT_REDIRECTION_OPENED, 0, 0, 0, argv);

    start_ms = monotonic_ms();
    pid = fork();
    if (pid < 0) {
        caps_error("fork: %s", strerror(errno));
        close_redirections(redirs, nredirs);
        return EXIT_FAILURE;
    }

    if (pid == 0) {
        if (signals_child_reset() != 0)
            child_fatal_printf("caps: warning: failed to reset SIGINT in "
                               "child; the executed program may ignore "
                               "Ctrl+C\n");
        apply_redirections(redirs, nredirs);
        execvp(argv[0], argv);
        child_exec_failure(argv[0]);
        if (errno == EACCES)
            _exit(126);
        _exit(127);
    }

    emit_event(mon, CAPS_EVENT_PROCESS_STARTED, pid, 0, 0, argv);
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
        int code = WEXITSTATUS(status);
        int st = status;

        if (code == 127 || code == 126)
            emit_event(mon, CAPS_EVENT_EXEC_ERROR, pid, code,
                       monotonic_ms() - start_ms, argv);
        else
            emit_event(mon, CAPS_EVENT_PROCESS_EXITED, pid, code,
                       monotonic_ms() - start_ms, argv);
        if (raw_status != NULL)
            *raw_status = st;
        return code;
    }

    if (WIFSIGNALED(status)) {
        int sig = WTERMSIG(status);

        emit_event(mon, CAPS_EVENT_SIGNAL_RECEIVED, pid, sig, 0, argv);
        emit_event(mon, CAPS_EVENT_PROCESS_EXITED, pid, 128 + sig,
                   monotonic_ms() - start_ms, argv);
        if (raw_status != NULL)
            *raw_status = status;
        return 128 + sig;
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
