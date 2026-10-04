#!/usr/bin/env bash
#
# Resource limits: what is actually in force for a child, and what is refused.
#
# The property under test is that the gateway's configured limits and the
# kernel's in-force limits cannot silently diverge. A limit that is documented
# but not applied is worse than no limit, because a reader believes they are
# protected when nothing is enforcing anything.
#
# These tests therefore assert on the CHILD's own view of its limits, read from
# /proc/<pid>/limits while it is alive, rather than on what the gateway reported
# it configured.
#
# Usage: test_limits.sh <path-to-caps>

set -u

CAPS="${1:-./caps}"

pass_count=0
fail_count=0
passmsg() { printf 'PASS: %s\n' "$1"; pass_count=$((pass_count + 1)); }
failmsg() { printf 'FAIL: %s\n' "$1"; fail_count=$((fail_count + 1)); }

if [ ! -x "$CAPS" ]; then
    printf 'FATAL: %s is not executable\n' "$CAPS" >&2
    exit 1
fi

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Locate the memory-burn workload relative to the engine binary.
#
# `dirname "$CAPS"` rather than a hard-coded ./build: the suite is invoked with an
# explicit engine path, so the engine's own directory is the only thing that is
# guaranteed to be correct. Hard-coding "./build/workloads" makes the suite pass
# SKIP when run from any other directory, which looks like a clean result and is
# not one.
MEM_BURN="$(dirname "$CAPS")/build/workloads/caps_memory_burn"

# Extract the first PROCESS_STARTED pid from an event stream.
#
# Field order matters: the line is
#   {"event":"PROCESS_STARTED","time":"...","pid":N,"pgid":...}
# so the substitution must match the event name and the time field before
# `"pid":`. Anchoring on `"pid":` alone matches nothing useful and yields an
# empty result that looks like "the engine never started a process".
event_pid() {
    sed -n 's/.*"event":"PROCESS_STARTED","time":"[^"]*","pid":\([0-9][0-9]*\).*/\1/p' "$1" 2>/dev/null | head -1
}

# Start a long-lived child and print its PID.
#
# Three things this has to get right, each of which produced a silently empty
# capture when it was wrong:
#
#   1. The PID comes from the engine's own PROCESS_STARTED event, not from `$!`.
#      `$!` is the engine; the event's pid is the executed program, and it is the
#      executed program's /proc/<pid>/limits that is under test.
#   2. The event stream is on STDERR. stdout belongs to the executed program, so
#      a workload's own output cannot corrupt the events. Reading stdout yields
#      an empty file.
#   3. The capture is written to a file and polled. A command substitution around
#      a background job makes `$!` the substitution's own subshell.
#
# The child is `sleep 300` rather than something shorter because the whole point
# is to inspect a live process. Every caller MUST call stop_child afterwards, or
# the suite waits five minutes per case.
CHILD_PID=""
CHILD_RUNNER=""
start_child() {
    local outfile="$WORK/child.$$.$RANDOM.out"
    CHILD_OUT="$outfile"
    "$CAPS" --monitor --json --run-line "sleep 300" >/dev/null 2>"$outfile" &
    CHILD_RUNNER=$!
    local i
    for i in $(seq 1 120); do
        CHILD_PID=$(event_pid "$outfile")
        [ -n "$CHILD_PID" ] && return 0
        sleep 0.05
    done
    return 1
}

# Stop the engine and the child it ran, and do not wait for the sleep to finish.
#
# Order matters: the child is killed first so the engine's waitpid() returns and
# it exits on its own. Killing the engine first would leave the child orphaned
# and still sleeping for five minutes, holding the suite open.
stop_child() {
    [ -n "${CHILD_PID:-}" ] && kill -9 "$CHILD_PID" 2>/dev/null
    if [ -n "${CHILD_RUNNER:-}" ]; then
        # Poll briefly for a clean exit, then insist.
        local i
        for i in $(seq 1 20); do
            kill -0 "$CHILD_RUNNER" 2>/dev/null || break
            sleep 0.05
        done
        kill -9 "$CHILD_RUNNER" 2>/dev/null
        wait "$CHILD_RUNNER" 2>/dev/null
    fi
    CHILD_PID=""
    CHILD_RUNNER=""
    return 0
}

