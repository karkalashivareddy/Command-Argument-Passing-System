#ifndef CAPS_WORKLOAD_COMMON_H
#define CAPS_WORKLOAD_COMMON_H

/*
 * Shared support for the first-party CAPS workload programs.
 *
 * These helpers are deliberately small and boring: strict argument
 * parsing, a bounded deadline loop, and a signal-safe stop flag.  Every
 * workload in this directory is a *controlled laboratory workload* used to
 * make one real Linux resource signal visible.  They are not production
 * load generators and must never be described as such.
 *
 * All of them are plain C11/POSIX programs.  None of them:
 *   - start a shell,
 *   - open a network socket,
 *   - fork children (except caps_fork_tree, which is the topology lab),
 *   - allocate unbounded memory,
 *   - write to stdout without a hard cap.
 *
 * Each workload .c file defines `volatile sig_atomic_t caps_wl_stop = 0;`
 * exactly once; this header only declares it.  Ownership is explicit so a
 * second translation unit can never accidentally shadow the flag.
 */

#include <errno.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* Safety ceilings.  The gateway enforces the same bounds independently;
 * these are the second line of defense so a direct `exec` cannot abuse the
 * host either. */
#define CAPS_WL_MAX_DURATION_S 30
#define CAPS_WL_MIN_DURATION_S 1
#define CAPS_WL_MAX_MEMORY_MIB 256
#define CAPS_WL_MAX_IO_MIB 64
#define CAPS_WL_MAX_FORK_CHILDREN 4

/* Absolute cap on a single workload's stdout/stderr volume. */
#define CAPS_WL_MAX_OUTPUT_BYTES 4096

/* Non-zero exit codes used consistently by every workload. */
#define CAPS_WL_EXIT_USAGE 2
#define CAPS_WL_EXIT_SETUP 3
#define CAPS_WL_EXIT_STOPPED 4

/*
 * Async-signal-safe stop flag.  A handler may only assign to a volatile
 * sig_atomic_t; everything else here happens in normal control flow.
 */
extern volatile sig_atomic_t caps_wl_stop;

static void caps_wl_on_stop(int signo)
{
    (void)signo;
    caps_wl_stop = 1;
}

/*
 * Install SIGINT/SIGTERM handlers so a workload ends cleanly when the
 * laboratory sends it a stop signal.  Both are catchable; the escalation
 * path (SIGKILL) is unaffected.
 */
static inline int caps_wl_install_stop_handlers(void)
{
    struct sigaction sa;

    memset(&sa, 0, sizeof sa);
    sa.sa_handler = caps_wl_on_stop;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0; /* no SA_RESTART: let blocking waits return EINTR */

    if (sigaction(SIGINT, &sa, NULL) != 0)
        return -1;
    if (sigaction(SIGTERM, &sa, NULL) != 0)
        return -1;
    return 0;
}

/* CLOCK_MONOTONIC milliseconds; -1 if the clock cannot be read. */
static inline long long caps_wl_monotonic_ms(void)
{
    struct timespec ts;

    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
        return -1;
    return (long long)ts.tv_sec * 1000 + (long long)ts.tv_nsec / 1000000;
}

/* Sleep for at most `ms` milliseconds, restarting across signals. */
static inline void caps_wl_sleep_ms(long ms)
{
    struct timespec req;

    if (ms <= 0)
        return;
    req.tv_sec = ms / 1000;
    req.tv_nsec = (ms % 1000) * 1000000L;
    while (nanosleep(&req, &req) != 0 && errno == EINTR) {
        if (caps_wl_stop)
            return;
    }
}

/*
 * Parse a strictly bounded positive decimal integer.  Rejects empty
 * strings, signs, whitespace, trailing garbage, and anything outside
 * [min, max].  Returns 0 on success.
 */
static inline int caps_wl_parse_bounded(const char *s, long min, long max,
                                        long *out)
{
    char *end = NULL;
    long value;

    if (s == NULL || *s == '\0' || out == NULL)
        return -1;
    for (const char *p = s; *p != '\0'; p++) {
        if (*p < '0' || *p > '9')
            return -1;
    }

    errno = 0;
    value = strtol(s, &end, 10);
    if (errno != 0 || end == NULL || *end != '\0')
        return -1;
    if (value < min || value > max)
        return -1;

    *out = value;
    return 0;
}

/*
 * Report a usage error on stderr with a bounded message and the documented
 * argument ranges.  The gateway surfaces this verbatim to the operator.
 */
static inline void caps_wl_usage(const char *prog, const char *form,
                                 const char *detail)
{
    fprintf(stderr, "usage: %s %s\n", prog != NULL ? prog : "caps_workload",
            form != NULL ? form : "");
    if (detail != NULL && detail[0] != '\0')
        fprintf(stderr, "%s\n", detail);
}

/*
 * Bounded single-line status writer.  Callers emit at most a handful of
 * lines, so the total volume stays far below CAPS_WL_MAX_OUTPUT_BYTES.
 */
static inline void caps_wl_say(const char *fmt, ...)
{
    va_list ap;

    fputs("caps_workload: ", stdout);
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    fputc('\n', stdout);
    fflush(stdout);
}

#endif /* CAPS_WORKLOAD_COMMON_H */
