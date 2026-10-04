#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "utils.h"

void caps_error(const char *fmt, ...)
{
    va_list ap;

    fputs("caps: ", stderr);
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
}

void caps_join_argv(char *const argv[], char *dst, size_t size)
{
    size_t pos = 0;

    if (size == 0)
        return;

    dst[0] = '\0';
    if (argv == NULL)
        return;

    for (int i = 0; argv[i] != NULL; i++) {
        const char *tok = argv[i];
        size_t tlen = strlen(tok);
        size_t need = (i > 0 ? (size_t)1 : (size_t)0) + tlen;

        if (pos + need + 1 > size)
            break;
        if (i > 0)
            dst[pos++] = ' ';
        memcpy(dst + pos, tok, tlen);
        pos += tlen;
    }
    dst[pos] = '\0';
}

void caps_json_escape(FILE *out, const char *s)
{
    if (s == NULL) {
        fputs("", out);
        return;
    }
    for (const unsigned char *p = (const unsigned char *)s; *p != '\0'; p++) {
        unsigned char c = *p;
        switch (c) {
        case '"':  fputs("\\\"", out); break;
        case '\\': fputs("\\\\", out); break;
        case '\n': fputs("\\n", out);  break;
        case '\r': fputs("\\r", out);  break;
        case '\t': fputs("\\t", out);  break;
        case '\b': fputs("\\b", out);  break;
        case '\f': fputs("\\f", out);  break;
        default:
            if (c < 0x20) {
                /*
                 * Any other control byte has no short escape, so it is
                 * emitted as \u00XX.  Passing it through would produce a JSON
                 * document no parser accepts, which is worse than useless: the
                 * caller would see a parse error and conclude the command line
                 * was rejected, when in fact the command was fine.
                 */
                fprintf(out, "\\u%04x", c);
            } else {
                fputc((int)c, out);
            }
            break;
        }
    }
}
