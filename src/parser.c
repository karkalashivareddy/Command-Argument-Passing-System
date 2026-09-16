#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include "parser.h"
#include "utils.h"

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

static caps_redir_type_t redir_type_of(const char *token)
{
    if (strcmp(token, ">") == 0)
        return CAPS_REDIR_OUT;
    if (strcmp(token, ">>") == 0)
        return CAPS_REDIR_APPEND;
    return CAPS_REDIR_IN; /* "<" */
}

static int is_redir_op(const char *token)
{
    return strcmp(token, "<") == 0 ||
           strcmp(token, ">") == 0 ||
           strcmp(token, ">>") == 0;
}

int parser_split_redirections(char **argv, int *argc,
                              redirection_t **out_redirs, int *out_n)
{
    int i, j, n_ops = 0;

    for (i = 0; i < *argc; i++) {
        if (!is_redir_op(argv[i]))
            continue;
        n_ops++;
        if (i + 1 >= *argc) {
            caps_error("syntax error: '%s' requires a file name", argv[i]);
            *out_redirs = NULL;
            *out_n = 0;
            return -2;
        }
    }

    if (n_ops == 0) {
        *out_redirs = NULL;
        *out_n = 0;
        return 0;
    }

    redirection_t *redirs = calloc((size_t)n_ops, sizeof *redirs);
    if (redirs == NULL) {
        *out_redirs = NULL;
        *out_n = 0;
        return -1;
    }

    j = 0;
    int r = 0;
    for (i = 0; i < *argc; i++) {
        if (is_redir_op(argv[i])) {
            redirs[r].type = redir_type_of(argv[i]);
            redirs[r].path = argv[i + 1]; /* ownership transfer */
            free(argv[i]);
            i++; /* skip the consumed file token */
            r++;
        } else {
            argv[j++] = argv[i];
        }
    }

    argv[j] = NULL;
    *argc = j;
    *out_redirs = redirs;
    *out_n = r;
    return 0;
}

void parser_free_redirections(redirection_t *redirs, int n)
{
    if (redirs == NULL)
        return;
    for (int i = 0; i < n; i++)
        free(redirs[i].path);
    free(redirs);
}