#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "monitor.h"

struct caps_monitor {
    FILE *out;
    int json;
    /* Session metrics, accumulated from observed events only. */
    long commands;
    long succeeded;
    long failed;
    long signals;
    long timed;
    long exec_errors;
    long launch_errors;
    long long total_duration_ms;
};

/*
 * Display-only wall-clock timestamp "HH:MM:SS.mmm" taken from the realtime
 * clock.  This is presentation time, deliberately distinct from the
 * monotonic duration_ms carried by events.
 *
 * Failure policy: if the realtime clock or its local-time conversion
 * cannot be read, the field is replaced by a fixed placeholder.  The
 * event is still emitted, so a failing clock degrades a display field
 * rather than producing an uninitialised value or invalid JSON.
 */
static void format_wall_time(char *buf, size_t size)
{
    struct timespec ts;
    struct tm tm;

    if (size == 0)
        return;

    if (clock_gettime(CLOCK_REALTIME, &ts) != 0 ||
        localtime_r(&ts.tv_sec, &tm) == NULL) {
        snprintf(buf, size, "??:??:??.???");
        return;
    }

    snprintf(buf, size, "%02d:%02d:%02d.%03d", tm.tm_hour, tm.tm_min,
             tm.tm_sec, (int)(ts.tv_nsec / 1000000));
}

caps_monitor_t *caps_monitor_create(FILE *out, int json_mode)
{
    caps_monitor_t *mon;

    if (out == NULL)
        return NULL;

    mon = calloc(1, sizeof *mon);
    if (mon == NULL)
        return NULL;

    mon->out = out;
    mon->json = json_mode;
    return mon;
}

void caps_monitor_destroy(caps_monitor_t *mon)
{
    free(mon);
}

/*
 * Minimal JSON string escaping so arbitrary command tokens (which may
 * contain quotes, backslashes or control characters) cannot break the
 * one-object-per-line guarantee.
 */
static void json_escape(FILE *out, const char *s)
{
    const unsigned char *p = (const unsigned char *)s;

    putc('"', out);
    for (; *p != '\0'; p++) {
        switch (*p) {
        case '"':
            fputs("\\\"", out);
            break;
        case '\\':
            fputs("\\\\", out);
            break;
        case '\b':
            fputs("\\b", out);
            break;
        case '\f':
            fputs("\\f", out);
            break;
        case '\n':
            fputs("\\n", out);
            break;
        case '\r':
            fputs("\\r", out);
            break;
        case '\t':
            fputs("\\t", out);
            break;
        default:
            if (*p < 0x20)
                fprintf(out, "\\u%04x", *p);
            else
                putc(*p, out);
            break;
        }
    }
    putc('"', out);
}

static const char *event_name(caps_event_type_t type)
{
    switch (type) {
    case CAPS_EVENT_COMMAND_RECEIVED:
        return "COMMAND_RECEIVED";
    case CAPS_EVENT_PARSED:
        return "PARSED";
    case CAPS_EVENT_COMMAND_PARSE_ERROR:
        return "COMMAND_PARSE_ERROR";
    case CAPS_EVENT_PIPELINE_PARSED:
        return "PIPELINE_PARSED";
    case CAPS_EVENT_PIPELINE_STARTED:
        return "PIPELINE_STARTED";
    case CAPS_EVENT_PIPELINE_COMPLETED:
        return "PIPELINE_COMPLETED";
    case CAPS_EVENT_REDIRECTION_OPENED:
        return "REDIRECTION_OPENED";
    case CAPS_EVENT_REDIRECTION_FAILED:
        return "REDIRECTION_FAILED";
    case CAPS_EVENT_PROCESS_STARTED:
        return "PROCESS_STARTED";
    case CAPS_EVENT_PROCESS_EXITED:
        return "PROCESS_EXITED";
    case CAPS_EVENT_SIGNAL_RECEIVED:
        return "SIGNAL_RECEIVED";
    case CAPS_EVENT_EXEC_ERROR:
        return "EXEC_ERROR";
    case CAPS_EVENT_WAIT_FAILED:
        return "WAIT_FAILED";
    case CAPS_EVENT_EXECUTION_FAILED:
        return "EXECUTION_FAILED";
    case CAPS_EVENT_SESSION_SUMMARY:
        return "SESSION_SUMMARY";
    default:
        return "UNKNOWN_EVENT";
    }
}

/*
 * Machine-readable lifecycle verdict for a terminal process event.
 *
 * This is the field that makes "the observation finished" independent of
 * "the target succeeded".  A consumer that only looks at whether a summary
 * was printed will conclude that a failed execvp() was a successful run;
 * reading `outcome` cannot be mistaken that way.  The value is supplied by
 * the execution core, which is the only layer that knows the difference.
 */
