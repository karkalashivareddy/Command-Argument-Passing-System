/*
 * caps_memory_burn — controlled resident-memory workload.
 *
 *   caps_memory_burn <seconds> <mib>
 *
 * Purpose: make /proc/<pid>/status VmRSS move in a way an operator can
 * watch.  The target working set is allocated with a single anonymous
 * mmap() and every page is touched once so the pages actually become
 * resident, which is what RSS reports.
 *
 * Guarantees:
 *   - no shell, no network, no child processes
 *   - bounded duration (1..30 s) and bounded footprint (1..256 MiB)
 *   - allocation failure is reported, never papered over
 *   - the mapping is always released (including on the signal path)
 *   - bounded stdout
 *
 * This is a controlled laboratory workload.  It is not a memory stress
 * test and it is not representative of production load.
 */

#include <sys/mman.h>
#include <unistd.h>

#include "workload_common.h"

volatile sig_atomic_t caps_wl_stop = 0;

#define PAGE_TOUCH_BATCH 256

int main(int argc, char **argv)
{
    long seconds = 10;
    long mib = 64;
    long long start_ms, deadline_ms;
    size_t bytes, page;
    unsigned char *region = MAP_FAILED;
    long rounds = 0;

    if (argc > 1 && caps_wl_parse_bounded(argv[1], CAPS_WL_MIN_DURATION_S,
                                          CAPS_WL_MAX_DURATION_S, &seconds) != 0) {
        caps_wl_usage(argv[0], "<seconds> <mib>",
                      "duration must be an integer 1..30 (controlled workload)");
        return CAPS_WL_EXIT_USAGE;
    }
    if (argc > 2 && caps_wl_parse_bounded(argv[2], 1, CAPS_WL_MAX_MEMORY_MIB,
                                          &mib) != 0) {
        caps_wl_usage(argv[0], "<seconds> <mib>",
                      "target footprint must be an integer 1..256 MiB");
        return CAPS_WL_EXIT_USAGE;
    }
    if (argc > 3) {
        caps_wl_usage(argv[0], "<seconds> <mib>",
                      "this workload accepts at most two arguments");
        return CAPS_WL_EXIT_USAGE;
    }

    if (caps_wl_install_stop_handlers() != 0) {
        fprintf(stderr, "caps_memory_burn: cannot install stop handlers: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }

    page = (size_t)sysconf(_SC_PAGESIZE);
    if (page == 0 || page == (size_t)-1) {
        fprintf(stderr, "caps_memory_burn: cannot determine page size: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }

    bytes = (size_t)mib * 1024u * 1024u;
    if (bytes % page != 0)
        bytes += page - (bytes % page);

    region = mmap(NULL, bytes, PROT_READ | PROT_WRITE,
                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (region == MAP_FAILED) {
        fprintf(stderr,
                "caps_memory_burn: mmap of %ld MiB failed: %s\n", mib,
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }

    start_ms = caps_wl_monotonic_ms();
    if (start_ms < 0) {
        munmap(region, bytes);
        fprintf(stderr, "caps_memory_burn: CLOCK_MONOTONIC unavailable: %s\n",
                strerror(errno));
        return CAPS_WL_EXIT_SETUP;
    }
    deadline_ms = start_ms + (long long)seconds * 1000;

    caps_wl_say("memory workload started: %ld MiB target for %ld s", mib,
                seconds);

    /* Touch every page so the mapping becomes resident, then keep a slow
     * read/write pass running for the requested duration.  The pass is
     * deliberately gentle: the interesting signal is VmRSS, not fault
     * storms. */
    for (size_t off = 0; off < bytes; off += page)
        region[off] = (unsigned char)(off / page);

    while (!caps_wl_stop) {
        long long now = caps_wl_monotonic_ms();
        if (now < 0) {
            munmap(region, bytes);
            fprintf(stderr, "caps_memory_burn: CLOCK_MONOTONIC failed: %s\n",
                    strerror(errno));
            return CAPS_WL_EXIT_SETUP;
        }
        if (now >= deadline_ms)
            break;

        for (size_t i = 0; i < PAGE_TOUCH_BATCH; i++) {
            size_t off = ((size_t)rounds * PAGE_TOUCH_BATCH + i) * page;
            if (off >= bytes) {
                off = (off % bytes);
            }
            region[off] = (unsigned char)(region[off] + 1u);
        }
        rounds++;
        caps_wl_sleep_ms(50);
    }

    {
        long long end_ms = caps_wl_monotonic_ms();
        double elapsed = end_ms < 0 ? 0.0 : (double)(end_ms - start_ms) / 1000.0;

        if (munmap(region, bytes) != 0)
            fprintf(stderr, "caps_memory_burn: munmap failed: %s\n",
                    strerror(errno));

        if (caps_wl_stop)
            caps_wl_say("memory workload stopped by signal after %.3f s",
                        elapsed);
        else
            caps_wl_say("memory workload completed: %.3f s elapsed", elapsed);
        caps_wl_say("resident target %ld MiB released", mib);
    }

    return caps_wl_stop ? CAPS_WL_EXIT_STOPPED : 0;
}
