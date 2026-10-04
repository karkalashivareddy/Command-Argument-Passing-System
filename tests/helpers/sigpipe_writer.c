/*
 * A producer that dies of SIGPIPE, deterministically, on purpose.
 *
 * WHY THIS EXISTS RATHER THAN `yes`
 * ---------------------------------
 * `yes | head -1` is the traditional way to produce a SIGPIPE, and it was the
 * engine's own test. It is not a property of the engine, though -- it is a
 * property of whichever `yes` happens to be installed. GNU coreutils `yes`,
 * the uutils replacement, and BusyBox `yes` all handle the failed write
 * differently, and a SIGPIPE-ignored ambient environment changes it again: the
 * write returns EPIPE, the program prints "Broken pipe" and exits non-zero, and
 * the kernel never delivers a signal at all. A release-blocking engine test
 * cannot rest on any of that.
 *
 * This helper removes every external dependency from the assertion:
 *
 *   - it installs NO signal handler and never touches SIGPIPE, so the default
 *     disposition the engine establishes in the child is what actually decides
 *     the outcome;
 *   - it writes through write(2) directly, so no stdio buffering can absorb a
 *     failed write and report success;
 *   - it writes far more than any pipe buffer can hold, so the producer is
 *     guaranteed to be blocked in write(2) when the consumer exits. That is the
 *     condition that turns "the consumer closed the pipe" into SIGPIPE, and it
 *     is what makes the result a fact rather than a race;
 *   - it is BOUNDED: the total byte budget is finite and the program exits 0
 *     after writing it. If the consumer never closes the pipe, the program
 *     still terminates on its own, so a broken engine shows up as a wrong
 *     result instead of a hung test run.
 *
 * The default pipe capacity on Linux is 64 KiB (2 x 16 pages by default). The
 * budget below is 1024x that, so the producer cannot possibly finish before the
 * consumer has had a chance to exit.
 *
 * Usage: sigpipe_writer [total_bytes]
 */
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <stdlib.h>
#include <unistd.h>

/* One 64 KiB write per call: a single pipe buffer's worth. */
#define CHUNK_BYTES 65536
#define DEFAULT_TOTAL_BYTES (1024LL * CHUNK_BYTES)

int main(int argc, char *argv[])
{
    static char chunk[CHUNK_BYTES];
    long long remaining = DEFAULT_TOTAL_BYTES;

    if (argc >= 2) {
        char *end = NULL;
        long long requested = strtoll(argv[1], &end, 10);
        /* A malformed budget is not silently treated as "unlimited"; the
         * default budget is used and the program stays bounded either way. */
        if (end == argv[1] || *end != '\0' || requested <= 0)
            requested = DEFAULT_TOTAL_BYTES;
        remaining = requested;
    }

    /*
     * Newline-terminated lines, NOT a solid block of bytes.
     *
     * This detail decides whether the test means anything. A consumer such as
     * `head -n 1` is waiting for a line; given 64 MiB with no newline anywhere
     * in it, head reads the entire stream looking for one that never arrives,
     * drains the pipe, and the producer then completes successfully with exit 0.
     * That is correct kernel behaviour and a completely vacuous SIGPIPE test:
     * nothing was killed because nothing was ever cut off. Emitting real lines
     * makes the consumer stop on the first one, which is what closes the pipe
     * while the producer is still blocked in write(2).
     */
    for (size_t i = 0; i < sizeof chunk; i += 2) {
        chunk[i] = 'y';
        chunk[i + 1] = '\n';
    }

    while (remaining > 0) {
        size_t want = (remaining < (long long)sizeof chunk)
                          ? (size_t)remaining
                          : sizeof chunk;
        ssize_t n = write(STDOUT_FILENO, chunk, want);

        if (n < 0) {
            /*
             * Only reachable if SIGPIPE is not at its default disposition:
             * then write(2) reports EPIPE instead of killing the process. Exit
             * non-zero so the distinction stays visible to the caller rather
             * than being reported as a successful producer.
             */
            if (errno == EPIPE)
                return 1;
            return 2;
        }
        if (n == 0)
            break;
        remaining -= n;
    }

    /* The consumer drained the whole budget without closing early. */
    return 0;
}
