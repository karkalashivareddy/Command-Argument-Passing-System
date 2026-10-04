#include <ctype.h>
#include <stdarg.h>
#include <stdio.h>
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
    if (strcmp(token, "<") == 0)   return CAPS_REDIR_IN;
    if (strcmp(token, ">") == 0)   return CAPS_REDIR_OUT;
    if (strcmp(token, ">>") == 0)  return CAPS_REDIR_APPEND;
    if (strcmp(token, "2>") == 0)  return CAPS_REDIR_ERR_OUT;
    return CAPS_REDIR_ERR_APPEND;  /* "2>>" */
}

static int is_redir_op(const char *token)
{
    return strcmp(token, "<") == 0 ||
           strcmp(token, ">") == 0 ||
           strcmp(token, ">>") == 0 ||
           strcmp(token, "2>") == 0 ||
           strcmp(token, "2>>") == 0;
}

int parser_split_redirections(char **argv, int *argc,
                              redirection_t **out_redirs, int *out_n)
{
    int i, j, n_ops = 0;

    /*
     * Validation pass.  Two independent conditions must hold for every
     * operator, and both are checked here, before any mutation, so a rejected
     * line leaves the caller's argv byte-for-byte unchanged:
     *
     *   1. a file token must follow the operator;
     *   2. that file token must not itself be a redirection operator.
     *
     * Condition 2 is what stops `echo hi > > out.txt` from silently creating
     * a file literally named ">" while "out.txt" is demoted to an argument.
     * CAPS is not a shell, so an operator is never a file name.
     */
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
        if (is_redir_op(argv[i + 1])) {
            caps_error("syntax error: '%s' requires a file name, but '%s' is "
                       "another redirection operator",
                       argv[i], argv[i + 1]);
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
            /*
             * Record which descriptor this redirection replaces while the type
             * is still in hand.  Deriving it later from `type` would spread the
             * fd mapping across two files, and a new type would silently
             * default to stdout.
             */
            redirs[r].target_fd = caps_redir_fd(redirs[r].type);
            redirs[r].fd = -1;
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

/* ================================================================== lexer
 *
 * One lexer, one grammar.  Everything downstream consumes its output rather
 * than re-reading the raw string, so the browser, the gateway, and the engine
 * cannot disagree about what a command line means.
 */

static char g_error[256] = "";

const char *parser_last_error(void)
{
    return g_error[0] != '\0' ? g_error : "no parse error recorded";
}

static void set_error(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_error, sizeof g_error, fmt, ap);
    va_end(ap);
}

/* A growable byte buffer used to accumulate one token. */
typedef struct {
    char *data;
    size_t len;
    size_t cap;
} bytebuf_t;

static int bb_reserve(bytebuf_t *bb, size_t extra)
{
    size_t needed = bb->len + extra + 1; /* room for the NUL terminator */
    if (bb->len + extra > CAPS_MAX_TOKEN) {
        /*
         * Refuse to grow past the token ceiling.  Checking here rather than
         * after the fact means a hostile 100 MB "token" costs bounded memory
         * instead of bounded memory *eventually*.
         */
        return -1;
    }
    if (needed <= bb->cap)
        return 0;

    /*
     * Grow by doubling, but never past what is actually needed.  A pure
     * doubling cap would reject a legal 20000-byte token, because the next
     * power of two above it is 32768 and the naive "is the doubled size over
     * the limit" test then refuses a token that is under the limit.  Taking
     * min(doubled, needed) keeps amortised growth while honouring the exact
     * documented ceiling.
     */
    size_t cap = bb->cap == 0 ? 64 : bb->cap;
    while (cap < needed)
        cap = cap * 2 > needed ? needed : cap * 2;

    char *next = realloc(bb->data, cap);
    if (next == NULL)
        return -1;
    bb->data = next;
    bb->cap = cap;
    return 0;
}

static int bb_push(bytebuf_t *bb, char c)
{
    if (bb_reserve(bb, 1) != 0)
        return -1;
    bb->data[bb->len++] = c;
    bb->data[bb->len] = '\0';
    return 0;
}

static void bb_free(bytebuf_t *bb)
{
    free(bb->data);
    bb->data = NULL;
    bb->len = 0;
    bb->cap = 0;
}

/* Append a literal byte, honouring the token ceiling. */
static int bb_push_lit(bytebuf_t *bb, char c)
{
    if (bb->len >= CAPS_MAX_TOKEN) {
        set_error("token exceeds the %d byte limit", CAPS_MAX_TOKEN);
        return -1;
    }
    return bb_push(bb, c);
}

int parser_tokenize(const char *line, char ***out_argv, int *out_argc)
{
    g_error[0] = '\0';

    if (line == NULL) {
        *out_argv = NULL;
        *out_argc = 0;
        return -2;
    }
    size_t line_len = strlen(line);
    if (line_len > CAPS_MAX_LINE) {
        set_error("command line is %zu bytes, over the %d byte limit",
                  line_len, CAPS_MAX_LINE);
        return -2;
    }

    int cap = 8;
    int count = 0;
    char **argv = calloc((size_t)cap + 1, sizeof *argv);
    if (argv == NULL)
        return -1;

    bytebuf_t bb = { NULL, 0, 0 };
    const char *p = line;
    int have_token = 0;   /* is bb holding a token in progress? */

    while (*p != '\0') {
        /* Whitespace separates tokens and is otherwise discarded. */
        if (isspace((unsigned char)*p)) {
            p++;
            continue;
        }

        /*
         * A '#' that begins a token starts a comment to end of line.  A '#'
         * that is not at the start of a token is ordinary data, which is why
         * `echo a#b` prints "a#b" and `echo a #b` prints "a".
         */
        if (*p == '#' && !have_token) {
            break;
        }

        if (count >= CAPS_MAX_ARGS) {
            set_error("more than %d arguments", CAPS_MAX_ARGS);
            goto fail_syntax;
        }

        if (!have_token) {
            have_token = 1;
        }

        if (*p == '\'') {
            p++;
            int closed = 0;
            while (*p != '\0') {
                if (*p == '\'') {
                    p++;
                    closed = 1;
                    break;
                }
                if (bb_push_lit(&bb, *p) != 0)
                    goto fail_syntax;
                p++;
            }
            if (!closed) {
                set_error("unterminated single quote");
                goto fail_syntax;
            }
        } else if (*p == '"') {
            p++;
            int closed = 0;
            while (*p != '\0') {
                if (*p == '"') {
                    p++;
                    closed = 1;
                    break;
                }
                if (*p == '\\') {
                    char next = p[1];
                    /*
                     * Inside double quotes POSIX gives backslash meaning only
                     * before these five.  Before anything else it is ordinary
                     * data, so "\d" stays "\d" rather than becoming "d".
                     */
                    if (next == '"' || next == '\\' || next == '$' ||
                        next == '`' || next == '\n') {
                        if (next == '\n') {
                            /* line continuation: the newline disappears */
                            p += 2;
                            continue;
                        }
                        if (bb_push_lit(&bb, next) != 0)
                            goto fail_syntax;
                        p += 2;
                        continue;
                    }
                }
                if (bb_push_lit(&bb, *p) != 0)
                    goto fail_syntax;
                p++;
            }
            if (!closed) {
                set_error("unterminated double quote");
                goto fail_syntax;
            }
        } else if (*p == '\\') {
            char next = p[1];
            if (next == '\0') {
                set_error("trailing backslash at end of line");
                goto fail_syntax;
            }
            if (bb_push_lit(&bb, next) != 0)
                goto fail_syntax;
            p += 2;
        } else {
            if (bb_push_lit(&bb, *p) != 0)
                goto fail_syntax;
            p++;
        }

        /*
         * A token ends when the buffer is non-empty and the next byte is
         * whitespace or the end of the line.  Checking here rather than in an
         * outer loop is what makes an empty quoted string ("" or '') a real
         * argument instead of a silently dropped one.
         */
        if (bb.len > 0 && (*p == '\0' || isspace((unsigned char)*p))) {
            if (bb.data == NULL) {
                /* An explicitly empty token: allocate a 1-byte empty string. */
                bb.data = calloc(1, 1);
                if (bb.data == NULL)
                    goto fail_alloc;
            }
            if (count + 1 >= cap) {
                int next_cap = cap * 2;
                char **grown = realloc(argv, (size_t)(next_cap + 1) * sizeof *argv);
                if (grown == NULL)
                    goto fail_alloc;
                argv = grown;
                cap = next_cap;
            }
            argv[count++] = bb.data;
            bb.data = NULL;
            bb.len = 0;
            bb.cap = 0;
            have_token = 0;
        }
    }

    /* A token that ran to the end of the line without trailing whitespace. */
    if (have_token) {
        if (bb.data == NULL) {
            bb.data = calloc(1, 1);
            if (bb.data == NULL)
                goto fail_alloc;
        }
        if (count + 1 >= cap) {
            int next_cap = cap * 2;
            char **grown = realloc(argv, (size_t)(next_cap + 1) * sizeof *argv);
            if (grown == NULL)
                goto fail_alloc;
            argv = grown;
            cap = next_cap;
        }
        argv[count++] = bb.data;
        bb.data = NULL;
        bb.len = 0;
        bb.cap = 0;
    }

    bb_free(&bb);
    argv[count] = NULL;
    *out_argv = argv;
    *out_argc = count;
    return 0;

fail_syntax:
    bb_free(&bb);
    for (int i = 0; i < count; i++)
        free(argv[i]);
    free(argv);
    *out_argv = NULL;
    *out_argc = 0;
    return -2;

fail_alloc:
    bb_free(&bb);
    for (int i = 0; i < count; i++)
        free(argv[i]);
    free(argv);
    *out_argv = NULL;
    *out_argc = 0;
    return -1;
}

/* ================================================================ pipeline
 *
 * Split the token stream on '|', then pull the redirections out of each
 * stage.  Ordering matters: the line is tokenized ONCE, so a '|' inside a
 * quoted argument is data and never a stage boundary.  Doing it the other way
 * round (splitting the raw string, then tokenizing each piece) is the classic
 * bug where `echo "a | b"` silently becomes two stages.
 */

void parser_free_pipeline(caps_pipeline_t *pipeline)
{
    if (pipeline == NULL || pipeline->stages == NULL)
        return;
    for (int i = 0; i < pipeline->count; i++) {
        parser_free_argv(pipeline->stages[i].argv);
        parser_free_redirections(pipeline->stages[i].redirs,
                                 pipeline->stages[i].nredirs);
    }
    free(pipeline->stages);
    pipeline->stages = NULL;
    pipeline->count = 0;
}

/* Copy a display label into a fixed field, truncating rather than failing. */
static void set_label(char *dst, size_t cap, const char *src)
{
    snprintf(dst, cap, "%s", src);
}

int parser_parse_pipeline(const char *line, caps_pipeline_t *out)
{
    g_error[0] = '\0';
    out->stages = NULL;
    out->count = 0;

    char **tokens = NULL;
    int ntokens = 0;
    int rc = parser_tokenize(line, &tokens, &ntokens);
    if (rc != 0) {
        /* parser_tokenize already recorded the reason. */
        return rc;
    }

    /* Count stages: one plus the number of '|' tokens. */
    int nstages = 1;
    for (int i = 0; i < ntokens; i++) {
        if (strcmp(tokens[i], "|") == 0)
            nstages++;
    }
    if (nstages > CAPS_MAX_STAGES) {
        set_error("pipeline has %d stages, over the %d stage limit",
                  nstages, CAPS_MAX_STAGES);
        goto fail_syntax;
    }

    caps_stage_t *stages = calloc((size_t)nstages, sizeof *stages);
    if (stages == NULL)
        goto fail_alloc;

    /*
     * Slice the token stream into per-stage token ranges, then let each stage
     * own its own copy of the tokens it keeps.  Two passes are needed because a
     * stage's argv has to be NULL-terminated and compacted, and the redirection
     * split mutates in place.
     */
    int stage = 0;
    int start = 0;
    int i = 0;
    int ok = 1;

    for (i = 0; i <= ntokens; i++) {
        int boundary = (i == ntokens) || (strcmp(tokens[i], "|") == 0);
        if (!boundary)
            continue;

        int end = i;
        if (end == start) {
            set_error(stage == 0
                      ? "pipeline may not begin with '|'"
                      : "empty stage between two '|' (an empty stage is not a command)");
            ok = 0;
            break;
        }

        /* Copy this stage's tokens so the stage owns them independently. */
        int len = end - start;
        char **argv = calloc((size_t)len + 1, sizeof *argv);
        if (argv == NULL) {
            ok = 0;
            set_error("out of memory");
            break;
        }
        for (int k = 0; k < len; k++) {
            argv[k] = strdup(tokens[start + k]);
            if (argv[k] == NULL) {
                for (int j = 0; j < k; j++)
                    free(argv[j]);
                free(argv);
                ok = 0;
                set_error("out of memory");
                break;
            }
        }
        if (!ok)
            break;
        argv[len] = NULL;

        int argc = len;
        redirection_t *redirs = NULL;
        int nredirs = 0;
        if (parser_split_redirections(argv, &argc, &redirs, &nredirs) != 0) {
            /* parser_split_redirections already reported why. */
            parser_free_argv(argv);
            ok = 0;
            break;
        }
        if (argc == 0) {
            /*
             * A stage that consisted only of redirections has no command.
             * `a | > out.txt` is a syntax error, not a stage that runs
             * `inherit` and writes to a file.
             */
            parser_free_argv(argv);
            parser_free_redirections(redirs, nredirs);
            set_error("stage %d has redirections but no command", stage);
            ok = 0;
            break;
        }

        stages[stage].argv = argv;
        stages[stage].argc = argc;
        stages[stage].redirs = redirs;
        stages[stage].nredirs = nredirs;

        stage++;
        start = i + 1;
    }

    if (!ok) {
        /*
         * Release every stage built so far.  Stages after the failure were
         * never populated, and calloc zeroed them, so freeing the whole array
         * is safe.
         */
        for (int s = 0; s < nstages; s++) {
            parser_free_argv(stages[s].argv);
            parser_free_redirections(stages[s].redirs, stages[s].nredirs);
        }
        free(stages);
        goto fail_syntax_no_free;
    }

    /* Describe the wiring for the record.  The real wiring is fd-based. */
    for (int s = 0; s < nstages; s++) {
        if (s == 0) {
            int has_in = 0;
            for (int r = 0; r < stages[s].nredirs; r++) {
                if (stages[s].redirs[r].type == CAPS_REDIR_IN)
                    has_in = 1;
            }
            set_label(stages[s].stdin_source, sizeof stages[s].stdin_source,
                      has_in ? "file" : "inherit");
        } else {
            set_label(stages[s].stdin_source, sizeof stages[s].stdin_source,
                      "pipe");
        }

        if (s == nstages - 1) {
            int has_out = 0;
            for (int r = 0; r < stages[s].nredirs; r++) {
                int t = stages[s].redirs[r].type;
                if (t == CAPS_REDIR_OUT || t == CAPS_REDIR_APPEND)
                    has_out = 1;
            }
            set_label(stages[s].stdout_dest, sizeof stages[s].stdout_dest,
                      has_out ? "file" : "inherit");
        } else {
            set_label(stages[s].stdout_dest, sizeof stages[s].stdout_dest,
                      "pipe");
        }
    }

    for (int k = 0; k < ntokens; k++)
        free(tokens[k]);
    free(tokens);

    out->stages = stages;
    out->count = nstages;
    return 0;

fail_alloc:
    for (int k = 0; k < ntokens; k++)
        free(tokens[k]);
    free(tokens);
    return -1;

fail_syntax:
    for (int k = 0; k < ntokens; k++)
        free(tokens[k]);
    free(tokens);
    return -2;

fail_syntax_no_free:
    for (int k = 0; k < ntokens; k++)
        free(tokens[k]);
    free(tokens);
    return -2;
}
