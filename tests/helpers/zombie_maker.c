/*
 * zombie_maker -- create a genuine zombie and report its PID.
 *
 * A zombie is a process that has exited but whose parent has not called
 * wait(2) on it.  Producing one from a shell is unreliable: bash reaps its own
 * asynchronous jobs, and a child whose parent exits is re-parented to init,
 * which reaps it immediately.  So every attempt to observe a zombie from a
 * shell tends to find none, which is why a zombie-handling assertion written
 * as a shell test ends up silently skipped rather than verified.
 *
 * This is the minimum program that produces one deterministically:
 *
 *   1. fork
 *   2. the child _exit(0) immediately
 *   3. the parent does NOT wait, and sleeps instead
 *
 * The child stays in the Z state for the parent's lifetime, so a test can read
 * its /proc entry and confirm its identity is still readable -- which is the
 * property that matters, because a zombie must not be mistaken for a
 * recycled PID.
 *
 * Usage:  zombie_maker <seconds-to-stay-alive>
 * Output: the child PID on stdout, then a line to stderr when the wait
 *         deadline has passed and the parent is about to exit.
 */

#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    long seconds = 5;
    pid_t child;

    if (argc == 2) {
        seconds = strtol(argv[1], NULL, 10);
        if (seconds < 0 || seconds > 3600) {
            fprintf(stderr, "usage: zombie_maker [0..3600 seconds]\n");
            return 2;
        }
    }

    child = fork();
    if (child < 0) {
        perror("fork");
        return 1;
    }
    if (child == 0) {
        /*
         * _exit, not exit: the child runs almost no code, so it has nothing to
         * flush and must not run the parent's atexit handlers.
         */
        _exit(0);
    }

    /*
     * Deliberately NO wait().  That omission is what creates the zombie.  The
     * parent prints the PID so the caller can inspect /proc/<pid>/stat, then
     * holds the zombie in existence long enough to be observed.
     */
    printf("%ld\n", (long) child);
    fflush(stdout);

    sleep((unsigned) seconds);

    fprintf(stderr, "zombie_maker exiting after %ld s\n", seconds);
    return 0;
}
