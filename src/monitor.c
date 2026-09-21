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
    long long total_duration_ms;
};

/*
 * Display-only wall-clock timestamp "HH:MM:SS.mmm" taken from the realtime
 * clock.  This is presentation time, deliberately distinct from the
 * monotonic duration_ms carried by events.
 */
static void format_wall_time(char *buf, size_t size)
{
    struct timespec ts;
    struct tm tm;

    clock_gettime(CLOCK_REALTIME, &ts);
    localtime_r(&ts.tv_sec, &tm);
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
    case CAPS_EVENT_SESSION_SUMMARY:
        return "SESSION_SUMMARY";
    default:
        return "UNKNOWN_EVENT";
    }
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
        fprintf(mon->out, "[%s] %-22s pid=%ld status=%d duration=%lldms\n",
                wall, event_name(ev->type), (long)ev->pid, ev->status,
                ev->duration_ms);
        break;
    case CAPS_EVENT_EXEC_ERROR:
        fprintf(mon->out, "[%s] %-22s pid=%ld %s\n", wall,
                event_name(ev->type), (long)ev->pid,
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
        fprintf(mon->out,
                "{\"event\":\"%s\",\"time\":\"%s\",\"pid\":%ld,\"command\":",
                event_name(ev->type), wall, (long)ev->pid);
        json_escape(mon->out, ev->command ? ev->command : "");
        fputs("}\n", mon->out);
        break;
    case CAPS_EVENT_SIGNAL_RECEIVED:
        fprintf(mon->out,
                "{\"event\":\"%s\",\"time\":\"%s\",\"pid\":%ld,\"signal\":%d,"
                "\"command\":",
                event_name(ev->type), wall, (long)ev->pid, ev->status);
        json_escape(mon->out, ev->command ? ev->command : "");
        fputs("}\n", mon->out);
        break;
    case CAPS_EVENT_PROCESS_EXITED:
        fprintf(mon->out,
                "{\"event\":\"%s\",\"time\":\"%s\",\"pid\":%ld,\"exit_code\":"
                "%d,\"duration_ms\":%lld,\"command\":",
                event_name(ev->type), wall, (long)ev->pid, ev->status,
                ev->duration_ms);
        json_escape(mon->out, ev->command ? ev->command : "");
        fputs("}\n", mon->out);
        break;
    case CAPS_EVENT_EXEC_ERROR:
        fprintf(mon->out,
                "{\"event\":\"%s\",\"time\":\"%s\",\"pid\":%ld,\"command\":",
                event_name(ev->type), wall, (long)ev->pid);
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
        mon->timed++;
        mon->total_duration_ms += ev->duration_ms;
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
        break;
    default:
        break;
    }

    if (mon->json)
        emit_json(mon, ev);
    else
        emit_terminal(mon, ev);
}

void caps_monitor_finish(caps_monitor_t *mon)
{
    double average_ms;
    caps_event_t summary;

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
                "\"timed\":%ld,\"average_duration_ms\":%.1f}\n",
                mon->commands, mon->succeeded, mon->failed, mon->signals,
                mon->timed, average_ms);
    } else {
        fputs("Session Summary\n", mon->out);
        fputs("---------------\n", mon->out);
        fprintf(mon->out, "Commands: %ld\n", mon->commands);
        fprintf(mon->out, "Succeeded: %ld\n", mon->succeeded);
        fprintf(mon->out, "Failed: %ld\n", mon->failed);
        fprintf(mon->out, "Signals: %ld\n", mon->signals);
        if (mon->timed > 0)
            fprintf(mon->out, "Average duration: %.1f ms\n", average_ms);
        else
            fputs("Average duration: n/a\n", mon->out);
    }
    fflush(mon->out);
}
