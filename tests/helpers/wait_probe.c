/*
 * Deterministic probe for process_wait_child()'s failure policy.
 *
 * Direct syscall-failure injection is not needed: waitpid() on a pid
 * that is not our child fails with ECHILD, which is exactly the
 * terminal, non-EINTR path the policy documents.  The probe checks both
 * the normal reaping path and that terminal path.
 *
 * Usage:
 *   wait_probe        exercise both paths; exit 0 on success
 */
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include "process.h"

int main(void)
{
    int status = 0;
    int rc;

    /* Normal path: fork a child that exits 7 and reap it. */
    pid_t pid = fork();
    if (pid < 0) {
        perror("wait_probe: fork");
        return 2;
    }
    if (pid == 0)
        _exit(7);

    rc = process_wait_child(pid, &status);
    if (rc != 0) {
        fprintf(stderr, "wait_probe: normal wait returned %d\n", rc);
        return 3;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 7) {
        fprintf(stderr, "wait_probe: normal wait status=%d\n", status);
        return 4;
    }
    printf("normal status=%d\n", WEXITSTATUS(status));

    /*
     * Terminal path: our own parent is never our child, so waitpid()
     * fails with ECHILD immediately (no retry, no hang).
     */
    status = 0;
    rc = process_wait_child(getppid(), &status);
    if (rc != -1) {
        fprintf(stderr, "wait_probe: expected -1 for non-child, got %d\n", rc);
        return 5;
    }
    printf("terminal rc=%d\n", rc);

    return 0;
}
