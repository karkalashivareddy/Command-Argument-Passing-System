#ifndef CAPS_UTILS_H
#define CAPS_UTILS_H

#include <stdio.h>
#include <stddef.h>

/*
 * Print "caps: <formatted message>" to stderr.
 *
 * Used for all user- and system-level diagnostics so the error prefix
 * stays consistent across modules.  The child-side (post-fork,
 * pre-exec) error path intentionally does NOT use this helper; it
 * writes with write(2) directly (see process.c).
 */
void caps_error(const char *fmt, ...);

/*
 * Join a NULL-terminated argv into "tok1 tok2 ... tokN", truncated to
 * fit dst[size].  Always NUL-terminates dst.  Used to label monitor
 * events and error messages with the command that produced them.
 */
void caps_join_argv(char *const argv[], char *dst, size_t size);

/*
 * Write a string to `out` with JSON string escaping applied.
 *
 * The --inspect mode prints the argv it parsed as JSON so a caller can
 * validate exactly what would be exec'd.  That makes this a security
 * function, not a formatting convenience: a command name or argument
 * containing a double quote, a backslash, or a control byte would
 * otherwise terminate the JSON string early and inject arbitrary
 * structure into the object the gateway parses.  An attacker who can put
 * a quote in a terminal command line could forge a stage entry, or
 * forge the argv of a stage that was never going to run.
 *
 * Bytes below 0x20 are emitted as \u00XX rather than passed through, so
 * the output is valid JSON for any input the lexer accepted.  The lexer
 * already rejects NUL, but a stray newline or tab in an argument is
 * ordinary and must not break the document.
 */
void caps_json_escape(FILE *out, const char *s);

#endif /* CAPS_UTILS_H */
