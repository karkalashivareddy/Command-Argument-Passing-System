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

/*
 * Product version.
 *
 * CAPS_VERSION used to be a literal in this file that said 0.1.0 while the
 * gateway and both npm packages said 1.0.0, so `caps --version` and the
 * running service reported different products. The value is now generated
 * from the single canonical source (web/backend/src/config/env.ts) by the
 * Makefile and compared against the gateway's version in CI
 * (scripts/check-lockfiles.sh).
 */
#include "version.h"

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

        /*
         * Tokenize before announcing anything.  Emitting COMMAND_RECEIVED
         * for a blank or whitespace-only line would put an event in the
         * canonical stream that no later event ever resolves, breaking the
         * "every event participates in the lifecycle" invariant.
         */
        char **argv = NULL;
        int argc = 0;
        /*
         * The REPL tokenizes with the full lexer, not the legacy
         * whitespace splitter, so that quoting and escapes work and so that a
         * '|' inside a quoted argument stays data instead of splitting the
         * line.  The pipeline is then built from the token stream by
         * parser_parse_pipeline(), which is the only place a command line is
         * interpreted.
         */
        if (parser_tokenize(raw, &argv, &argc) < 0) {
            if (argc < 0) {
                caps_error("memory allocation failure");
            } else {
                caps_error("syntax error: %s", parser_last_error());
            }
            emit_simple_event(mon, CAPS_EVENT_COMMAND_PARSE_ERROR, raw);
            continue;
        }
        if (argc == 0) {
            parser_free_argv(argv);
            continue;
        }

        emit_simple_event(mon, CAPS_EVENT_COMMAND_RECEIVED, raw);

        /*
         * Built-in commands (`exit`, `help`, `cd`, ...) are handled in-process
         * and never reach fork().  The test is on argv[0] alone, not on the
         * argument count: `exit 42` is the built-in with an argument, and
         * routing it to execvp() would look for a program called "exit" and
         * report 127 for what is really a successful `exit 42`.
         */
        if (builtin_is_builtin(argv[0])) {
            redirection_t *bredirs = NULL;
            int bargc = argc;
            int bnredirs = 0;
            int split_rc = parser_split_redirections(argv, &bargc, &bredirs,
                                                     &bnredirs);
            if (split_rc < 0) {
                caps_error("syntax error: %s", parser_last_error());
                emit_simple_event(mon, CAPS_EVENT_COMMAND_PARSE_ERROR, raw);
                parser_free_argv(argv);
                continue;
            }
            {
                char joined[256];
                caps_join_argv(argv, joined, sizeof joined);
                emit_simple_event(mon, CAPS_EVENT_PARSED, joined);
            }
            int bstatus = 0;
            builtin_result_t res = builtin_run(bargc, argv, last_status, &bstatus);
            if (res == CAPS_BUILTIN_EXIT) {
                parser_free_argv(argv);
                parser_free_redirections(bredirs, bnredirs);
                last_status = bstatus;
                break;
            }
            if (bnredirs > 0) {
                caps_error("redirection is not supported for built-in commands");
                bstatus = 1;
            }
            last_status = bstatus;
            parser_free_argv(argv);
            parser_free_redirections(bredirs, bnredirs);
            continue;
        }

        caps_pipeline_t pipeline;
        int prc = parser_parse_pipeline(raw, &pipeline);
        parser_free_argv(argv);
        if (prc != 0) {
            caps_error("syntax error: %s", parser_last_error());
            emit_simple_event(mon, CAPS_EVENT_COMMAND_PARSE_ERROR, raw);
            continue;
        }

        {
            char joined[256];
            caps_join_argv(pipeline.stages[0].argv, joined, sizeof joined);
            emit_simple_event(mon, CAPS_EVENT_PARSED, joined);
        }
        if (pipeline.count > 1) {
            caps_event_t pev;
            char label[128];
            memset(&pev, 0, sizeof pev);
            pev.type = CAPS_EVENT_PIPELINE_PARSED;
            pev.stage_count = pipeline.count;
            pev.stage_index = -1;
            pev.command = pipeline.stages[0].argv[0];
            snprintf(label, sizeof label, "%d stages", pipeline.count);
            pev.message = label;
            caps_monitor_emit(mon, &pev);
        }

        int status = 0;
        int raw_status = 0;
        status = process_exec_pipeline(&pipeline, &raw_status, mon);
        if (pipeline.count > 0 && pipeline.stages[0].argv != NULL)
            process_report_status(pipeline.stages[0].argv[0], raw_status);

        last_status = status;
        parser_free_pipeline(&pipeline);
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

