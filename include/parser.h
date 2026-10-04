#ifndef CAPS_PARSER_H
#define CAPS_PARSER_H

#include "process.h"

/*
 * Hard ceiling on a single token, and on the whole command line.
 *
 * These are not arbitrary: they bound the work a malformed or hostile line
 * can cause before the browser or the gateway sees it.  A 20000-character
 * token is already far beyond any real argument and is tested explicitly.
 */
#define CAPS_MAX_TOKEN   20000
#define CAPS_MAX_LINE    65536
#define CAPS_MAX_ARGS    4096
#define CAPS_MAX_STAGES  16

/*
 * Split a command line into a NULL-terminated argv array.
 *
 * This is the legacy whitespace-only tokenizer, retained because the original
 * token/argv tests pin its behaviour.  Use parser_tokenize() for anything
 * user-facing: it additionally honours quoting and backslash escapes.
 *
 * Parsing rules:
 *   - tokens are separated by whitespace (spaces and tabs);
 *   - leading and trailing whitespace is ignored;
 *   - runs of whitespace count as one separator;
 *   - on empty / whitespace-only input *out_argv == { NULL } and
 *     *out_argc == 0;
 *   - memory is allocated per token and for the pointer array itself.
 *
 * argv[argc] == NULL is always guaranteed.
 *
 * Returns 0 on success (including empty input), -1 on allocation
 * failure (out_argv and out_argc are unchanged).
 */
int parser_parse(const char *line, char ***out_argv, int *out_argc);

/*
 * Tokenize a command line honouring quoting and backslash escapes.
 *
 * This is the one lexer in CAPS and the only place command-line syntax is
 * interpreted.  Everything downstream (pipeline splitting, redirection
 * extraction, the gateway, the browser) consumes its output rather than
 * re-parsing the raw string, so there is exactly one grammar in the product.
 *
 * Grammar, deliberately a strict subset of POSIX:
 *
 *   - unquoted whitespace (space, tab, newline) separates tokens;
 *   - '...' is a single-quoted string: every byte is literal, including
 *     backslash.  The closing quote must exist;
 *   - "..." is a double-quoted string.  Inside it, backslash escapes only
 *     " \ $ ` and newline; a backslash before anything else is literal,
 *     matching POSIX so that, for example, "\d" stays "\d";
 *   - outside quotes, backslash escapes the next byte;
 *   - a NUL byte terminates the line and cannot appear in a token;
 *   - '#' starts a comment only at the beginning of a token (POSIX rule),
 *     which is what makes `echo a#b` print "a#b".
 *
 * EXPLICITLY NOT IMPLEMENTED, and therefore inert literal bytes rather than
 * syntax: variable expansion, command substitution, subshells, globbing,
 * brace expansion, tilde expansion, job control, and lists.  `*` and `?` are
 * passed through to the program unchanged; CAPS never expands them, because
 * CAPS is not a shell.  If the program itself globs, that is the program's
 * own behaviour and is visible in its recorded argv.
 *
 * Returns 0 on success, -1 on allocation failure, -2 on a syntax error
 * (unterminated quote, token or line too long, too many tokens, or an
 * embedded NUL).  On -2 a message has been written to stderr and the out
 * parameters are untouched.
 */
int parser_tokenize(const char *line, char ***out_argv, int *out_argc);

/* Human-readable detail for a parser_tokenize() -2 return. */
const char *parser_last_error(void);

/*
 * Remove I/O redirection tokens from an argv built by parser_parse().
 *
 * CAPS IS NOT A SHELL.  There is no quoting, no globbing, no expansion, no
 * pipe, no command substitution, and no job control.  A command line is a
 * sequence of whitespace-separated tokens, and only the three redirections
 * below are understood:
 *   - ">"       truncating output
 *   - ">>"      appending output
 *   - "<"       input
 * each of which must be a whole token followed by exactly one file-name
 * token.  Anything glued to an operator ("cmd>file") is an ordinary token,
 * because CAPS has no lexer that could split it.
 *
 * Operation is validation-first and then mutation:
 *   - the token count is validated before anything is removed, so on any
 *     error the original argv is left untouched;
 *   - a redirection operator may never occupy the file-name slot, so
 *     "echo hi > > out.txt" is a syntax error rather than a write to a file
 *     named ">";
 *   - the file token's ownership is *transferred* into the returned
 *     redirection array (argv no longer references it);
 *   - operator tokens are freed; the remaining argv is compacted in
 *     place and argv[argc] == NULL is re-established.
 *
 * Returns:
 *   0  on success (out_redirs may be NULL with *out_n == 0),
 *  -1 on allocation failure (argv untouched),
 *  -2 on a syntax error (missing file, or an operator in the file slot;
 *     already reported to stderr; argv untouched, *out_redirs is NULL
 *     and *out_n is 0).
 */
int parser_split_redirections(char **argv, int *argc,
                              redirection_t **out_redirs, int *out_n);

/*
 * Free all memory owned by a redirection array built by
 * parser_split_redirections() (the transferred file tokens and the
 * array itself).  Safe to call with NULL/0.
 */
void parser_free_redirections(redirection_t *redirs, int n);

/*
 * Free all memory owned by an argv built by parser_parse().  Safe to
 * call with a pointer returned by parser_parse() even on empty input.
 */
void parser_free_argv(char **argv);

/* ------------------------------------------------------------------ pipeline
 *
 * caps_pipeline_t and caps_stage_t are defined in process.h, because a stage
 * owns a redirection_t and process.h is included above.  parser.h only fills
 * them in.
 *
 * `stdin_source` and `stdout_dest` are display strings describing where a
 * stage's standard input came from and where its standard output went
 * ("pipe:stage0", "inherit", "workspace/out.txt", ...).  They are evidence
 * for the reader; the actual wiring is performed by process_exec_pipeline()
 * from the pipe descriptors, never from these strings.
 */

/*
 * Parse a command line into a pipeline.
 *
 * Syntax accepted, as whole tokens only (CAPS has no lexer that could split
 * "cmd>file", so that stays one literal token):
 *
 *   cmd arg 'quoted arg' "another arg"     arguments
 *   a | b                                  two-stage pipeline
 *   a | b | c                              three-stage pipeline
 *   a > out.txt                            stage 0 stdout to a file
 *   a >> out.txt                           stage 0 stdout appended
 *   a < in.txt                             stage 0 stdin from a file
 *   a 2> err.txt                           stage 0 stderr to a file
 *   a 2>> err.txt                          stage 0 stderr appended
 *   a | b > out.txt 2> err.txt             redirections attach to b
 *
 * Rejected with -2 and a stderr message:
 *   - a leading or trailing '|', or '||'      (an empty stage is not a command)
 *   - an empty stage between two '|'
 *   - a redirection operator with no file name, or a file name that is itself
 *     an operator
 *   - more than CAPS_MAX_STAGES stages
 *   - a syntax error from parser_tokenize()
 *
 * On success the pipeline owns every token and redirection, and is released by
 * parser_free_pipeline().  On failure nothing is retained and the out
 * parameter is untouched.
 *
 * Returns 0 on success, -1 on allocation failure, -2 on a syntax error.
 */
int parser_parse_pipeline(const char *line, caps_pipeline_t *out);

/* Release every allocation owned by a pipeline built by parser_parse_pipeline. */
void parser_free_pipeline(caps_pipeline_t *pipeline);

#endif /* CAPS_PARSER_H */
