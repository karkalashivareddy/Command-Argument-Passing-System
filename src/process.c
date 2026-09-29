#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <sys/stat.h>
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
 * Create a close-on-exec pipe whose descriptors cannot collide with stdin,
 * stdout, or stderr. A failed execvp() reports its saved errno to the parent.
 * EOF without an error is not emitted as a success event: a signal could
 * also end the child before execvp().
 */
static int make_exec_status_pipe(int pipefd[2])
{
    int raw[2];

    if (pipe(raw) != 0)
        return -1;
    for (int i = 0; i < 2; i++) {
        int fd = raw[i];
        if (fd <= STDERR_FILENO) {
            fd = fcntl(fd, F_DUPFD, STDERR_FILENO + 1);
            if (fd < 0) {
                int saved = errno;
                close(raw[0]);
                close(raw[1]);
                errno = saved;
                return -1;
            }
            close(raw[i]);
        }
        if (fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) {
            int saved = errno;
            close(fd);
            if (i == 0)
                close(raw[1]);
            else
                close(pipefd[0]);
            errno = saved;
            return -1;
        }
        pipefd[i] = fd;
    }
    return 0;
}

static int read_exec_error(int fd, int *exec_errno)
{
    unsigned char *p = (unsigned char *)exec_errno;
    size_t received = 0;

    while (received < sizeof *exec_errno) {
        ssize_t n = read(fd, p + received, sizeof *exec_errno - received);
        if (n > 0) {
            received += (size_t)n;
            continue;
        }
        if (n < 0 && errno == EINTR)
            continue;
        if (n == 0)
            return received == 0 ? 0 : -1;
        return -1;
    }
    return 1;
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
    ev.outcome = CAPS_OUTCOME_EXITED;

    if (argv != NULL) {
        caps_join_argv(argv, cmd, sizeof cmd);
        ev.command = cmd;
    } else {
        ev.command = NULL;
    }

    caps_monitor_emit(mon, &ev);
}

/*
 * Terminal event for a process that actually ran.  `outcome` states what the
 * kernel reported about it; the monitor prints it verbatim rather than
 * re-deriving it from the status code.
 */
static void emit_exit_event(caps_monitor_t *mon, pid_t pid, caps_outcome_t outcome,
                            int status, long long duration_ms,
                            char *const argv[])
{
    caps_event_t ev;
    char cmd[256];

    if (mon == NULL)
        return;

    memset(&ev, 0, sizeof ev);
    ev.type = CAPS_EVENT_PROCESS_EXITED;
    ev.pid = pid;
    ev.status = status;
    ev.duration_ms = duration_ms;
    ev.outcome = outcome;
    caps_join_argv(argv, cmd, sizeof cmd);
    ev.command = cmd;

    caps_monitor_emit(mon, &ev);
}

/*
 * Terminal event for a failed execvp(), carrying the failure reason.
 *
 * `exec_errno` is the errno the child's execvp() actually returned. It is
 * reported, never discarded, and it is what distinguishes 126 (EACCES: the
 * file exists and is not executable) from 127 (ENOENT, or anything else the
 * kernel refused).
 */
static void emit_exec_error(caps_monitor_t *mon, pid_t pid, int exec_errno,
                            long long duration_ms, char *const argv[])
{
    caps_event_t ev;
    char cmd[256];
    const char *reason;

    if (mon == NULL)
        return;

    switch (exec_errno) {
    case ENOENT:
        reason = "exec_not_found";
        break;
    case EACCES:
        reason = "exec_permission_denied";
        break;
    case ENOEXEC:
        reason = "exec_format_error";
        break;
    case ELOOP:
        reason = "exec_symlink_loop";
        break;
    case ENAMETOOLONG:
        reason = "exec_name_too_long";
        break;
    case ETXTBSY:
        reason = "exec_text_file_busy";
        break;
    case E2BIG:
        reason = "exec_argument_list_too_long";
        break;
    case ENOMEM:
        reason = "exec_out_of_memory";
        break;
    default:
        reason = "exec_failed";
        break;
    }

    memset(&ev, 0, sizeof ev);
    ev.type = CAPS_EVENT_EXEC_ERROR;
    ev.pid = pid;
    ev.status = (exec_errno == EACCES) ? 126 : 127;
    ev.errno_value = exec_errno;
    ev.message = reason;
    ev.duration_ms = duration_ms;
    ev.outcome = CAPS_OUTCOME_EXEC_FAILED;
    caps_join_argv(argv, cmd, sizeof cmd);
    ev.command = cmd;

    caps_monitor_emit(mon, &ev);
}

