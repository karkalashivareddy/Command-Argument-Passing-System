/*
 * Deterministic status probe for the caps test suite.
 *
 * The test harness compiles this small helper so exit-status and
 * signal-termination tests never depend on unpredictable external
 * commands.
 *
 * Usage:
 *   status_probe exit N      exit normally with status N (0..255)
 *   status_probe signal S    raise signal S (default disposition
 *                            terminates the process)
 *   status_probe print A B   print each argument on its own line
 *                            (argument-passing verification)
 */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char *argv[])
{
    if (argc < 2)
        return 0;

    if (strcmp(argv[1], "exit") == 0 && argc >= 3)
        return atoi(argv[2]);

    if (strcmp(argv[1], "signal") == 0 && argc >= 3) {
        int sig = atoi(argv[2]);
        if (raise(sig) != 0)
            return 2;
    }

    if (strcmp(argv[1], "print") == 0) {
        for (int i = 2; i < argc; i++)
            printf("%s\n", argv[i]);
        return 0;
    }

    return 3; /* unknown mode */
}