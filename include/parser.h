#ifndef CAPS_PARSER_H
#define CAPS_PARSER_H

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
 * Free all memory owned by an argv built by parser_parse().
 * Safe to call with a pointer returned by parser_parse() even on
 * empty input.  Sets *argv to NULL after freeing.
 */
void parser_free_argv(char **argv);

#endif /* CAPS_PARSER_H */