/*
 * caps_fork_tree — controlled process-topology workload.
 *
 *   caps_fork_tree <seconds> [children]
 *
 * Purpose: give the observatory a real, deterministic process tree so
 * descendant telemetry and the topology views have something true to
 * display.  The shape is fixed and bounded:
 *
 *     caps_fork_tree (direct child of the CAPS engine)
 *       ├── worker 1
 *       ├── worker 2
 *       │     └── grandchild
 *       └── worker N
 *
 * Every worker sleeps for the requested duration, so the whole tree is
 * observable while the parent is alive.  The parent reaps every child
 * with waitpid() before exiting, so no zombie is left behind.
 *
 * Safety envelope:
 *   - duration 1..30 s
 *   - children 1..4 (hard cap), each forking at most one grandchild
 *   - no shell, no network, no unbounded memory, no unbounded output
 *   - a stop signal ends the parent, which then SIGTERMs its children
 *
 * IMPORTANT (observability contract): a fork creates a new PID, so the
 * engine and the observatory can observe these descendants.  An execvp()
 * does not — it keeps the same PID.  This workload is about the former.
 */

#include <sys/wait.h>
#include <unistd.h>

#include "workload_common.h"

volatile sig_atomic_t caps_wl_stop = 0;

#define MAX_WORKERS CAPS_WL_MAX_FORK_CHILDREN

/*
 * A worker holds the CPU gently, touches a small stack-resident page, and
 * sleeps.  It exits when the deadline passes or when SIGTERM arrives.
 */
static int worker_run(int index, long seconds, int spawn_grandchild)
{
    long long start_ms = caps_wl_monotonic_ms();
    long long deadline_ms = start_ms + (long long)seconds * 1000;
    pid_t grandchild = -1;
    int rc = 0;

    if (start_ms < 0) {
        fprintf(stderr, "caps_fork_tree: worker %d: CLOCK_MONOTONIC "
                        "unavailable: %s\n",
                index, strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }

    if (spawn_grandchild) {
        grandchild = fork();
        if (grandchild < 0) {
            fprintf(stderr, "caps_fork_tree: worker %d: fork(grandchild): %s\n",
                    index, strerror(errno));
            rc = CAPS_WL_EXIT_SETUP;
        }
    }

    if (grandchild == 0) {
        /* Grandchild: short-lived, prints nothing, exits after 1 s. */
        caps_wl_sleep_ms(1000);
        _exit(0);
    }

    while (!caps_wl_stop) {
        long long now = caps_wl_monotonic_ms();
        if (now < 0 || now >= deadline_ms)
            break;
        caps_wl_sleep_ms(50);
    }

    if (grandchild > 0) {
        int status = 0;
        if (waitpid(grandchild, &status, 0) < 0 && errno != ECHILD)
            fprintf(stderr, "caps_fork_tree: worker %d: waitpid(grandchild): "
                            "%s\n",
                    index, strerror(errno));
    }
    return rc;
}

int main(int argc, char **argv)
{
    long seconds = 8;
    long children = 2;
    long long start_ms, deadline_ms, elapsed_ms;
    pid_t workers[MAX_WORKERS];
    int spawned = 0;
    int i;
    int rc = 0;

    if (argc > 1 && caps_wl_parse_bounded(argv[1], CAPS_WL_MIN_DURATION_S,
                                          CAPS_WL_MAX_DURATION_S, &seconds) != 0) {
        caps_wl_usage(argv[0], "<seconds> [children]",
                      "duration must be an integer 1..30 (controlled workload)");
        return CAPS_WL_EXIT_USAGE;
    }
    if (argc > 2 && caps_wl_parse_bounded(argv[2], 1, CAPS_WL_MAX_FORK_CHILDREN,
                                          &children) != 0) {
        caps_wl_usage(argv[0], "<seconds> [children]",
                      "children must be an integer 1..4 (bounded topology)");
        return CAPS_WL_EXIT_USAGE;
    }
    if (argc > 3) {
        caps_wl_usage(argv[0], "<seconds> [children]",
                      "this workload accepts at most two arguments");
        return CAPS_WL_EXIT_USAGE;
    }

    for (i = 0; i < MAX_WORKERS; i++)
        workers[i] = -1;

    if (caps_wl_install_stop_handlers() != 0) {
        fprintf(stderr, "caps_fork_tree: cannot install stop handlers: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }

    start_ms = caps_wl_monotonic_ms();
    if (start_ms < 0) {
        fprintf(stderr, "caps_fork_tree: CLOCK_MONOTONIC unavailable: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }
    deadline_ms = start_ms + (long long)seconds * 1000;

    caps_wl_say("topology workload started: %ld s, %ld worker(s), one "
                "grandchild under worker 1",
                seconds, children);

    for (i = 0; i < children; i++) {
        pid_t pid = fork();

        if (pid < 0) {
            fprintf(stderr, "caps_fork_tree: fork(worker %d): %s\n", i,
                    strerror(errno));
            rc = CAPS_WL_EXIT_SETUP;
            break;
        }
        if (pid == 0) {
            int child_rc = worker_run(i + 1, seconds, i == 0);
            _exit(child_rc);
        }
        workers[i] = pid;
        spawned++;
    }

    while (!caps_wl_stop) {
        long long now = caps_wl_monotonic_ms();
        if (now < 0 || now >= deadline_ms)
            break;
        caps_wl_sleep_ms(50);
    }

    /* Reap every worker; this also blocks until the tree is finished. */
    for (i = 0; i < spawned; i++) {
        int status = 0;
        if (waitpid(workers[i], &status, 0) < 0 && errno != ECHILD)
            fprintf(stderr, "caps_fork_tree: waitpid(worker %d): %s\n", i + 1,
                    strerror(errno));
    }

    elapsed_ms = caps_wl_monotonic_ms();
    caps_wl_say("%s: %.3f s elapsed, %d worker(s) reaped",
                caps_wl_stop ? "stopped by signal" : "completed",
                elapsed_ms < 0 ? 0.0 : (double)(elapsed_ms - start_ms) / 1000.0,
                spawned);

    if (rc == 0 && caps_wl_stop)
        rc = CAPS_WL_EXIT_STOPPED;
    return rc;
}
