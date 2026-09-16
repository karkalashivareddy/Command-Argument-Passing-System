#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "builtin.h"
#include "parser.h"
#include "process.h"
#include "signals.h"
#include "utils.h"

#define CAPS_VERSION "0.1.0"

static void usage(FILE *stream)
{
    fprintf(stream,
            "Usage: caps                            (interactive mode)\n"
            "       caps <command> [argument ...]  (execute a command once)\n"
            "       caps --parse <line>            (show argv for debugging)\n"
            "       caps --help | --version\n");
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

static int interactive_loop(void)
{
    fprintf(stderr,
            "Command Argument Passing System %s\n"
            "Type 'help' for available commands.\n\n",
            CAPS_VERSION);

    char *line = NULL;
    size_t len = 0;
    int last_status = 0;

    for (;;) {
        fprintf(stderr, "caps> ");

        ssize_t nread = getline(&line, &len, stdin);
        if (nread < 0) {
            fprintf(stderr, "\n");
            break;
        }
        if (nread > 0 && line[nread - 1] == '\n')
            line[nread - 1] = '\0';

        char **argv = NULL;
        int argc = 0;
        if (parser_parse(line, &argv, &argc) < 0) {
            caps_error("memory allocation failure");
            continue;
        }
        if (argc == 0) {
            parser_free_argv(argv);
            continue;
        }

        redirection_t *redirs = NULL;
        int nredirs = 0;
        if (parser_split_redirections(argv, &argc, &redirs, &nredirs) < 0) {
            parser_free_argv(argv);
            continue;
        }
        if (argc == 0) {
            caps_error("syntax error: no command to redirect");
            parser_free_argv(argv);
            parser_free_redirections(redirs, nredirs);
            continue;
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
            status = process_exec(argv, redirs, nredirs, &raw_status);
            process_report_status(argv[0], raw_status);
        }

        last_status = status;
        parser_free_argv(argv);
        parser_free_redirections(redirs, nredirs);
    }

    free(line);
    return last_status;
}

int main(int argc, char *argv[])
{
    signals_parent_init();

    if (argc == 2 && strcmp(argv[1], "--parse") == 0) {
        fprintf(stderr, "Command Argument Passing System %s (--parse mode)\n",
                CAPS_VERSION);
        fprintf(stderr, "Enter a command line: ");
        char *line = NULL;
        size_t len = 0;
        ssize_t nread = getline(&line, &len, stdin);
        if (nread < 0) {
            free(line);
            return 0;
        }
        if (nread > 0 && line[nread - 1] == '\n')
            line[nread - 1] = '\0';
        parse_and_print(line);
        free(line);
        return 0;
    }

    if (argc == 2 && strcmp(argv[1], "--help") == 0) {
        usage(stderr);
        return 0;
    }

    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("Command Argument Passing System %s\n", CAPS_VERSION);
        return 0;
    }

    if (argc >= 2)
        return process_exec(&argv[1], NULL, 0, NULL);

    return interactive_loop();
}