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

#endif /* CAPS_UTILS_H */