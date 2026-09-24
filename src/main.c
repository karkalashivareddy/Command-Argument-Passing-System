#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "builtin.h"
#include "monitor.h"
#include "parser.h"
#include "process.h"
#include "signals.h"
#include "utils.h"

#define CAPS_VERSION "0.1.0"

static void usage(FILE *stream)
{
    fprintf(stream,
            "Usage: caps                                    (interactive mode)\n"
            "       caps <command> [argument ...]           (execute a command once)\n"
            "       caps --parse                            (read one line from stdin,\n"
            "                                                  show the parsed argv)\n"
            "       caps --monitor [--json]                 (interactive mode showing\n"
            "                                                  live execution events)\n"
            "       caps --monitor [--json] <command> ...   (one-shot with live events)\n"
            "       caps --monitor --json [--redir-in F]    (one-shot with I/O redirection;\n"
            "                       [--redir-out F]          uses the same open()/dup2()/\n"
            "                       [--redir-append F]       close() path as the REPL)\n"
            "       caps --help | --version\n");
}

static void emit_simple_event(caps_monitor_t *mon, caps_event_type_t type,
                              const char *command)
{
    caps_event_t ev;

    if (mon == NULL)
        return;

    memset(&ev, 0, sizeof ev);
    ev.type = type;
    ev.command = command;
    caps_monitor_emit(mon, &ev);
}

static char *read_line(char **line, size_t *len, int *nread_out)
{
    ssize_t nread = getline(line, len, stdin);

    if (nread < 0) {
        *nread_out = -1;
        return NULL;
    }
    if (nread > 0 && (*line)[nread - 1] == '\n')
        (*line)[nread - 1] = '\0';
    *nread_out = (int)nread;
    return *line;
}

static void parse_and_print(const char *line)
{
    char **argv = NULL;
    int argc = 0;

    if (parser_parse(line, &argv, &argc) < 0) {
        caps_error("memory allocation failure");
        return;
    }

    printf("argc = %d\n", argc);
    for (int i = 0; i <= argc; i++)
        printf("argv[%d] = %s\n", i, argv[i] ? argv[i] : "(null)");

    parser_free_argv(argv);
}

/*
 * Interactive REPL.  When mon != NULL the observed command lifecycle is
 * emitted as it happens; quiet_ui suppresses the banner and prompt so a
 * JSON monitor's stderr stream stays one JSON object per line.
 */
static int interactive_loop(caps_monitor_t *mon, int quiet_ui)
{
    if (!quiet_ui) {
        fprintf(stderr,
                "Command Argument Passing System %s\n"
                "Type 'help' for available commands.\n\n",
                CAPS_VERSION);
    }

    char *line = NULL;
    size_t len = 0;
    int last_status = 0;

    for (;;) {
        if (!quiet_ui)
            fprintf(stderr, "caps> ");

        int nread = 0;
        char *raw = read_line(&line, &len, &nread);
        if (nread < 0) {
            if (!quiet_ui)
                fprintf(stderr, "\n");
            break;
        }
        if (raw[0] == '\0')
            continue;

        emit_simple_event(mon, CAPS_EVENT_COMMAND_RECEIVED, raw);

        char **argv = NULL;
        int argc = 0;
        if (parser_parse(raw, &argv, &argc) < 0) {
            caps_error("memory allocation failure");
            emit_simple_event(mon, CAPS_EVENT_COMMAND_PARSE_ERROR, raw);
            continue;
        }
        if (argc == 0) {
            parser_free_argv(argv);
            continue;
        }

        redirection_t *redirs = NULL;
        int nredirs = 0;
        if (parser_split_redirections(argv, &argc, &redirs, &nredirs) < 0) {
            emit_simple_event(mon, CAPS_EVENT_COMMAND_PARSE_ERROR, raw);
            parser_free_argv(argv);
            continue;
        }
        if (argc == 0) {
            caps_error("syntax error: no command to redirect");
            emit_simple_event(mon, CAPS_EVENT_COMMAND_PARSE_ERROR, raw);
            parser_free_argv(argv);
            parser_free_redirections(redirs, nredirs);
            continue;
        }

        {
            char joined[256];
            caps_join_argv(argv, joined, sizeof joined);
            emit_simple_event(mon, CAPS_EVENT_PARSED, joined);
        }

        int status = 0;
        builtin_result_t res = builtin_run(argc, argv, last_status, &status);
        if (res == CAPS_BUILTIN_EXIT) {
            last_status = status;
            parser_free_argv(argv);
            parser_free_redirections(redirs, nredirs);
            break;
        }
        if (res == CAPS_BUILTIN_HANDLED && nredirs > 0) {
            caps_error("redirection is not supported for built-in commands");
            status = 1;
        }
        if (res == CAPS_NOT_BUILTIN) {
            int raw_status = 0;
            status = process_exec(argv, redirs, nredirs, &raw_status, mon);
            process_report_status(argv[0], raw_status);
        }

        last_status = status;
        parser_free_argv(argv);
        parser_free_redirections(redirs, nredirs);
    }

    free(line);
    if (mon != NULL)
        caps_monitor_finish(mon);
    return last_status;
}