/*
 * Failure event for a launch/wait failure. `status` is the negated errno so
 * the value is always meaningful and never accidentally 0 (which would read
 * as "exited 0"); the errno is repeated in its own field so a consumer does
 * not have to know that convention.
 */
static void emit_failure_event(caps_monitor_t *mon, caps_event_type_t type,
                               pid_t pid, int err, const char *reason,
                               long long duration_ms, char *const argv[])
{
    caps_event_t ev;
    char cmd[256];

    if (mon == NULL)
        return;

    memset(&ev, 0, sizeof ev);
    ev.type = type;
    ev.pid = pid;
    ev.status = -err;
    ev.errno_value = err;
    ev.message = reason;
    ev.duration_ms = duration_ms;
    ev.outcome = (type == CAPS_EVENT_WAIT_FAILED) ? CAPS_OUTCOME_WAIT_FAILED
                                                 : CAPS_OUTCOME_LAUNCH_FAILED;
    caps_join_argv(argv, cmd, sizeof cmd);
    ev.command = cmd;

    caps_monitor_emit(mon, &ev);
}

/*
 * Redirection target policy, enforced at the point of use.
 *
 * The gateway already validates redirection names before spawning CAPS, but a
 * check-then-open sequence has an inherent gap: whatever sits at the path can
 * change between the check and the open().  These helpers close that gap
 * without pretending to be a sandbox:
 *
 *   - O_NOFOLLOW on the final component refuses to follow a symlink, so a
 *     name that became a symlink after validation is an error, not a write to
 *     an arbitrary target;
 *   - for "<" the file must already exist, be a regular file, and be opened
 *     read-only, so a "readable file" race cannot turn into a create;
 *   - an existing redirection target for ">" / ">>" must be a regular file, so
 *     a freshly planted FIFO or device node is refused rather than written to.
 *
 * Anything rejected here is reported through the monitor as
 * REDIRECTION_FAILED, so the failure is observed rather than silent.
 */
static int open_redirection(const redirection_t *r)
{
    int flags;
    int fd;
    struct stat st;

    switch (r->type) {
    case CAPS_REDIR_IN:
        flags = O_RDONLY | O_NOFOLLOW;
        break;
    case CAPS_REDIR_APPEND:
        flags = O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW;
        break;
    default:
        flags = O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW;
        break;
    }

    fd = open(r->path, flags, 0644);
    if (fd < 0)
        return -1;

    /*
     * Type check.  "<" must not create anything and must not be a device or
     * FIFO; ">" / ">>" may create a regular file but must not write to a
     * pre-existing special file.  fstat() on the descriptor we already hold
     * cannot be redirected by a rename race.
     */
    if (fstat(fd, &st) != 0) {
        int saved = errno;
        close(fd);
        errno = saved;
        return -1;
    }
    if (r->type == CAPS_REDIR_IN) {
        if (!S_ISREG(st.st_mode)) {
            close(fd);
            errno = EINVAL;
            return -1;
        }
    } else if (!S_ISREG(st.st_mode)) {
        close(fd);
        errno = EINVAL;
        return -1;
    }
    return fd;
}