static const char *outcome_name(caps_outcome_t outcome)
{
    switch (outcome) {
    case CAPS_OUTCOME_COMPLETED:
        return "COMPLETED";
    case CAPS_OUTCOME_EXITED:
        return "EXITED";
    case CAPS_OUTCOME_SIGNALED:
        return "SIGNALED";
    case CAPS_OUTCOME_EXEC_FAILED:
        return "EXEC_FAILED";
    case CAPS_OUTCOME_LAUNCH_FAILED:
        return "LAUNCH_FAILED";
    case CAPS_OUTCOME_WAIT_FAILED:
        return "WAIT_FAILED";
    default:
        return "OBSERVED";
    }
}

/*
 * Print one duration_ms value as JSON.
 *
 * The engine's elapsed_ms() returns -1 when the monotonic clock could not be
 * sampled at either end of the process, and that is a real absence rather
 * than a measurement of zero: a program that finished inside a millisecond
 * measures 0. Emitting null for the first case keeps the two distinguishable,
 * which is the same UNAVAILABLE-never-zero rule the rest of the project follows.
 */
static void print_duration_ms(FILE *out, long long duration_ms)
{
    if (duration_ms < 0)
        fputs("null", out);
    else
        fprintf(out, "%lld", duration_ms);
}

static void emit_terminal(caps_monitor_t *mon, const caps_event_t *ev)
{
    char wall[32];

    format_wall_time(wall, sizeof wall);

    switch (ev->type) {
    case CAPS_EVENT_COMMAND_RECEIVED:
    case CAPS_EVENT_PARSED:
    case CAPS_EVENT_COMMAND_PARSE_ERROR:
    case CAPS_EVENT_REDIRECTION_OPENED:
    case CAPS_EVENT_REDIRECTION_FAILED:
        fprintf(mon->out, "[%s] %-22s %s\n", wall, event_name(ev->type),
                ev->command ? ev->command : "(none)");
        break;
    case CAPS_EVENT_PROCESS_STARTED:
        fprintf(mon->out, "[%s] %-22s pid=%ld\n", wall,
                event_name(ev->type), (long)ev->pid);
        break;
    case CAPS_EVENT_SIGNAL_RECEIVED:
        fprintf(mon->out, "[%s] %-22s pid=%ld signal=%d\n", wall,
                event_name(ev->type), (long)ev->pid, ev->status);
        break;
    case CAPS_EVENT_PROCESS_EXITED:
        fprintf(mon->out, "[%s] %-22s pid=%ld status=%d duration=", wall,
                event_name(ev->type), (long)ev->pid, ev->status);
        /*
         * -1 is the sentinel for "not measured" (see elapsed_ms() in
         * process.c), and it is printed as such rather than as 0.  A
         * sub-millisecond run measures 0, so 0 is a real reading and
         * cannot double as an absent one.
         */
        if (ev->duration_ms < 0)
            fputs("UNAVAILABLE\n", mon->out);
        else
            fprintf(mon->out, "%lldms\n", ev->duration_ms);
        break;
    case CAPS_EVENT_EXEC_ERROR:
    case CAPS_EVENT_WAIT_FAILED:
    case CAPS_EVENT_EXECUTION_FAILED:
        fprintf(mon->out, "[%s] %-22s pid=%ld status=%d errno=%d reason=%s %s\n",
                wall, event_name(ev->type), (long)ev->pid, ev->status,
                ev->errno_value, ev->message ? ev->message : "-",
                ev->command ? ev->command : "(none)");
        break;
    default:
        break;
    }
    fflush(mon->out);
}

