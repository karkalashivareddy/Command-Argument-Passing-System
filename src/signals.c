#include <signal.h>
#include <stddef.h>

#include "signals.h"

static void set_sigint(void (*handler)(int), int *ok)
{
    struct sigaction sa;

    sa.sa_handler = handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;

    if (sigaction(SIGINT, &sa, NULL) != 0)
        *ok = -1;
    else
        *ok = 0;
}

void signals_parent_init(void)
{
    int ok;

    set_sigint(SIG_IGN, &ok);

    /*
     * Failure to ignore SIGINT is not fatal: caps simply keeps the
     * default disposition, in which case Ctrl+C also kills the parent.
     * This is degraded but never corrupt.
     */
    (void)ok;
}

void signals_child_reset(void)
{
    int ok;

    set_sigint(SIG_DFL, &ok);

    /*
     * Called in the child immediately before execvp().  On the
     * (near-impossible) failure path the child would keep SIG_IGN and
     * the executed program would ignore Ctrl+C; exec continues anyway
     * because this is not a reason to abandon the command.
     */
    (void)ok;
}