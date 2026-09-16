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
            "       caps                           (interactive mode, later phase)\n");
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

    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("Command Argument Passing System %s\n", CAPS_VERSION);
        return 0;
    }

    if (argc < 2) {
        usage(stderr);
        return EXIT_FAILURE;
    }

    return process_exec(&argv[1]);
}