static int open_redirections(redirection_t *redirs, int nredirs)
{
    for (int i = 0; i < nredirs; i++) {
        int fd = open_redirection(&redirs[i]);

        if (fd < 0) {
            caps_error("%s: %s", redirs[i].path, strerror(errno));
            for (int j = 0; j < i; j++)
                close(redirs[j].fd);
            return -1;
        }
        redirs[i].fd = fd;
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
    int exec_pipe[2] = { -1, -1 };
    int exec_errno = 0;
    int exec_failed = 0;
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

    if (make_exec_status_pipe(exec_pipe) != 0) {
        int err = errno;
        caps_error("exec status pipe: %s", strerror(err));
        emit_failure_event(mon, CAPS_EVENT_EXECUTION_FAILED, 0, err,
                           "exec_status_pipe_failed", 0, argv);
        close_redirections(redirs, nredirs);
        return EXIT_FAILURE;
    }

    start_ok = (monotonic_ms(&start_ms) == 0);
    pid = fork();
    if (pid < 0) {
        int err = errno;
        caps_error("fork: %s", strerror(err));
        emit_failure_event(mon, CAPS_EVENT_EXECUTION_FAILED, 0, err,
                           "fork_failed", 0, argv);
        close(exec_pipe[0]);
        close(exec_pipe[1]);
        close_redirections(redirs, nredirs);
        return EXIT_FAILURE;
    }

    if (pid == 0) {
        close(exec_pipe[0]);
        if (signals_child_reset() != 0) {
            /*
             * Fail closed on the signal model.  POSIX exec preserves SIG_IGN,
             * so execvp()ing while SIGINT is still ignored would hand the
             * executed program a disposition CAPS never promised: the child
             * would survive Ctrl+C while the REPL carried on.  Refusing the
             * launch is more honest than running a program whose signal
             * semantics are wrong, and the refusal travels on the status pipe
             * like any other launch failure so the parent classifies it
             * instead of guessing.
             */
            int err = errno;
            child_fatal_printf("caps: refusing to exec %s: could not restore "
                               "the default SIGINT disposition (%s); running "
                               "it with an inherited SIG_IGN would break its "
                               "signal model\n",
                               argv[0], strerror(err));
            exec_errno = err ? err : EINVAL;
            (void)write(exec_pipe[1], &exec_errno, sizeof exec_errno);
            errno = exec_errno;
            _exit(126);
        }
        apply_redirections(redirs, nredirs);
        execvp(argv[0], argv);
        exec_errno = errno;
        (void)write(exec_pipe[1], &exec_errno, sizeof exec_errno);
        errno = exec_errno;
        child_exec_failure(argv[0]);
        if (exec_errno == EACCES)
            _exit(126);
        _exit(127);
    }

    close(exec_pipe[1]);
    emit_event(mon, CAPS_EVENT_PROCESS_STARTED, pid, 0, 0, argv);
    close_redirections(redirs, nredirs);

    exec_failed = read_exec_error(exec_pipe[0], &exec_errno) == 1;
    close(exec_pipe[0]);

    if (process_wait_child(pid, &status) != 0) {
        /*
         * A permanent waitpid() failure must not make the execution vanish.
         * PROCESS_STARTED is already in the stream, so the only honest ending
         * is an explicit terminal event carrying the real errno.  Without it
         * the session would have a start and no end, and the gateway would
         * have to invent one from a non-zero process exit.
         */
        int err = errno;
        emit_failure_event(mon, CAPS_EVENT_WAIT_FAILED, pid, err, "wait_failed",
                           elapsed_ms(start_ms, start_ok), argv);
        return EXIT_FAILURE;
    }

    if (WIFEXITED(status)) {
        int code = WEXITSTATUS(status);

        /*
         * exec_failed outranks the child's own exit status.  A child that
         * never reached execvp() has no program result, so emitting
         * PROCESS_EXITED would claim a target ran when none did.
         */
        if (exec_failed) {
            emit_exec_error(mon, pid, exec_errno, elapsed_ms(start_ms, start_ok),
                            argv);
            if (raw_status != NULL)
                *raw_status = status;
            return (exec_errno == EACCES) ? 126 : 127;
        }
        emit_exit_event(mon, pid,
                        code == 0 ? CAPS_OUTCOME_COMPLETED : CAPS_OUTCOME_EXITED,
                        code, elapsed_ms(start_ms, start_ok), argv);
        if (raw_status != NULL)
            *raw_status = status;
        return code;
    }

    if (WIFSIGNALED(status)) {
        int sig = WTERMSIG(status);

        /* Same rule on the signal path: no program ran, so no exit event. */
        if (exec_failed) {
            emit_exec_error(mon, pid, exec_errno, elapsed_ms(start_ms, start_ok),
                            argv);
            if (raw_status != NULL)
                *raw_status = status;
            return (exec_errno == EACCES) ? 126 : 127;
        }
        {
            caps_event_t sigev;
            char cmd[256];

            if (mon != NULL) {
                memset(&sigev, 0, sizeof sigev);
                sigev.type = CAPS_EVENT_SIGNAL_RECEIVED;
                sigev.pid = pid;
                sigev.status = sig;
                sigev.outcome = CAPS_OUTCOME_SIGNALED;
                caps_join_argv(argv, cmd, sizeof cmd);
                sigev.command = cmd;
                caps_monitor_emit(mon, &sigev);
            }
        }
        emit_exit_event(mon, pid, CAPS_OUTCOME_SIGNALED, 128 + sig,
                        elapsed_ms(start_ms, start_ok), argv);
        if (raw_status != NULL)
            *raw_status = status;
        return 128 + sig;
    }

    /*
     * WIFSTOPPED / WIFCONTINUED cannot occur with options == 0. Reaching this
     * point means the kernel returned a status shape this engine does not
     * model; report it explicitly instead of returning a bare failure with no
     * event, which is the failure mode this event type exists to prevent.
     */
    emit_failure_event(mon, CAPS_EVENT_WAIT_FAILED, pid, EINVAL,
                       "unmodelled_wait_status", elapsed_ms(start_ms, start_ok),
                       argv);
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
