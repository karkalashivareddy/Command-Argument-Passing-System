#include <stdio.h>
#include <stdlib.h>

#include "process.h"

static void usage(FILE *stream)
{
    fprintf(stream,
            "Usage: caps <command> [argument ...]\n"
            "       caps                     (interactive mode, later phase)\n");
}

int main(int argc, char *argv[])
{
    if (argc < 2) {
        usage(stderr);
        return EXIT_FAILURE;
    }

    return process_exec(&argv[1]);
}