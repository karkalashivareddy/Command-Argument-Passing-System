#ifndef CAPS_LIMITS_H
#define CAPS_LIMITS_H

#include <stddef.h>

/*
 * Apply the configured resource limits to the calling process.
 *
 * CALLED IN THE CHILD, IMMEDIATELY BEFORE execvp().
 *
 * This ordering is the whole design. The gateway cannot apply RLIMIT_AS at
 * all -- Node exposes no setrlimit -- and even a native implementation would
 * race the exec if it set the limit after forking from outside. Applying them
 * here means the limits are provably in force for the entire life of the
 * executed program.
 *
 * WHAT IS APPLIED, AND WHAT IT ACTUALLY LIMITS
 *
 *   RLIMIT_AS     Total VIRTUAL ADDRESS SPACE in bytes. This is emphatically
 *                 NOT a physical-memory limit. On a 64-bit host the address
 *                 space is far larger than RAM, a program can exhaust a
 *                 modest RLIMIT_AS with mappings it never touches, and a
 *                 generous limit says nothing about RSS.
 *   RLIMIT_CPU    CPU time in seconds, as the kernel counts it. Not wall-clock:
 *                 a process blocked on I/O accrues none of it.
 *   RLIMIT_FSIZE  The largest file the process may create, in bytes.
 *   RLIMIT_CORE   Always 0, and not configurable. A workload has no business
 *                 writing core dumps onto the host filesystem.
 *
 * CONFIGURATION, via the environment
 * ---------------------------------
 *   CAPS_LIMIT_ADDRESS_SPACE_BYTES   unset or 0 = unlimited
 *   CAPS_LIMIT_CPU_SECONDS           unset or 0 = unlimited
 *   CAPS_LIMIT_FILE_BYTES            unset or 0 = unlimited
 *
 * A value that is present but not a positive integer is a REFUSAL, not a
 * silent "unlimited": a typo in a limit that was meant to be protective must
 * not quietly remove the protection.
 *
 * RETURN VALUE AND err
 * --------------------
 * Returns 0 when every configured limit was applied, and -1 when one could not
 * be applied or a configured value was unusable. On -1, `err` holds a
 * human-readable explanation that names the specific limit and what happened.
 *
 * The caller reports `err` through the same status-pipe path used for any other
 * launch failure, so an unapplied limit becomes a recorded fact about the
 * execution rather than a silent difference between what was configured and
 * what was in force. Reporting "AS: 4 GiB" for a process whose setrlimit
 * failed would be a fabricated guarantee.
 */
int caps_limits_apply(char *err, size_t err_len);

#endif /* CAPS_LIMITS_H */
