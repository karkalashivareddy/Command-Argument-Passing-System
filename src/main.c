#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "parser.h"
#include "process.h"

#define CAPS_VERSION "0.1.0"

static void usage(FILE *stream)
{
    fprintf(stream,
            "Usage: caps --parse <line>            (show argv for debugging)\n"
            "       caps <command> [argument ...]  (execute a command once)\n"
            "       caps                           (interactive mode)\n");
}

static void parse_and_print(const char *line)
{
    char **argv = NULL;
    int argc = 0;

    if (parser_parse(line, &argv, &argc) < 0) {
        fprintf(stderr, "caps: memory allocation failure\n");
        return;
    }

    printf("argc = %d\n", argc);
    for (int i = 0; i <= argc; i++)
        printf("argv[%d] = %s\n", i, argv[i] ? argv[i] : "(null)");

    parser_free_argv(argv);
}

static int run_builtin(int argc, char **argv, int *exit_flag, int *status)
{
    if (strcmp(argv[0], "exit") == 0) {
        *exit_flag = 1;
        *status = (argc >= 2) ? atoi(argv[1]) : 0;
        return 1;
    }

    if (strcmp(argv[0], "help") == 0) {
        fprintf(stderr,
                "Built-in commands:\n"
                "  help   show this message\n"
                "  exit   exit the shell (exit [N])\n");
        fprintf(stderr,
                "\nExternal commands are executed via fork() + execvp().\n"
                "Type any external command name followed by its arguments.\n");
        *status = 0;
        return 1;
    }

    return 0;
}

static int interactive_loop(void)
{
    fprintf(stderr,
            "Command Argument Passing System %s\n"
            "Type 'help' for available commands.\n\n",
            CAPS_VERSION);

    char *line = NULL;
    size_t len = 0;
    int status = 0;

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
            fprintf(stderr, "caps: memory allocation failure\n");
            continue;
        }
        if (argc == 0) {
            parser_free_argv(argv);
            continue;
        }

        int exit_flag = 0;
        int is_builtin = run_builtin(argc, argv, &exit_flag, &status);
        if (exit_flag) {
            parser_free_argv(argv);
            break;
        }
        if (!is_builtin)
            status = process_exec(argv);

        parser_free_argv(argv);
    }

    free(line);
    return status;
}

int main(int argc, char *argv[])
{
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

    if (argc >= 2) {
        return process_exec(&argv[1]);
    }

    return interactive_loop();
}