/*
 * Lex a command line and print the pipeline that WOULD be executed, without
 * executing anything.
 *
 * WHY THIS EXISTS
 * ---------------
 * The gateway must validate every command in a line against its catalog before
 * anything runs.  If the gateway parsed the line itself, there would be two
 * lexers, and they would eventually disagree about a quoting edge case -- at
 * which point the gateway could approve a command the engine then executes,
 * which is precisely the failure the catalog exists to prevent.
 *
 * So the engine is the only lexer, and the gateway asks it what the argv
 * vectors are.  The output is one JSON object describing every stage, and the
 * validation is applied to exactly the argv that will later be exec'd.
 *
 * Usage: caps --inspect "<command line>"
 * Output: one JSON object on stdout, exit 0 on a parseable line, 2 on a
 *         syntax error (with the reason on stderr), 1 on an internal failure.
 */
static int inspect_line_mode(const char *line)
{
    caps_pipeline_t pipeline;
    int rc = parser_parse_pipeline(line, &pipeline);

    if (rc != 0) {
        fprintf(stderr, "%s\n", parser_last_error());
        parser_free_pipeline(&pipeline);
        return 2;
    }

    printf("{\"stages\":%d,\"pipeline\":[", pipeline.count);
    for (int i = 0; i < pipeline.count; i++) {
        caps_stage_t *s = &pipeline.stages[i];
        if (i > 0)
            printf(",");
        printf("{\"index\":%d,\"argv\":[", i);
        for (int k = 0; k < s->argc; k++) {
            if (k > 0)
                printf(",");
            /*
             * The surrounding double quotes are part of the JSON syntax and are
             * emitted here; caps_json_escape() escapes only the *contents*.
             * Emitting the escaped text without the quotes produces
             * `"argv":[seq,1,5]`, which is not JSON at all -- and it fails
             * silently enough that the values look correct in a casual read.
             * A caller parsing this output would reject the whole document
             * and conclude the command line was malformed.
             */
            fputc('"', stdout);
            caps_json_escape(stdout, s->argv[k]);
            fputc('"', stdout);
        }
        printf("],\"redirections\":[");
        for (int r = 0; r < s->nredirs; r++) {
            if (r > 0)
                printf(",");
            const char *op;
            switch (s->redirs[r].type) {
            case CAPS_REDIR_IN:         op = "<";   break;
            case CAPS_REDIR_OUT:        op = ">";   break;
            case CAPS_REDIR_APPEND:     op = ">>";  break;
            case CAPS_REDIR_ERR_OUT:    op = "2>";  break;
            default:                    op = "2>>"; break;
            }
            printf("{\"op\":\"%s\",\"fd\":%d,\"target\":", op,
                   s->redirs[r].target_fd);
            /* Quoted for the same reason argv is: the surrounding quotes are
             * JSON syntax, and caps_json_escape() escapes only the contents. */
            fputc('"', stdout);
            caps_json_escape(stdout, s->redirs[r].path);
            fputc('"', stdout);
            printf("}");
        }
        printf("],\"stdin_source\":\"%s\",\"stdout_dest\":\"%s\"}",
               s->stdin_source, s->stdout_dest);
    }
    printf("]}\n");
    parser_free_pipeline(&pipeline);
    return 0;
}

/*
 * Execute a command line as a pipeline, under the monitor.
 *
 * Usage: caps --run-line [--json] "<command line>"
 *
 * The line is lexed and split here, so the argv each stage receives is the
 * argv this process built -- not something the caller supplied pre-split.  A
 * caller that wanted a different argv would have to lie about the line, and
 * then the recorded evidence would not match what ran.
 */
