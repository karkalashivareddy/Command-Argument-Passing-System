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
