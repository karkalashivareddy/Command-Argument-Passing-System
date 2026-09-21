#ifndef CAPS_UTILS_H
#define CAPS_UTILS_H

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

#endif /* CAPS_UTILS_H */