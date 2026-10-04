/*
 * caps-pidfd -- pidfd capability probe and PID-reuse-safe signal delivery.
 *
 * WHY THIS IS A SEPARATE BINARY
 * ----------------------------
 * The gateway needs pidfd_open(2) and pidfd_send_signal(2).  Node exposes
 * neither, and faking them with a bare kill(pid) would reintroduce the exact
 * race this exists to close.  So the syscalls live here, in C, where they can
 * be made honestly.
 *
 * Signals are rare -- a timeout escalation, a shutdown -- so the cost of
 * exec'ing this helper is irrelevant next to the cost of getting the target
 * right.
 *
 * WHAT PIDFD ACTUALLY BUYS
 * ------------------------
 * A pidfd is a kernel handle to one specific process.  Once pidfd_open()
 * returns, the kernel will never re-point that handle at another process, even
 * if the PID is recycled.  pidfd_send_signal() through the handle therefore
 * cannot signal an unrelated process: if the original has exited, the call
 * fails with ESRCH.
 *
 * The start-ticks check is a SECOND, independent guard, not the primary one.
 * Ordering matters and is deliberate:
 *
 *   1. pidfd_open(pid)      binds to whoever holds the PID right now
 *   2. read /proc/<pid>/stat and compare start ticks
 *   3. only then pidfd_send_signal()
 *
 * If the process died and its PID was recycled between (1) and (2), step (2)
 * sees different start ticks and this tool refuses -- conservative, and it
 * leaves a workload alive rather than killing a stranger.  If the process died
 * before (1), step (2) fails to read /proc and this tool refuses.  There is no
 * ordering in which a live check passes and the signal reaches a different
 * process, because the handle itself is the thing that addresses the target.
 *
 * EXIT STATUS
 * -----------
 * Every subcommand prints one line of JSON on stdout.  The JSON carries
 * `ok`, which is the authoritative result; the exit status mirrors it so the
 * helper is usable from a shell without a JSON parser.
 *
 *   0  ok was true
 *   1  ok was false (unsupported, identity mismatch, no such process)
 *   2  usage error
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef __NR_pidfd_open
#define __NR_pidfd_open 434
#endif
#ifndef __NR_pidfd_send_signal
#define __NR_pidfd_send_signal 424
#endif
#ifndef __NR_pidfd_getfd
#define __NR_pidfd_getfd 438
#endif
#ifndef PIDFD_NONBLOCK
#define PIDFD_NONBLOCK 0x800
#endif

/*
 * Emit one JSON object.
 *
 * `reason` is escaped for the two characters that would otherwise break the
 * document: backslash and double quote.  The strings produced here are
 * fixed-size and never contain a newline, but a JSON document that is not
 * parseable is worse than no document, so the escaping is unconditional.
 */
static void emit(int ok, const char *capability, const char *reason, long value)
{
    const char *r = reason != NULL ? reason : "";
    printf("{\"ok\":%s,\"capability\":", ok ? "true" : "false");
    if (capability != NULL) {
        printf("\"%s\"", capability);
    } else {
        printf("null");
    }
    printf(",\"reason\":\"");
    for (const char *p = r; *p != '\0'; p++) {
        if (*p == '\\' || *p == '"') {
            putchar('\\');
        }
        putchar(*p);
    }
    printf("\",\"value\":%ld}\n", value);
    fflush(stdout);
}

/*
 * The kernel release, as reported by uname(2).  Recorded because pidfd support
 * is a kernel property: the gateway must be able to say WHICH kernel it was
 * measured on rather than asserting a general capability.
 */
static void kernel_release(char *out, size_t n)
{
    FILE *f;

    /* /proc/sys/kernel/osrelease avoids struct utsname and its churn. */
    f = fopen("/proc/sys/kernel/osrelease", "r");
    if (f != NULL) {
        if (fgets(out, (int) n, f) != NULL) {
            size_t len = strlen(out);
            while (len > 0 && (out[len - 1] == '\n' || out[len - 1] == '\r')) {
                out[--len] = '\0';
            }
        } else {
            snprintf(out, n, "unknown");
        }
        fclose(f);
        return;
    }
    snprintf(out, n, "unknown");
}

static int do_probe(void)
{
    char rel[128];

    /*
     * ENOSYS means the kernel predates the syscall.  That is the one case
     * where "unavailable" is a property of the machine rather than of this
     * process, so it is reported distinctly from EPERM, which usually means a
     * seccomp filter or a container runtime blocking it.
     */
    long fd = syscall(__NR_pidfd_open, (int) getpid(), 0UL);
    if (fd < 0) {
        int e = errno;
        char reason[192];
        if (e == ENOSYS) {
            snprintf(reason, sizeof reason,
                     "pidfd_open is not implemented by this kernel (ENOSYS); the gateway will use "
                     "start-ticks identity validation only");
        } else if (e == EPERM) {
            snprintf(reason, sizeof reason,
                     "pidfd_open returned EPERM; a seccomp filter or container runtime is blocking it");
        } else {
            snprintf(reason, sizeof reason, "pidfd_open failed: %s", strerror(e));
        }
        kernel_release(rel, sizeof rel);
        fprintf(stderr, "kernel=%s\n", rel);
        emit(0, NULL, reason, e);
        return 1;
    }
    close((int) fd);

    kernel_release(rel, sizeof rel);
    fprintf(stderr, "kernel=%s\n", rel);
    emit(1, "pidfd", "pidfd_open succeeded on this kernel; pidfd_send_signal is used for termination", 0);
    return 0;
}