# Read the SOFT limit out of /proc/<pid>/limits.
#
# /proc/<pid>/limits is COLUMN-ALIGNED, not colon-separated:
#
#   Limit              Soft Limit           Hard Limit           Units
#   Max address space  536870912            536870912            bytes
#
# An earlier version of this helper parsed it as `-F:` and matched a field name
# like "Max address space", which the file does not contain in that form. The
# result was an empty string for every limit, so every assertion failed while
# looking like a limit that had not been applied.
#
# Matching is case-insensitive and whitespace-tolerant because the capitalisation
# has varied between kernel versions ("Max cpu time" vs "Max CPU time").
child_limit() {
    local pid="$1" field="$2"
    # Match by PREFIX on the raw line, not by comparing `$1`. The limit name is
    # a multi-word phrase ("Max core file size"), and awk's default field split
    # makes `$1` just "Max" -- so a `$1 == "Max core file size"` test can never
    # succeed, and `$1 == "Max"` matches every limit in the file at once.
    #
    # `index($0, want) == 1` anchors on the start of the line, so "Max file
    # size" cannot match "Max core file size" by accident. The remainder after
    # the name is the soft limit followed by the hard limit, so the first
    # whitespace-separated token of the remainder is the soft limit.
    awk -v want="$field" '
        NR > 1 && index($0, want) == 1 {
            rest = substr($0, length(want) + 1)
            sub(/^[ \t]+/, "", rest)
            split(rest, a, /[ \t]+/)
            print a[1]
            exit
        }
    ' "/proc/$pid/limits" 2>/dev/null
}

echo "== defaults: RLIMIT_CORE is always refused to dump =="

if start_child; then
    core=$(child_limit "$CHILD_PID" "Max core file size")
    if [ "$core" = "0" ]; then
        passmsg "RLIMIT_CORE is 0, so the workload cannot write a core dump"
    elif [ "$core" = "unlimited" ]; then
        failmsg "RLIMIT_CORE is unlimited; a workload can leave core dumps on the host"
    else
        failmsg "RLIMIT_CORE is '$core', expected 0"
    fi
else
    failmsg "could not capture a child PID from the engine's event stream"
fi
stop_child

echo
echo "== a configured address-space limit is actually in force =="

# 512 MiB of address space: large enough that `sleep` starts normally, which is
# the point. A limit must protect the host without preventing ordinary work.
if CAPS_LIMIT_ADDRESS_SPACE_BYTES=536870912 start_child; then
    as=$(child_limit "$CHILD_PID" "Max address space")
    if [ "$as" = "536870912" ]; then
        passmsg "the child's RLIMIT_AS is the configured 512 MiB, read from /proc/<pid>/limits"
    else
        failmsg "RLIMIT_AS is '$as', expected 536870912 -- the configured limit was not applied"
    fi

    # Configuring one limit must not silently impose another.
    cpu=$(child_limit "$CHILD_PID" "Max cpu time")
    if [ "$cpu" = "unlimited" ]; then
        passmsg "an unrelated limit was not imposed alongside the address-space limit"
    else
        failmsg "RLIMIT_CPU became '$cpu' when only an address-space limit was configured"
    fi
else
    failmsg "a 512 MiB address-space limit prevented \`sleep\` from starting at all"
fi
stop_child

echo
echo "== a configured CPU limit is actually in force =="

if CAPS_LIMIT_CPU_SECONDS=7 start_child; then
    cpu=$(child_limit "$CHILD_PID" "Max cpu time")
    # The kernel renders a finite CPU limit in seconds.
    if printf '%s' "$cpu" | grep -qw '7'; then
        passmsg "the child's RLIMIT_CPU is the configured 7 seconds"
    else
        failmsg "RLIMIT_CPU is '$cpu', expected 7 seconds"
    fi
