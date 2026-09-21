#ifndef CAPS_PARSER_H
#define CAPS_PARSER_H

#include "process.h"

/*
 * Split a command line into a NULL-terminated argv array.
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
 * Remove I/O redirection tokens from an argv built by parser_parse().
 *
 * A redirection is written as three understood spellings, each as a
 * whole token:  ">"  ">>"  "<".  Concretely:
 *   - ">"       truncating output
 *   - ">>"      appending output
 *   - "<"       input
 * each followed by exactly one file-name token.
 *
 * Operation is validation-first and then mutation:
 *   - the token count is validated before anything is removed, so on
 *     any error the original argv is left untouched;
 *   - the file token's ownership is *transferred* into the returned
 *     redirection array (arcv no longer references it);
 *   - operator tokens are freed; the remaining argv is compacted in
 *     place and argv[argc] == NULL is re-established.
 *
 * Returns:
 *   0  on success (out_redirs may be NULL with *out_n == 0),
 *  -1 on allocation failure (argv untouched),
 *  -2 on a syntax error (missing file, already reported to stderr;
 *     argv untouched, *out_redirs is NULL and *out_n is 0).
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

#endif /* CAPS_PARSER_H */
