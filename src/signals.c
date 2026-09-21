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
     * Called in the child immediately before execvp().  On failure this
     * returns -1 and the caller (process.c) reports it from the child
     * using write(2); exec still proceeds, so the child's only degraded
     * behavior would be inheriting SIG_IGN past exec (Ctrl+C ignored by
     * the executed program).  The failure is never silent.
     */
    return set_sigint(SIG_DFL);
}