static void emit_json(caps_monitor_t *mon, const caps_event_t *ev)
{
    char wall[32];

    format_wall_time(wall, sizeof wall);

    switch (ev->type) {
    case CAPS_EVENT_COMMAND_RECEIVED:
        {
            /*
             * The line exactly as the operator typed it, bounded.
             *
             * The raw line is the honest record of the request -- it is what the
             * user asked for, before any lexing -- but the engine accepts a line
             * up to `maxLineBytes`, so emitting it verbatim would put a 64 KB
             * event into an SSE frame and a SQLite row. Bounded, with the
             * truncation declared, because a silently shortened request would be
             * a record that disagrees with what was typed and nothing would say
             * so.
             */
            enum { LINE_BUDGET = 400 };
            const char *text = ev->command ? ev->command : "";
            size_t len = strlen(text);
            int truncated = len > LINE_BUDGET;
            fprintf(mon->out, "{\"event\":\"%s\",\"time\":\"%s\",\"command\":",
                    event_name(ev->type), wall);
            if (!truncated) {
                json_escape(mon->out, text);
            } else {
                /*
                 * Cut on a byte boundary, then walk back to the nearest space so
                 * the record ends on a whole token. Ending mid-word would read
                 * as a shorter argument than the one typed.
                 */
                size_t cut = LINE_BUDGET;
                while (cut > 0 && text[cut - 1] != ' ')
                    cut--;
                char head[LINE_BUDGET + 1];
                memcpy(head, text, cut);
                head[cut] = '\0';
                json_escape(mon->out, head);
                fputs("...", mon->out);
            }
            if (truncated) {
                fprintf(mon->out, ",\"command_truncated\":true,\"command_bytes_total\":%zu", len);
            }
            fputs("}\n", mon->out);
        }
        break;
    case CAPS_EVENT_PARSED:
    case CAPS_EVENT_COMMAND_PARSE_ERROR:
    case CAPS_EVENT_REDIRECTION_OPENED:
    case CAPS_EVENT_REDIRECTION_FAILED:
        fprintf(mon->out, "{\"event\":\"%s\",\"time\":\"%s\",\"command\":",
                event_name(ev->type), wall);
        json_escape(mon->out, ev->command ? ev->command : "");
        fputs("}\n", mon->out);
        break;
    case CAPS_EVENT_PROCESS_STARTED:
        /*
         * stage_index and stage_count are emitted for every process, and a
         * single command reports stage 0 of 1.  A pipeline reader needs them to
         * know which of several processes an event refers to; a single-command
         * reader needs them to know that there is only one.  Emitting them
         * unconditionally means no consumer has to infer "was this a
         * pipeline?" from the absence of a field, and it keeps the rule
         * `0 <= stage < stages` true for every event.
         */
        fprintf(mon->out,
                "{\"event\":\"%s\",\"time\":\"%s\",\"pid\":%ld,"
                "\"pgid\":%ld,\"stage\":%d,\"stages\":%d,\"command\":",
                event_name(ev->type), wall, (long)ev->pid, (long)ev->pgid,
                ev->stage_index, ev->stage_count);
        json_escape(mon->out, ev->command ? ev->command : "");
        /*
         * The argv elements, emitted alongside the joined label.
         *
         * The label alone is lossy: an element containing a space and two
         * elements that do not both render as the same text, so a consumer
         * wanting the real argv would have to split the string again. That is a
         * second lexer, and two lexers eventually disagree about one quoting
         * case -- always in the unsafe direction, where the reader is told what
         * ran and it is wrong.
         */
        if (ev->argv != NULL && ev->argv_count > 0) {
            /*
             * The argv elements, emitted alongside the joined label.
             *
             * Bounded, because this stream feeds SSE frames and SQLite rows and
             * a single 2 KB argument would otherwise produce a 2 KB event line.
             * The bound is 400 bytes of escaped content plus the JSON framing,
             * which keeps an event comfortably under the 600-byte ceiling the
             * monitor suite enforces.
             *
             * Truncation is EXPLICIT. A silently shortened argv would be a
             * record that disagrees with what ran, and a reader would have no
             * way to know. So when elements are dropped, `argv_truncated` says
             * so and `argv_bytes_recorded` says how much of the real vector
             * survived.
             *
             * argv[0] is always emitted whatever the budget, because it is the
             * element that identifies which program ran. A record that kept
             * only arguments but dropped the command name would be the worst
             * possible truncation.
             */
            enum { ARGV_BUDGET = 400 };
            size_t used = 0;
            int emitted = 0;
            int dropped = 0;
            fputs(",\"argv\":[", mon->out);
            for (int i = 0; i < ev->argv_count; i++) {
                const char *element = ev->argv[i] ? ev->argv[i] : "";
                size_t need = strlen(element) + 3; /* two quotes and a comma */
                if (i > 0 && used + need > ARGV_BUDGET) {
                    dropped = ev->argv_count - emitted;
                    break;
                }
                if (i > 0)
                    fputc(',', mon->out);
                /* json_escape emits the element WITH its surrounding quotes and
                 * escapes the contents. Adding quotes around it here doubled
                 * them and made every event unparseable, which is why this line
                 * reads as a bare call. */
                json_escape(mon->out, element);
                used += need;
                emitted++;
            }
            fputc(']', mon->out);
            if (dropped > 0) {
                fprintf(mon->out,
                        ",\"argv_truncated\":true,\"argv_elements_dropped\":%d,"
                        "\"argv_elements_total\":%d",
                        dropped, ev->argv_count);
            }
        }
        fputs("}\n", mon->out);
        break;
    case CAPS_EVENT_PROCESS_EXITED:
        fprintf(mon->out,
                "{\"event\":\"%s\",\"time\":\"%s\",\"pid\":%ld,"
                "\"pgid\":%ld,\"stage\":%d,\"stages\":%d,"
                "\"exit_code\":%d,\"duration_ms\":", event_name(ev->type),
                wall, (long)ev->pid, (long)ev->pgid, ev->stage_index,
                ev->stage_count, ev->status);
        print_duration_ms(mon->out, ev->duration_ms);
        fprintf(mon->out, ",\"outcome\":\"%s\",\"command\":",
                outcome_name(ev->outcome));
        json_escape(mon->out, ev->command ? ev->command : "");
        fputs("}\n", mon->out);
        break;
    case CAPS_EVENT_PIPELINE_PARSED:
    case CAPS_EVENT_PIPELINE_STARTED:
    case CAPS_EVENT_PIPELINE_COMPLETED:
        /*
         * The pipeline envelope.  PIPELINE_STARTED carries the process group
         * that later stages join, so the whole pipeline is addressable as one
         * unit; PIPELINE_COMPLETED carries the pipeline's own outcome, which is
         * the LAST stage's, while every stage keeps its own separate events.
         */
        fprintf(mon->out,
                "{\"event\":\"%s\",\"time\":\"%s\",\"pid\":%ld,"
                "\"pgid\":%ld,\"stage\":%d,\"stages\":%d,\"outcome\":\"%s\","
                "\"command\":",
                event_name(ev->type), wall, (long)ev->pid, (long)ev->pgid,
                ev->stage_index, ev->stage_count, outcome_name(ev->outcome));
        json_escape(mon->out, ev->command ? ev->command : "");
        fputs("}\n", mon->out);
        break;
    case CAPS_EVENT_SIGNAL_RECEIVED:
        fprintf(mon->out,
                "{\"event\":\"%s\",\"time\":\"%s\",\"pid\":%ld,"
                "\"pgid\":%ld,\"stage\":%d,\"stages\":%d,\"signal\":%d,"
                "\"outcome\":\"%s\",\"command\":",
                event_name(ev->type), wall, (long)ev->pid, (long)ev->pgid,
                ev->stage_index, ev->stage_count, ev->status,
                outcome_name(ev->outcome));
        json_escape(mon->out, ev->command ? ev->command : "");
        fputs("}\n", mon->out);
        break;
    case CAPS_EVENT_EXEC_ERROR:
        /*
         * The failure reason is the whole point of this event.  status is the
         * shell-convention status the process actually terminated with (126
         * for EACCES, 127 for "not found"), and errno/errno_name carry the
         * kernel reason, so a consumer never has to parse the human-readable
         * diagnostic that also went to stderr.
         */
        fprintf(mon->out,
                "{\"event\":\"%s\",\"time\":\"%s\",\"pid\":%ld,"
                "\"exit_code\":%d,\"errno\":%d,\"errno_name\":\"%s\","
                "\"reason\":\"%s\",\"outcome\":\"%s\",\"command\":",
                event_name(ev->type), wall, (long)ev->pid, ev->status,
                ev->errno_value, ev->errno_value ? strerror(ev->errno_value) : "",
                ev->message ? ev->message : "", outcome_name(ev->outcome));
        json_escape(mon->out, ev->command ? ev->command : "");
        fputs("}\n", mon->out);
        break;
    case CAPS_EVENT_WAIT_FAILED:
    case CAPS_EVENT_EXECUTION_FAILED:
        /*
         * No program result exists for these.  status carries the negated
         * errno so the event is never a bare marker with no reason, and
         * outcome states plainly that the observation itself failed.
         */
        fprintf(mon->out,
                "{\"event\":\"%s\",\"time\":\"%s\",\"pid\":%ld,"
                "\"exit_code\":null,\"errno\":%d,\"errno_name\":\"%s\","
                "\"reason\":\"%s\",\"duration_ms\":",
                event_name(ev->type), wall, (long)ev->pid, ev->errno_value,
                ev->errno_value ? strerror(ev->errno_value) : "",
                ev->message ? ev->message : "");
        print_duration_ms(mon->out, ev->duration_ms);
        fprintf(mon->out, ",\"outcome\":\"%s\",\"command\":",
                outcome_name(ev->outcome));
        json_escape(mon->out, ev->command ? ev->command : "");
        fputs("}\n", mon->out);
        break;
    default:
        break;
    }
    fflush(mon->out);
}

