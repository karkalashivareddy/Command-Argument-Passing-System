#ifndef CAPS_MONITOR_H
#define CAPS_MONITOR_H

/*
 * Real-time execution observability for caps.
 *
 * The execution core emits a small event stream as commands actually
 * move through their lifecycle (parsed -> redirection -> fork -> exec
 * -> exit/signal).  A monitor object formats those events immediately,
 * either as human-readable terminal lines or as one JSON object per
 * line, and accumulates session metrics for a final summary.
 *
 * The monitor is strictly observational: it never influences execution
 * and emits nothing unless a monitor was created.  Normal (non-monitor)
 * builds pass NULL and pay no cost.
 *
 * Event observation is event-driven inside the existing foreground
 * process lifecycle; no monitoring thread or polling exists.
 */

#include <stdio.h>
#include <sys/types.h>

typedef enum {
    CAPS_EVENT_COMMAND_RECEIVED = 1,  /* a raw command line was read      */
    CAPS_EVENT_PARSED,                /* tokenization/redirection split ok */
    CAPS_EVENT_COMMAND_PARSE_ERROR,   /* parse or redirection syntax error */
    CAPS_EVENT_REDIRECTION_OPENED,    /* all redirection files opened      */
    CAPS_EVENT_REDIRECTION_FAILED,    /* a redirection file could not open */
    CAPS_EVENT_PROCESS_STARTED,       /* fork() created the child          */
    CAPS_EVENT_PROCESS_EXITED,        /* waitpid() reaped the child        */
    CAPS_EVENT_SIGNAL_RECEIVED,       /* child was terminated by a signal  */
    CAPS_EVENT_EXEC_ERROR,            /* execvp() failed in the child      */
    CAPS_EVENT_WAIT_FAILED,           /* waitpid() failed permanently     */
    CAPS_EVENT_EXECUTION_FAILED,      /* CAPS could not launch the child   */
    CAPS_EVENT_SESSION_SUMMARY        /* monitor session summary           */
} caps_event_type_t;

/*
 * Terminal outcome of one observed execution, as the engine knows it.
 *
 * This is deliberately distinct from "did the observation finish?" and from
 * "did the target return 0?". The three are separate facts:
 *
 *   CAPS_OUTCOME_COMPLETED   the child ran and returned exit code 0
 *   CAPS_OUTCOME_EXITED      the child ran and returned a non-zero code
 *   CAPS_OUTCOME_SIGNALED    the child ran and was terminated by a signal
 *   CAPS_OUTCOME_EXEC_FAILED execvp() never succeeded; no program ran
 *   CAPS_OUTCOME_LAUNCH_FAILED CAPS itself could not fork/wait the child
 *   CAPS_OUTCOME_WAIT_FAILED  waitpid() failed; the outcome is unknown
 *
 * The gateway maps this to the session status. It must never infer success
 * from the presence of a SESSION_SUMMARY event.
 */
typedef enum {
    CAPS_OUTCOME_COMPLETED = 0,
    CAPS_OUTCOME_EXITED,
    CAPS_OUTCOME_SIGNALED,
    CAPS_OUTCOME_EXEC_FAILED,
    CAPS_OUTCOME_LAUNCH_FAILED,
    CAPS_OUTCOME_WAIT_FAILED
} caps_outcome_t;

/*
 * One observed event.  All fields are emitted by the execution core the
 * moment the underlying condition is true.
 *
 *   duration_ms : elapsed time measured with clock_gettime(CLOCK_MONOTONIC)
 *                 from process start to reap (only for PROCESS_EXITED);
 *                 this is real elapsed time, not wall-clock display time.
 *   pid         : the child process id (0 when no process is involved).
 *   status      : event-specific payload: for PROCESS_EXITED the exit code
 *                 (WEXITSTATUS or 128+signal), for SIGNAL_RECEIVED the
 *                 signal number, for EXEC_ERROR the 126/127 fallback status,
 *                 for WAIT_FAILED/EXECUTION_FAILED the negated errno so a
 *                 failure reason is never lost.
 *   errno_value : the failing errno, or 0 when errno does not apply.  Paired
 *                 with status it distinguishes 126 (EACCES) from 127
 *                 (ENOENT) without parsing human-readable text.
 *   message     : short machine-stable reason token, e.g. "exec_not_found".
 *                 Free of locale and of any user-supplied text.
 *   command     : borrowed string identifying the command; must outlive
 *                 the caps_monitor_emit() call.
 */
typedef struct {
    caps_event_type_t type;
    long long duration_ms;
    pid_t pid;
    int status;
    int errno_value;
    const char *message;
    /*
     * The producer's own verdict, not an inference by the formatter.  The
     * execution core is the only layer that knows whether execvp() succeeded,
     * so it states the outcome; the monitor only prints it.  Deriving it
     * downstream from the status code would be exactly the conflation this
     * field exists to remove.
     */
    caps_outcome_t outcome;
    const char *command;
} caps_event_t;

typedef struct caps_monitor caps_monitor_t;

/*
 * Create a monitor writing events to out (NULL/out == NULL disables).
 * json_mode != 0 selects one-JSON-object-per-line output; otherwise a
 * terminal-oriented line format is used.  Returns NULL on allocation
 * failure.
 */
caps_monitor_t *caps_monitor_create(FILE *out, int json_mode);

/* Release the monitor and its accumulated state. */
void caps_monitor_destroy(caps_monitor_t *mon);

/*
 * Emit one event immediately.  When mon is NULL this is a no-op, so the
 * execution core can always call it without branching.
 */
void caps_monitor_emit(caps_monitor_t *mon, const caps_event_t *ev);

/* Emit the session summary for the events seen so far. */
void caps_monitor_finish(caps_monitor_t *mon);

#endif /* CAPS_MONITOR_H */