/*
 * One-shot execution under a monitor: emit the received/parsed events,
 * run the command (optionally with redirection descriptors that follow
 * the exact same open()/dup2()/close() path the REPL uses), then close
 * the session with a summary.  The redirection paths are borrowed from
 * argv and stay valid for the whole run.
 */
static int monitor_one_shot(caps_monitor_t *mon, char *const cmd_argv[],
                            redirection_t *redirs, int nredirs)
{
    char joined[256];

    caps_join_argv(cmd_argv, joined, sizeof joined);
    emit_simple_event(mon, CAPS_EVENT_COMMAND_RECEIVED, joined);
    emit_simple_event(mon, CAPS_EVENT_PARSED, joined);

    int status = process_exec(cmd_argv, redirs, nredirs, NULL, mon);

    caps_monitor_finish(mon);
    return status;
}

static int parse_debug_mode(void)
{
    fprintf(stderr, "Command Argument Passing System %s (--parse mode)\n",
            CAPS_VERSION);
    fprintf(stderr, "Enter a command line: ");

    char *line = NULL;
    size_t len = 0;
    int nread = 0;

    if (read_line(&line, &len, &nread) == NULL) {
        free(line);
        return 0;
    }
    if (nread < 0) {
        free(line);
        return 0;
    }

    parse_and_print(line);
    free(line);
    return 0;
}

int main(int argc, char *argv[])
{
    /*
     * signals_parent_init() reports its own sigaction() failure.  The
     * shell then continues in the documented degraded mode (Ctrl+C may
     * also terminate the parent while a child runs), so the return value
     * is intentionally not acted on and the failure is not re-reported.
     */
    (void)signals_parent_init();

    if (argc == 2 && strcmp(argv[1], "--parse") == 0)
        return parse_debug_mode();

    if (argc == 2 && strcmp(argv[1], "--help") == 0) {
        usage(stderr);
        return 0;
    }

    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("Command Argument Passing System %s\n", CAPS_VERSION);
        return 0;
    }

    /* caps --monitor [--json] [<command> [argument ...]] */
    int i = 1;
    int monitor = 0;
    int json = 0;

    if (argc > i && strcmp(argv[i], "--monitor") == 0) {
        monitor = 1;
        i++;
        if (argc > i && strcmp(argv[i], "--json") == 0) {
            json = 1;
            i++;
        }
    }

    if (monitor) {
        caps_monitor_t *mon = caps_monitor_create(stderr, json);
        int rc;
        redirection_t *redirs = NULL;
        int nredirs = 0;
        const int max_redirs = 3;

        if (mon == NULL) {
            /*
             * The user explicitly asked for monitoring; running without
             * it would silently ignore the requested mode.  Fail startup
             * instead of continuing as a normal shell.
             */
            caps_error("monitor setup failed");
            return EXIT_FAILURE;
        }

        /*
         * Optional one-shot redirection descriptors:
         *   caps --monitor --json [--redir-in F] [--redir-out F]
         *                          [--redir-append F] <command> [arg ...]
         * Each flag consumes its file-name argument and records a
         * descriptor that process_exec() opens before fork() and the
         * child dup2()s onto stdin/stdout before execvp().  This is the
         * same execution path as REPL redirection, exposed for the web
         * gateway; it never activates outside --monitor.
         */
        while (i + 1 < argc && nredirs < max_redirs) {
            caps_redir_type_t type;

            if (strcmp(argv[i], "--redir-in") == 0)
                type = CAPS_REDIR_IN;
            else if (strcmp(argv[i], "--redir-out") == 0)
                type = CAPS_REDIR_OUT;
            else if (strcmp(argv[i], "--redir-append") == 0)
                type = CAPS_REDIR_APPEND;
            else
                break;

            if (redirs == NULL) {
                redirs = calloc((size_t)max_redirs, sizeof *redirs);
                if (redirs == NULL) {
                    caps_error("memory allocation failure");
                    caps_monitor_destroy(mon);
                    return EXIT_FAILURE;
                }
            }
            redirs[nredirs].type = type;
            redirs[nredirs].path = argv[i + 1]; /* borrowed; lives for the run */
            redirs[nredirs].fd = -1;
            i += 2;
            nredirs++;
        }

        if (i < argc)
            rc = monitor_one_shot(mon, &argv[i], redirs, nredirs);
        else
            rc = interactive_loop(mon, json);

        free(redirs);
        caps_monitor_destroy(mon);
        return rc;
    }

    if (argc >= 2)
        return process_exec(&argv[1], NULL, 0, NULL, NULL);

    return interactive_loop(NULL, 0);
}