void caps_monitor_emit(caps_monitor_t *mon, const caps_event_t *ev)
{
    if (mon == NULL || ev == NULL)
        return;

    switch (ev->type) {
    case CAPS_EVENT_PROCESS_STARTED:
        mon->commands++;
        break;
    case CAPS_EVENT_PROCESS_EXITED:
        /*
         * Only a real measurement contributes to the average. An event whose
         * duration is unavailable (-1, see print_duration_ms) still counts as
         * a command and still counts as succeeded or failed; it just does not
         * become a 0 in the mean, which would silently pull the average down.
         */
        if (ev->duration_ms >= 0) {
            mon->timed++;
            mon->total_duration_ms += ev->duration_ms;
        }
        if (ev->status == 0)
            mon->succeeded++;
        else
            mon->failed++;
        break;
    case CAPS_EVENT_SIGNAL_RECEIVED:
        mon->signals++;
        break;
    case CAPS_EVENT_EXEC_ERROR:
        mon->failed++;
        mon->exec_errors++;
        break;
    case CAPS_EVENT_WAIT_FAILED:
    case CAPS_EVENT_EXECUTION_FAILED:
        /*
         * Counted as a failed execution but NOT as an observed process
         * result: no program ran, so there is no exit code and no duration to
         * average.  A summary that said otherwise would invent a measurement.
         */
        mon->failed++;
        mon->launch_errors++;
        break;
    default:
        break;
    }

    if (mon->json)
        emit_json(mon, ev);
    else
        emit_terminal(mon, ev);

    /*
     * Flush after EVERY event.
     *
     * This is what makes the monitor a stream rather than a report. An event
     * that sits in a stdio buffer is not observable: a gateway reading this
     * stream sees nothing until the buffer fills or the process exits, so a
     * PROCESS_STARTED for a long-running workload does not appear until the
     * workload is over. That is fatal for a live observatory, and it is not
     * merely a latency problem -- a consumer that cannot see the start cannot
     * observe the process while it exists, which is the only time there is
     * anything to observe.
     *
     * The flush is per-event rather than per-line because one event is one line
     * and the two coincide.
     */
    fflush(mon->out);
}

