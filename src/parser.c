#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include "parser.h"

static const char *skip_ws(const char *p)
{
    while (*p && isspace((unsigned char)*p))
        p++;
    return p;
}

static int count_tokens(const char *line)
{
    int count = 0;

    while (*line) {
        line = skip_ws(line);
        if (*line == '\0')
            break;
        count++;
        while (*line && !isspace((unsigned char)*line))
            line++;
    }
    return count;
}

int parser_parse(const char *line, char ***out_argv, int *out_argc)
{
    if (line == NULL)
        line = "";

    int n = count_tokens(line);

    char **argv = calloc((size_t)(n + 1), sizeof(char *));
    if (argv == NULL)
        return -1;

    const char *p = line;

    for (int i = 0; i < n; i++) {
        p = skip_ws(p);
        const char *start = p;
        while (*p && !isspace((unsigned char)*p))
            p++;
        size_t len = (size_t)(p - start);

        argv[i] = malloc(len + 1);
        if (argv[i] == NULL) {
            for (int j = 0; j < i; j++)
                free(argv[j]);
            free(argv);
            return -1;
        }
        memcpy(argv[i], start, len);
        argv[i][len] = '\0';
    }

    argv[n] = NULL;
    *out_argv = argv;
    *out_argc = n;
    return 0;
}

void parser_free_argv(char **argv)
{
    if (argv == NULL)
        return;
    for (int i = 0; argv[i] != NULL; i++)
        free(argv[i]);
    free(argv);
}