static int run_line_mode(caps_monitor_t *mon, const char *line)
{
    caps_pipeline_t pipeline;
    int rc = parser_parse_pipeline(line, &pipeline);

    if (rc != 0) {
        caps_error("syntax error: %s", parser_last_error());
        emit_simple_event(mon, CAPS_EVENT_COMMAND_PARSE_ERROR, line);
        parser_free_pipeline(&pipeline);
        return 2;
    }

    emit_simple_event(mon, CAPS_EVENT_COMMAND_RECEIVED, line);
    {
        char joined[256];
        caps_join_argv(pipeline.stages[0].argv, joined, sizeof joined);
        emit_simple_event(mon, CAPS_EVENT_PARSED, joined);
    }
    if (pipeline.count > 1) {
        caps_event_t pev;
        char label[64];
        memset(&pev, 0, sizeof pev);
        pev.type = CAPS_EVENT_PIPELINE_PARSED;
        pev.stage_count = pipeline.count;
        pev.stage_index = -1;
        pev.command = pipeline.stages[0].argv[0];
        snprintf(label, sizeof label, "%d stages", pipeline.count);
        pev.message = label;
        caps_monitor_emit(mon, &pev);
    }

    int raw_status = 0;
    int status = process_exec_pipeline(&pipeline, &raw_status, mon);
    if (pipeline.count > 0 && pipeline.stages[0].argv != NULL)
        process_report_status(pipeline.stages[0].argv[0], raw_status);
    parser_free_pipeline(&pipeline);
    return status;
}

int main(int argc, char *argv[])
{
    /*
     * Fail closed on the signal model.  If SIGINT cannot be set to SIG_IGN
     * here, Ctrl+C would also terminate caps while a child is running, and the
     * documented guarantee ("the REPL survives Ctrl+C") would be false while
     * the process kept behaving as if it were true.  A shell that quietly runs
     * with the wrong signal semantics is worse than one that refuses to start,
     * so this is fatal and the reason is printed.
     */
    if (signals_parent_init() != 0) {
        caps_error("cannot initialise the signal model; refusing to start");
        return EXIT_FAILURE;
    }

    if (argc == 2 && strcmp(argv[1], "--parse") == 0)
        return parse_debug_mode();

    /*
     * caps --inspect "<line>": report the pipeline, execute nothing.  Handled
     * before the monitor flags because it has no monitor and its output is the
     * whole point.
     */
    if (argc == 3 && strcmp(argv[1], "--inspect") == 0)
        return inspect_line_mode(argv[2]);

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

    /* caps --run-line [--json] "<line>" */
    int run_line = 0;
    if (argc > i && strcmp(argv[i], "--run-line") == 0) {
        run_line = 1;
        i++;
        if (argc > i && strcmp(argv[i], "--json") == 0) {
            json = 1;
            i++;
        }
    }

    if (run_line) {
        caps_monitor_t *mon = caps_monitor_create(stderr, json);
        if (mon == NULL) {
            caps_error("monitor setup failed");
            return EXIT_FAILURE;
        }
        if (i >= argc) {
            caps_error("--run-line requires a command line argument");
            caps_monitor_destroy(mon);
            return EXIT_FAILURE;
        }
        int rc = run_line_mode(mon, argv[i]);
        caps_monitor_finish(mon);
        caps_monitor_destroy(mon);
        return rc;
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
            /*
             * target_fd MUST be set here.  apply_redirections() reads the
             * destination from this field rather than inferring it from
             * `type`, and a redirection_t built without it defaults to 0 --
             * so `--redir-out file` would dup2() the file onto STDIN and the
             * program's output would go to the parent's stdout instead of the
             * file.  That regression is silent: the session reports COMPLETED
             * with the right exit code and the file is simply empty, so only a
             * test that checks the FILE's contents can see it.
             */
            redirs[nredirs].type = type;
            redirs[nredirs].path = argv[i + 1]; /* borrowed; lives for the run */
            redirs[nredirs].fd = -1;
            redirs[nredirs].target_fd = caps_redir_fd(type);
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