/*
 * Close the monitor session.
 *
 * SESSION_SUMMARY means "the monitor reached the end of its input".  It is
 * NOT a success claim: the exec_errors / launch_errors counters and the
 * presence of an EXEC_ERROR, WAIT_FAILED, or EXECUTION_FAILED event are what
 * say whether the observed commands actually ran.  Consumers that treat the
 * presence of this event as proof of execution are reading the wrong field,
 * so the failure counters are emitted here as first-class data.
 */
void caps_monitor_finish(caps_monitor_t *mon)
{
    double average_ms;
    caps_event_t summary;
    const int clean = mon->exec_errors == 0 && mon->launch_errors == 0;

    if (mon == NULL)
        return;

    average_ms = (mon->timed > 0)
                     ? (double)mon->total_duration_ms / (double)mon->timed
                     : 0.0;

    memset(&summary, 0, sizeof summary);
    summary.type = CAPS_EVENT_SESSION_SUMMARY;

    if (mon->json) {
        fprintf(mon->out,
                "{\"event\":\"SESSION_SUMMARY\",\"commands\":%ld,"
                "\"succeeded\":%ld,\"failed\":%ld,\"signals\":%ld,"
                "\"timed\":%ld,\"exec_errors\":%ld,\"launch_errors\":%ld,"
                "\"observed_cleanly\":%s,\"average_duration_ms\":%.1f}\n",
                mon->commands, mon->succeeded, mon->failed, mon->signals,
                mon->timed, mon->exec_errors, mon->launch_errors,
                clean ? "true" : "false", average_ms);
    } else {
        fputs("Session Summary\n", mon->out);
        fputs("---------------\n", mon->out);
        fprintf(mon->out, "Commands: %ld\n", mon->commands);
        fprintf(mon->out, "Succeeded: %ld\n", mon->succeeded);
        fprintf(mon->out, "Failed: %ld\n", mon->failed);
        fprintf(mon->out, "Signals: %ld\n", mon->signals);
        fprintf(mon->out, "Exec errors: %ld\n", mon->exec_errors);
        fprintf(mon->out, "Launch/wait errors: %ld\n", mon->launch_errors);
        if (mon->timed > 0)
            fprintf(mon->out, "Average duration: %.1f ms\n", average_ms);
        else
            fputs("Average duration: n/a\n", mon->out);
    }
    fflush(mon->out);
}
