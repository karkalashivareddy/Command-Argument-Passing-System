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

/*
 * Sample the monotonic clock.  Returns 0 and stores whole milliseconds
 * in *out on success, -1 if the clock cannot be read.  CLOCK_MONOTONIC
 * does not fail for a valid clock id, but checking the result keeps the
 * failure explicit instead of returning an uninitialised timespec.
 */
static int monotonic_ms(long long *out)
{
    struct timespec ts;

    if (out == NULL)
        return -1;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
        return -1;

    *out = (long long)ts.tv_sec * 1000 + (long long)ts.tv_nsec / 1000000;
    return 0;
}

/*
 * Elapsed milliseconds between a start sample and now.
 *
 * Duration policy: when either the start sample (start_ok == 0) or the
 * end sample is unavailable, the elapsed time is unknown and reported
 * as 0.  A real measurement is always >= 0 because the monotonic clock
 * cannot run backwards; the clamp is defensive only.
 */
static long long elapsed_ms(long long start_ms, int start_ok)
{
    long long now;

    if (!start_ok || monotonic_ms(&now) != 0)
        return 0;
    if (now < start_ms)
        return 0;
    return now - start_ms;
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

/*
 * Wait for one specific child and store its raw wait() status.
 *
 * Failure policy (deliberate, not a blind retry loop):
 *   - EINTR is the only retryable outcome: the wait was interrupted by a
 *     signal, the child's state is unchanged, and retrying cannot spin
 *     because the child must eventually change state.
 *   - Every other errno is terminal and reported exactly once.  The only
 *     reachable case is ECHILD -- the pid is not (or is no longer) our
 *     child, which means it was already reaped elsewhere and there is
 *     nothing left to wait for; retrying could never succeed.  EINVAL and
 *     EFAULT cannot occur with options == 0 and a valid status pointer,
 *     and would be equally permanent if they did.
 *
 * Returns 0 when *status was filled in, -1 on the terminal path (the
 * caller must then treat the child's outcome as unknown rather than
 * guessing a status).
 */
int process_wait_child(pid_t pid, int *status)
{
    for (;;) {
        pid_t done = waitpid(pid, status, 0);

        if (done == pid)
            return 0;
        if (done < 0 && errno == EINTR)
            continue;

        caps_error("waitpid: %s", strerror(errno));
        return -1;
    }
}

int process_exec(char *const argv[], redirection_t *redirs, int nredirs,
                 int *raw_status, caps_monitor_t *mon)
{
    pid_t pid;
    int status;
    long long start_ms = 0;
    int start_ok = 0;

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

    start_ok = (monotonic_ms(&start_ms) == 0);
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

    if (process_wait_child(pid, &status) != 0)
        return EXIT_FAILURE;

    if (WIFEXITED(status)) {
        int code = WEXITSTATUS(status);
        int st = status;

        if (code == 127 || code == 126)
            emit_event(mon, CAPS_EVENT_EXEC_ERROR, pid, code,
                       elapsed_ms(start_ms, start_ok), argv);
        else
            emit_event(mon, CAPS_EVENT_PROCESS_EXITED, pid, code,
                       elapsed_ms(start_ms, start_ok), argv);
        if (raw_status != NULL)
            *raw_status = st;
        return code;
    }

    if (WIFSIGNALED(status)) {
        int sig = WTERMSIG(status);

        emit_event(mon, CAPS_EVENT_SIGNAL_RECEIVED, pid, sig, 0, argv);
        emit_event(mon, CAPS_EVENT_PROCESS_EXITED, pid, 128 + sig,
                   elapsed_ms(start_ms, start_ok), argv);
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
