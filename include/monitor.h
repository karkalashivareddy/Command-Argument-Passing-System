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
    CAPS_EVENT_SESSION_SUMMARY        /* monitor session summary           */
} caps_event_type_t;

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
 *                 signal number, for EXEC_ERROR the 126/127 fallback status.
 *   command     : borrowed string identifying the command; must outlive
 *                 the caps_monitor_emit() call.
 */
typedef struct {
    caps_event_type_t type;
    long long duration_ms;
    pid_t pid;
    int status;
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