else
    failmsg "a 7 second CPU limit prevented \`sleep\` from starting"
fi
stop_child

echo
echo "== a limit the program really hits binds =="

# The strongest evidence that a limit is real: a program that must map more than
# the cap allows has to fail. A limit that is set but has no effect would satisfy
# every "is it in force" check above and still protect nothing.
#
# The first-party memory workload rather than `cat /dev/zero` or `head -c`, for
# two reasons that each produced a wrong answer first:
#
#   `cat /dev/zero` never terminates on its own. Under a limit that failed to
#   bind it would fill the disk instead of failing, hanging the suite on a write
#   to the Windows volume.
#   `head -c N /dev/zero` terminates but streams. RLIMIT_AS bounds VIRTUAL
#   ADDRESS SPACE, and `head` maps almost none regardless of how many bytes it
#   reads -- so it completed successfully under a 64 MiB cap, which is correct
#   kernel behaviour and exactly why this limit must never be described as a
#   memory limit. A streaming reader is not caught by RLIMIT_AS.
#
# caps_memory_burn maps and touches its allocation, so it genuinely needs the
# address space and must fail when the cap is below it.
if [ ! -x "$MEM_BURN" ]; then
    printf 'SKIP: %s is not built; the memory-burn workload cannot be exercised\n' "$MEM_BURN"
else
    # 256 MiB is the workload's own documented ceiling (CAPS_WL_MAX_MEMORY_MIB),
    # so 512 is not a valid request and the workload refuses it with a usage
    # error before allocating anything. A test that ignored this saw a non-zero
    # exit and concluded the limit had bound, when nothing was ever allocated.
    # 256 MiB against a 64 MiB cap is a request that is valid AND too large.
    CAPS_LIMIT_ADDRESS_SPACE_BYTES=67108864 "$CAPS" --monitor --json \
        --run-line "$MEM_BURN 5 256" >"$WORK/hit.out" 2>"$WORK/hit.err"
    rc=$?
    if [ "$rc" -ne 0 ]; then
        passmsg "a workload needing more address space than allowed exits non-zero"
    else
        failmsg "a 256 MiB allocation succeeded under a 64 MiB address-space cap, so the limit did not bind"
    fi

    # The workload must have been asked to do something valid, or the exit code
    # proves nothing. A usage rejection means the process never allocated.
    if grep -aq 'usage:' "$WORK/hit.err" 2>/dev/null; then
        failmsg "the workload rejected its own arguments, so nothing was allocated and this proves nothing"
    else
        passmsg "the workload accepted its arguments, so the allocation was genuinely attempted"
    fi

    # SIGKILL from address-space exhaustion is also non-zero, so the code alone
    # cannot distinguish exhaustion from any other failure. What makes this
    # specific is the SIGNAL in the event stream.
    if grep -aq '"signal":9' "$WORK/hit.err" 2>/dev/null; then
        passmsg "the exhaustion arrived as SIGKILL, which is how the kernel enforces RLIMIT_AS on touch"
    elif grep -aq '"outcome":"EXITED"' "$WORK/hit.err" 2>/dev/null; then
        # Equally valid, and this workload's actual behaviour: mmap succeeds
        # because RLIMIT_AS permits the reservation, then the first write to a
        # page beyond the cap fails the allocation. The program reports that as
        # an ordinary non-zero exit rather than dying to a signal.
        passmsg "the exhaustion surfaced as a handled allocation failure, not a signal, and is recorded as such"
    else
        failmsg "the event stream records neither a SIGKILL nor a handled exit: $(grep -ao '"outcome":"[A-Z_]*"' "$WORK/hit.err" | head -1)"
    fi

    # And it must be a real process exit, recorded like any other, so the
    # failure is visible to a gateway that reads only the events.
    if grep -aq '"event":"PROCESS_EXITED"' "$WORK/hit.err" 2>/dev/null; then
        passmsg "the exhaustion is recorded as a real process exit in the event stream"
    else
        failmsg "no PROCESS_EXITED event for the exhausted workload"
    fi

    # The control: with no cap the same workload must succeed. Without this, a
    # workload that fails for some unrelated reason would satisfy every assertion
    # above and the suite would prove nothing.
    "$CAPS" --monitor --json --run-line "$MEM_BURN 1 32" >"$WORK/ctl.out" 2>"$WORK/ctl.err"
    if [ $? -eq 0 ]; then
        passmsg "the same workload succeeds when its allocation fits, so the failure above was the limit"
    else
        failmsg "the control workload failed without a limit, so the limit test proves nothing"
    fi
