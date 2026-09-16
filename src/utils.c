#include <stdarg.h>
#include <stdio.h>

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