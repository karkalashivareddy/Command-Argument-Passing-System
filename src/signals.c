#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <string.h>

#include "signals.h"
#include "utils.h"

/* Install a SIGINT handler; returns 0 on success, -1 on failure. */
static int set_sigint(void (*handler)(int))
{
    struct sigaction sa;

    sa.sa_handler = handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;

    if (sigaction(SIGINT, &sa, NULL) != 0)
        return -1;
    return 0;
}

/*
 * Restore SIGPIPE to its default disposition.
 *
 * WHY THIS EXISTS
 * ---------------
 * POSIX execvp() carries an *ignored* disposition across exec, and a SIG_IGN
 * SIGPIPE that reaches the child is inherited by every program caps launches.
 * A producer in `producer | consumer` whose consumer exits first then does not
 * die of SIGPIPE: the write returns EPIPE, the program reports "Broken pipe" and
 * exits with its own non-zero status.  The engine then correctly records
 * PROCESS_EXITED/EXITED -- and there is no signal at all, so nothing anywhere
 * says a pipeline stage was killed by a closed pipe.
 *
 * The disposition is not caps's to inherit.  A host shell, a package manager, a
 * container runtime, or a CI step wrapper may all set SIGPIPE to SIG_IGN for
 * their own reasons (a long-running log collector typically does), and the
 * engine's pipeline signal model then silently changes with the environment it
 * happens to run in.  That is exactly the class of defect an execution engine
 * must not have: the same command line must mean the same thing everywhere.
 *
 * So the child model is stated rather than inherited.  Both dispositions caps
 * depends on are established explicitly here:
 *
 *   SIGINT  default, so a program that raises SIGINT on itself terminates.
 *   SIGPIPE default, so a producer writing to a closed pipe is killed by the
 *           kernel, which is the behaviour the pipeline evidence reports.
 *
 * A disposition that cannot be restored fails the call: exec preserves SIG_IGN,
 * so continuing would hand the program a signal model CAPS never promised.
 */
static int set_sigpipe(void (*handler)(int))
{
    struct sigaction sa;

    sa.sa_handler = handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;

    if (sigaction(SIGPIPE, &sa, NULL) != 0)
        return -1;
    return 0;
}

int signals_parent_init(void)
{
    if (set_sigint(SIG_IGN) != 0) {
        /*
         * Explicit failure policy: report the failure and let the caller
         * react.  The shell keeps running in a degraded state: Ctrl+C will
         * then also terminate the parent while a child runs.  Failing to
         * ignore SIGINT is never "success".
         */
        caps_error("sigaction(SIGINT, SIG_IGN): %s", strerror(errno));
        return -1;
    }
    return 0;
}

int signals_child_reset(void)
{
    /*
     * Called in the child immediately before execvp(), on every launch path:
     * the single-command path and each stage of a pipeline.  On failure this
     * returns -1 and the caller (process.c) reports it from the child using
     * write(2) and refuses the launch; exec still happens either way, so the
     * failure is never silent.
     *
     * SIGINT is restored first so the existing behaviour and the existing
     * refusal message stay exactly as they were, then SIGPIPE.  The errno the
     * caller reports is the one from whichever call failed.
     */
    if (set_sigint(SIG_DFL) != 0)
        return -1;
    if (set_sigpipe(SIG_DFL) != 0)
        return -1;
    return 0;
}