/*
 * Start time in clock ticks, field 22 of /proc/<pid>/stat.
 *
 * The comm field can contain spaces AND closing parentheses, so the numeric
 * fields are located from the LAST ')' rather than by counting from the
 * first.  Getting this wrong reads some other process's start time, which
 * would defeat the identity check it exists to perform.
 */
static long read_start_ticks(long pid, int *ok)
{
    char path[64];
    char buf[4096];
    FILE *f;
    char *close_paren;
    int field;

    *ok = 0;
    snprintf(path, sizeof path, "/proc/%ld/stat", pid);
    f = fopen(path, "r");
    if (f == NULL) {
        return 0;
    }
    if (fgets(buf, (int) sizeof buf, f) == NULL) {
        fclose(f);
        return 0;
    }
    fclose(f);

    close_paren = strrchr(buf, ')');
    if (close_paren == NULL) {
        return 0;
    }
    close_paren++;

    /* close_paren now points at field 3 (state). Field 22 is 19 further. */
    field = 3;
    while (*close_paren != '\0') {
        while (*close_paren == ' ') {
            close_paren++;
        }
        if (*close_paren == '\0') {
            return 0;
        }
        if (field == 22) {
            char *end = NULL;
            long v = strtol(close_paren, &end, 10);
            if (end == close_paren) {
                return 0;
            }
            *ok = 1;
            return v;
        }
        while (*close_paren != '\0' && *close_paren != ' ') {
            close_paren++;
        }
        field++;
    }
    return 0;
}

/*
 * Open a pidfd bound to `pid` and verify the start ticks.
 *
 * Returns the pidfd, or -1 with `reason` written into the caller-supplied
 * `reason` buffer. The buffer belongs to the caller on purpose: an earlier
 * version returned a pointer to a local, which is a dangling pointer the
 * moment the function returns, and the caller read uninitialised stack.
 */
static int bind_pidfd(long pid, long expected_ticks, char *reason, size_t reason_len)
{
    int ok = 0;
    long ticks;
    long fd;

    fd = syscall(__NR_pidfd_open, (int) pid, 0UL);
    if (fd < 0) {
        int e = errno;
        if (e == ENOSYS) {
            snprintf(reason, reason_len, "pidfd_open is not implemented by this kernel (ENOSYS)");
        } else if (e == ESRCH) {
            snprintf(reason, reason_len, "no process with pid %ld (ESRCH)", pid);
        } else {
            snprintf(reason, reason_len, "pidfd_open(%ld) failed: %s", pid, strerror(e));
        }
        return -1;
    }

    /*
     * The descriptor is already bound.  Now confirm it is bound to the process
     * we meant.  If the original exited and the PID was recycled, the ticks
     * differ and we refuse -- the descriptor is closed rather than signalled,
     * so nothing is sent.
     */
    ticks = read_start_ticks(pid, &ok);
    if (!ok) {
        snprintf(reason, reason_len, "cannot read /proc/%ld/stat; the process has no readable identity", pid);
        close((int) fd);
        return -1;
    }
    if (ticks != expected_ticks) {
        snprintf(reason, reason_len,
                 "pid %ld was recycled: expected start ticks %ld, found %ld; refusing to signal it",
                 pid, expected_ticks, ticks);
        close((int) fd);
        return -1;
    }

    snprintf(reason, reason_len, "identity verified by start ticks and bound with pidfd_open");
    return (int) fd;
}

static int do_signal(long pid, long expected_ticks, long signum)
{
    char reason[224];
    int fd;
    long rc;

    if (pid <= 0) {
        emit(0, NULL, "pid must be positive", 0);
        return 2;
    }
    if (expected_ticks < 0) {
        emit(0, NULL, "start ticks must be provided; refusing to signal a bare PID", 0);
        return 2;
    }
    if (signum < 0 || signum >= 64) {
        char buf[128];
        snprintf(buf, sizeof buf, "signal %ld is out of range", signum);
        emit(0, NULL, buf, 0);
        return 2;
    }

    fd = bind_pidfd(pid, expected_ticks, reason, sizeof reason);
    if (fd < 0) {
        emit(0, NULL, reason, 0);
        return 1;
    }

    rc = syscall(__NR_pidfd_send_signal, (int) fd, (int) signum, NULL, 0UL);
    if (rc != 0) {
        char buf[160];
        int e = errno;
        snprintf(buf, sizeof buf, "pidfd_send_signal failed: %s", strerror(e));
        close(fd);
        emit(0, NULL, buf, e);
        return 1;
    }
    close(fd);
    /*
     * Signal 0 is the POSIX existence check: it asks the kernel whether the
     * process is still there and signalable, and delivers nothing.  It is the
     * cheapest true liveness probe available through a pidfd, because the
     * handle cannot have drifted onto another process, so the answer is about
     * the process that was bound.
     */
    if (signum == 0) {
        emit(1, NULL, "identity verified and the process is still signalable (signal 0 delivers nothing)", 0);
        return 0;
    }
    emit(1, NULL, "signalled through pidfd; the kernel addressed exactly the bound process", signum);
    return 0;
}

static void usage(void)
{
    fprintf(stderr,
            "usage: caps-pidfd --probe\n"
            "       caps-pidfd --signal <pid> <startTicks> <signum>\n");
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        usage();
        return 2;
    }
    if (strcmp(argv[1], "--probe") == 0) {
        return do_probe();
    }
    if (strcmp(argv[1], "--signal") == 0) {
        if (argc != 5) {
            usage();
            return 2;
        }
        return do_signal(strtol(argv[2], NULL, 10), strtol(argv[3], NULL, 10), strtol(argv[4], NULL, 10));
    }
    usage();
    return 2;
}
