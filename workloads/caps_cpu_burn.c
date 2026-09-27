/*
 * caps_cpu_burn — controlled CPU workload.
 *
 *   caps_cpu_burn <seconds>
 *
 * Purpose: make one real Linux signal visible — sustained processor time
 * accumulated in utime/stime, observable through /proc/<pid>/stat.  The
 * workload performs genuine arithmetic on a 64-bit state so the compiler
 * cannot fold the loop away, and the final state is written to stdout once
 * so the result is observably consumed.
 *
 * Guarantees:
 *   - no shell, no network, no child processes
 *   - bounded duration (1..30 s, hard maximum in workload_common.h)
 *   - O(1) memory
 *   - bounded stdout (a single summary line)
 *   - clean exit on SIGINT/SIGTERM
 *
 * This is a laboratory workload, not a production load generator.
 */

#include "workload_common.h"

volatile sig_atomic_t caps_wl_stop = 0;

/*
 * A 64-bit mixing step using only arithmetic that maps to real integer
 * instructions.  The compiler is not permitted to treat the loop as
 * dead because the accumulator is volatile: every iteration must be
 * stored, and the final value is printed.
 */
static uint64_t mix(uint64_t x)
{
    x ^= x >> 33;
    x *= 0xff51afd7ed558ccdULL;
    x ^= x >> 33;
    x *= 0xc4ceb9fe1a85ec53ULL;
    x ^= x >> 33;
    return x;
}

int main(int argc, char **argv)
{
    long seconds = 10;
    long long start_ms, deadline_ms;
    uint64_t state = 0x243f6a8885a308d3ULL;
    unsigned long long iterations = 0;

    if (argc > 1 && caps_wl_parse_bounded(argv[1], CAPS_WL_MIN_DURATION_S,
                                          CAPS_WL_MAX_DURATION_S, &seconds) != 0) {
        caps_wl_usage(argv[0], "<seconds>",
                      "duration must be an integer 1..30 (controlled workload)");
        return CAPS_WL_EXIT_USAGE;
    }
    if (argc > 2) {
        caps_wl_usage(argv[0], "<seconds>",
                      "this workload accepts exactly one argument");
        return CAPS_WL_EXIT_USAGE;
    }

    if (caps_wl_install_stop_handlers() != 0) {
        fprintf(stderr, "caps_cpu_burn: cannot install stop handlers: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }

    start_ms = caps_wl_monotonic_ms();
    if (start_ms < 0) {
        fprintf(stderr, "caps_cpu_burn: CLOCK_MONOTONIC unavailable: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }
    deadline_ms = start_ms + (long long)seconds * 1000;

    caps_wl_say("cpu workload started, duration %ld s (deadline %lld ms)",
                seconds, deadline_ms - start_ms);

    /* Bounded batches so the stop flag is observed promptly. */
    while (!caps_wl_stop) {
        long long now = caps_wl_monotonic_ms();
        if (now < 0) {
            fprintf(stderr, "caps_cpu_burn: CLOCK_MONOTONIC failed: %s\n",
                    strerror(errno));
            return CAPS_WL_EXIT_SETUP;
        }
        if (now >= deadline_ms)
            break;

        for (int i = 0; i < 100000; i++) {
            state = mix(state + (uint64_t)i);
        }
        iterations += 100000;
    }

    {
        long long end_ms = caps_wl_monotonic_ms();
        double elapsed = end_ms < 0 ? 0.0 : (double)(end_ms - start_ms) / 1000.0;

        if (caps_wl_stop)
            caps_wl_say("cpu workload stopped by signal after %.3f s", elapsed);
        else
            caps_wl_say("cpu workload completed: %.3f s elapsed", elapsed);
        caps_wl_say("mixing rounds: %llu", iterations);
        caps_wl_say("checksum: %016llx",
                    (unsigned long long)(state & 0xffffffffULL));
    }

    return caps_wl_stop ? CAPS_WL_EXIT_STOPPED : 0;
}