fi

echo
echo "== a malformed limit is refused rather than treated as unlimited =="

# The important negative case. A typo in a limit that was meant to be protective
# must not be silently read as "no limit": that would remove the protection the
# operator configured, and nothing downstream would report the difference.
CAPS_LIMIT_ADDRESS_SPACE_BYTES=notanumber "$CAPS" --monitor --json --run-line "echo hello" >"$WORK/bad.out" 2>"$WORK/bad.err"
rc=$?
if [ "$rc" -ne 0 ]; then
    # The refusal reason is a plain line on stderr, interleaved with the event
    # stream, so the match must tolerate that. Exit 126 is the engine's own code
    # for "refused to exec", distinct from 127's "not found" and from a
    # program's own non-zero exit.
    if grep -aqi 'refusing to guess\|not a positive integer' "$WORK/bad.err"; then
        passmsg "a malformed address-space limit refuses the launch and names the variable"
    else
        failmsg "the launch was refused but the reason does not name the malformed variable: $(grep -a 'refusing\|caps:' "$WORK/bad.err" | head -2 | tr '\n' ' ')"
    fi
    if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
        passmsg "the refusal uses the engine's launch-failure exit code ($rc), not a program's own status"
    else
        failmsg "the refusal exited $rc, which is neither 126 nor 127"
    fi
else
    failmsg "a malformed address-space limit was silently ignored and the command ran"
fi

# The command must NOT have executed. `hello` on stdout is the proof, because a
# refusal that still runs the program is a refusal in name only.
if ! grep -q 'hello' "$WORK/bad.out" 2>/dev/null; then
    passmsg "the refused command produced no output, so it truly did not run"
else
    failmsg "the refused command still executed: $(head -1 "$WORK/bad.out")"
fi

# The refusal must reach the EVENT STREAM, not only stderr as free text. A
# gateway reads the events and never the prose, so a refusal that exists only as
# a human-readable line is invisible to the system that has to act on it.
#
# The engine names this event EXEC_ERROR rather than EXECUTION_FAILED: the child
# reported the failure through the status pipe, so it is an exec error carrying
# EAGAIN. Asserting on the name the engine actually emits avoids an assertion
# that passes only if the message happens to contain some other substring.
if grep -aq '"event":"EXEC_ERROR"' "$WORK/bad.err" 2>/dev/null; then
    passmsg "the refusal is recorded as EXEC_ERROR in the event stream"
else
    failmsg "the refusal produced no EXEC_ERROR event; a gateway reading events would not see it"
fi

# And the reason must be preserved, since "it failed" without "why" is not
# actionable.
if grep -aq '"reason":"exec_failed"' "$WORK/bad.err" 2>/dev/null; then
    passmsg "the event carries a machine-readable reason"
else
    failmsg "the event carries no machine-readable reason"
fi

echo
echo "== an absent limit means unlimited, not zero =="

# Unset must mean unlimited. Reading "absent" as 0 would make every workload
# fail to start, which is the opposite failure and just as wrong.
if start_child; then
    as=$(child_limit "$CHILD_PID" "Max address space")
    if [ "$as" = "unlimited" ]; then
        passmsg "an unconfigured address-space limit is unlimited, not zero"
    else
        failmsg "an unconfigured RLIMIT_AS is '$as', expected unlimited"
    fi
else
    printf 'SKIP: could not capture a child PID for the unconfigured case\n'
fi
stop_child

echo
printf 'TOTAL: %d passed, %d failed\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ]
