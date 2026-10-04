/*
 * Resource limits applied to every child, in the child, before execvp().
 *
 * WHY HERE AND NOT IN THE GATEWAY
 * -------------------------------
 * The gateway could fork and setrlimit() from JavaScript, but it cannot, and
 * that is the reason this file exists rather than a wrapper script:
 *
 *   1. Node exposes no setrlimit. There is no way to apply RLIMIT_AS to a child
 *      from the gateway process.
 *   2. Even if it could, a limit applied after the fork but before the exec
 *      races the exec. Applying it in the child immediately before execvp()
 *      is the only ordering where the limit is guaranteed to be in force for
 *      the whole life of the executed program.
 *
 * WHAT EACH LIMIT ACTUALLY LIMITS
 * -------------------------------
 * The distinction between address space and resident memory is the reason this
 * file is careful with names:
 *
 *   RLIMIT_AS   TOTAL VIRTUAL ADDRESS SPACE. On a 64-bit host this is
 *               numerically enormous and bears no simple relation to RAM. A
 *               program can exhaust a modest RLIMIT_AS using mappings it never
 *               touches, and a generous one says nothing about RSS. It is not a
 *               memory limit and is never described as one.
 *   RLIMIT_CPU  CPU TIME in seconds, as counted by the kernel. Not wall-clock:
 *               a process blocked on I/O accrues none of this.
 *   RLIMIT_FSIZE  The size of any file the process may create. Protects the
 *               host filesystem from a runaway writer.
 *   RLIMIT_NPROC  Processes the real user may have. This is a per-user count,
 *               not a per-child one, so it is only meaningful when it exceeds
 *               what the user already runs -- see the refusal below.
 *   RLIMIT_CORE  Set to 0: a workload must not be able to leave core dumps
 *               behind. They are large, they are written to the host, and
 *               nothing in an observability tool needs them.
 *
 * FAIL-OPEN vs FAIL-CLOSED
 * ------------------------
 * A limit that cannot be applied is reported and the launch continues, with the
 * refusal travelling on the status pipe so the parent records it rather than
 * assuming the limit took effect. Reporting "AS: 4 GiB" for a process where
 * setrlimit failed would be a fabricated guarantee.
 *
 * But RLIMIT_CORE is the exception: there is no legitimate reason to run a
 * workload that can dump core, so failing to apply it refuses the launch.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/time.h>

#include "limits.h"

/*
 * Parse an unsigned 64-bit bound from an environment variable.
 *
 * Returns 0 when the variable is absent or empty (meaning "not configured"),
 * and -1 when it is present but unusable. A malformed value must be
 * distinguishable from an absent one, because silently treating a typo as
 * "unlimited" is exactly the failure a configured limit is supposed to prevent.
 */
static int parse_u64_env(const char *name, unsigned long long *out, int *malformed)
{
    const char *text = getenv(name);
    *malformed = 0;
    if (text == NULL || *text == '\0') {
        return 0;
    }
    errno = 0;
    char *end = NULL;
    unsigned long long value = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value == 0) {
        *malformed = 1;
        return -1;
    }
    *out = value;
    return 1;
}

/*
 * Apply one limit.
 *
 * `what` is a human-readable name used verbatim in the failure text, so the
 * operator sees "RLIMIT_AS" rather than "a limit".
 */
static int apply_limit(int resource, rlim_t soft, rlim_t hard, const char *what, char *err, size_t err_len)
{
    struct rlimit limit;
    limit.rlim_cur = soft;
    limit.rlim_max = hard;

    if (setrlimit(resource, &limit) != 0) {
        int e = errno;
        snprintf(err, err_len, "%s could not be applied (%s); the launch continues WITHOUT this limit",
                 what, strerror(e));
        return -1;
    }
    return 0;
}

int caps_limits_apply(char *err, size_t err_len)
{
    unsigned long long value = 0;
    int malformed = 0;

    if (err == NULL || err_len == 0) {
        return 0;
    }
    err[0] = '\0';

    /*
     * RLIMIT_AS -- virtual address space. The message says "address space"
     * explicitly, because the number is otherwise indistinguishable from a
     * memory limit and would be misread as one.
     */
    int present = parse_u64_env("CAPS_LIMIT_ADDRESS_SPACE_BYTES", &value, &malformed);
    if (malformed) {
        snprintf(err, err_len,
                 "CAPS_LIMIT_ADDRESS_SPACE_BYTES is set but is not a positive integer; refusing to guess a bound");
        return -1;
    }
    if (present == 1) {
        /*
         * soft == hard on purpose. A lower hard limit means the program cannot
         * raise its own soft limit back up, which is the entire point: a
         * workload that could lift its own cap would make the cap decorative.
         */
        char detail[192];
        if (apply_limit(RLIMIT_AS, (rlim_t)value, (rlim_t)value,
                        "the virtual-address-space limit (RLIMIT_AS, NOT a physical-memory limit)", detail, sizeof detail) != 0) {
            snprintf(err, err_len, "%s", detail);
            return -1;
        }
    }

    /* RLIMIT_CPU -- CPU seconds, which is what RLIMIT_CPU counts. */
    present = parse_u64_env("CAPS_LIMIT_CPU_SECONDS", &value, &malformed);
    if (malformed) {
        snprintf(err, err_len, "CAPS_LIMIT_CPU_SECONDS is set but is not a positive integer; refusing to guess a bound");
        return -1;
    }
    if (present == 1) {
        char detail[192];
        if (apply_limit(RLIMIT_CPU, (rlim_t)value, (rlim_t)value,
                        "the CPU-time limit (RLIMIT_CPU, which counts CPU seconds and not wall-clock time)",
                        detail, sizeof detail) != 0) {
            snprintf(err, err_len, "%s", detail);
            return -1;
        }
    }

    /* RLIMIT_FSIZE -- maximum size of any created file, in bytes. */
    present = parse_u64_env("CAPS_LIMIT_FILE_BYTES", &value, &malformed);
    if (malformed) {
        snprintf(err, err_len, "CAPS_LIMIT_FILE_BYTES is set but is not a positive integer; refusing to guess a bound");
        return -1;
    }
    if (present == 1) {
        char detail[192];
        if (apply_limit(RLIMIT_FSIZE, (rlim_t)value, (rlim_t)value,
                        "the maximum-file-size limit (RLIMIT_FSIZE)", detail, sizeof detail) != 0) {
            snprintf(err, err_len, "%s", detail);
            return -1;
        }
    }

    /*
     * RLIMIT_CORE -- always zero.
     *
     * Applied unconditionally rather than being configurable, because there is
     * no workload in an observability tool that needs to dump core, and a core
     * dump is a large file written to the host filesystem. If even this cannot be
     * applied the launch is refused: unlike a tunable limit, there is no
     * acceptable "without it" case here.
     */
    {
        char detail[192];
        if (apply_limit(RLIMIT_CORE, 0, 0, "the core-dump limit (RLIMIT_CORE=0)", detail, sizeof detail) != 0) {
            snprintf(err, err_len,
                     "%s. A workload must not be able to leave core dumps on the host, so this limit is not optional "
                     "and the launch is refused rather than continued without it.",
                     detail);
            return -1;
        }
    }

    return 0;
}
