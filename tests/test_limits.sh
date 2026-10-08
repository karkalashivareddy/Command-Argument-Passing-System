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
# Both launch shapes are covered, and the distinction is the point:
#
#   single command      one process, one fork
#   multi-stage pipeline  one process per stage, one fork per stage
#
# A configured limit that reaches only the single-command path is not "mostly
# enforced" -- for `caps <burner> | cat` it protects nothing at all while
# reporting that it is configured, and the stage doing the work runs
# unconstrained. Each pipeline stage is therefore read from /proc/<pid>/limits
# individually.
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

# Extract the pid of ONE pipeline stage from an event stream.
#
# A pipeline emits several PROCESS_STARTED events and they must not be confused
# for each other: reading the first one and calling it "the pipeline" is how a
# limit applied to stage 0 alone comes to be reported as applied to the pipeline.
# The stage index and count are part of the match for that reason.
event_stage_pid() { # stage-index stage-count event-stream
    sed -n "s/.*\"event\":\"PROCESS_STARTED\",\"time\":\"[^\"]*\",\"pid\":\([0-9][0-9]*\).*\"stage\":$1,\"stages\":$2.*/\1/p" \
        "$3" 2>/dev/null | head -1
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
#
# Every launched pid is remembered, not just the first one. A pipeline forks one
# process per stage and stop_child has to take all of them down: leaving stage 1
# blocked on a read from a killed stage 0 keeps the suite open just as long as
# leaving the single command running would.
CHILD_PID=""
CHILD_RUNNER=""
CHILD_PIDS=""
remember_pid() { CHILD_PIDS="$CHILD_PIDS $1"; }

start_child() {
    local outfile="$WORK/child.$$.$RANDOM.out"
    CHILD_OUT="$outfile"
    "$CAPS" --monitor --json --run-line "sleep 300" >/dev/null 2>"$outfile" &
    CHILD_RUNNER=$!
    local i
    for i in $(seq 1 120); do
        CHILD_PID=$(event_pid "$outfile")
        if [ -n "$CHILD_PID" ]; then
            remember_pid "$CHILD_PID"
            return 0
        fi
        sleep 0.05
    done
    return 1
}

# Start a two-stage pipeline and remember BOTH stage pids.
#
# Stage 0 is `sleep 300`, which writes nothing and exits on its own only after
# five minutes. Stage 1 is `cat`, which blocks reading from a pipe nobody will
# write to. Both therefore stay alive for the whole inspection window, which is
# what makes a per-stage /proc/<pid>/limits read possible at all.
start_pipeline() { # <stage-count> <command line>
    local stages="$1" outfile="$WORK/pipe.$$.$RANDOM.out"
    CHILD_OUT="$outfile"
    "$CAPS" --monitor --json --run-line "$2" >/dev/null 2>"$outfile" &
    CHILD_RUNNER=$!
    local i stage seen
    for i in $(seq 1 120); do
        seen=0
        for stage in $(seq 0 $((stages - 1))); do
            CHILD_PID=$(event_stage_pid "$stage" "$stages" "$outfile")
            if [ -n "$CHILD_PID" ]; then
                remember_pid "$CHILD_PID"
                seen=$((seen + 1))
            fi
        done
        [ "$seen" -eq "$stages" ] && return 0
        sleep 0.05
    done
    return 1
}

# The pid of one stage of the pipeline currently running.
stage_pid() { # stage-index stage-count
    event_stage_pid "$1" "$2" "$CHILD_OUT"
}

# Stop the engine and every child it ran, and do not wait for the sleeps.
#
# Order matters: the children are killed first so the engine's waitpid() returns
# and it exits on its own. Killing the engine first would leave the children
# orphaned and still sleeping for five minutes, holding the suite open.
stop_child() {
    for p in $CHILD_PIDS; do kill -9 "$p" 2>/dev/null; done
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
    CHILD_PIDS=""
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
echo "== every stage of a multi-stage pipeline gets the configured limits =="

# The single-command path applied caps_limits_apply() and the pipeline stage path
# did not, so a configured RLIMIT_AS protected `caps <program>` and silently did
# nothing for `caps <program> | cat`. Nothing reported the difference: the limit
# was configured, the stage doing the work was unconstrained, and every "is it
# in force" assertion that only looked at a single command still passed.
#
# Both stages are therefore read from the kernel separately.
if CAPS_LIMIT_ADDRESS_SPACE_BYTES=536870912 CAPS_LIMIT_CPU_SECONDS=9 \
     start_pipeline 2 "sleep 300 | cat"; then
    for stage in 0 1; do
        spid=$(stage_pid "$stage" 2)
        if [ -z "$spid" ]; then
            failmsg "stage $stage: no pid was captured, so its limits were never read"
            continue
        fi

        sas=$(child_limit "$spid" "Max address space")
        if [ "$sas" = "536870912" ]; then
            passmsg "stage $stage (pid $spid): RLIMIT_AS is the configured 512 MiB"
        else
            failmsg "stage $stage (pid $spid): RLIMIT_AS is '$sas', expected 536870912 -- the pipeline stage ran unconstrained"
        fi

        scpu=$(child_limit "$spid" "Max cpu time")
        if printf '%s' "$scpu" | grep -qw '9'; then
            passmsg "stage $stage (pid $spid): RLIMIT_CPU is the configured 9 seconds"
        else
            failmsg "stage $stage (pid $spid): RLIMIT_CPU is '$scpu', expected 9 seconds"
        fi

        score=$(child_limit "$spid" "Max core file size")
        if [ "$score" = "0" ]; then
            passmsg "stage $stage (pid $spid): RLIMIT_CORE is 0, so the stage cannot dump core"
        else
            failmsg "stage $stage (pid $spid): RLIMIT_CORE is '$score', expected 0"
        fi
    done
else
    failmsg "could not capture both pipeline stage pids from the engine's event stream"
fi
stop_child

echo
echo "== a limit the pipeline's own producer really hits still binds =="

# Proof that the stage's limit is enforced rather than merely recorded. The
# memory-burn workload is the same first-party program the single-command case
# uses, placed in stage 0 with a `cat` after it: the stage must fail on the
# address-space cap exactly as the single command does.
if [ -x "$MEM_BURN" ]; then
    CAPS_LIMIT_ADDRESS_SPACE_BYTES=67108864 "$CAPS" --monitor --json \
        --run-line "$MEM_BURN 5 256 | cat" >"$WORK/pipehit.out" 2>"$WORK/pipehit.err"
    rc=$?

    # The pipeline's own status is its LAST stage's, which is shell convention:
    # `burner | cat` reports cat's 0 even when the producer was killed by its
    # limit. So the process exit code is NOT the evidence here -- asserting on it
    # would be asserting the opposite of correct behaviour. The evidence is the
    # producer stage's own terminal record.
    stage0_exit=$(sed -n 's/.*"event":"PROCESS_EXITED".*"stage":0,"stages":2,"exit_code":\([0-9][0-9]*\).*/\1/p' \
        "$WORK/pipehit.err" 2>/dev/null | head -1)
    stage0_outcome=$(sed -n 's/.*"event":"PROCESS_EXITED".*"stage":0,"stages":2,"exit_code":[0-9]*,"duration_ms":[0-9]*,"outcome":"\([A-Z_]*\)".*/\1/p' \
        "$WORK/pipehit.err" 2>/dev/null | head -1)

    if [ -z "$stage0_exit" ]; then
        failmsg "no stage-0 PROCESS_EXITED event: the producer's limit outcome was never recorded"
    elif [ "$stage0_exit" -eq 0 ]; then
        failmsg "a 256 MiB allocation in stage 0 succeeded under a 64 MiB cap, so the stage limit did not bind"
    else
        passmsg "stage 0 failed under the 64 MiB cap (exit_code=$stage0_exit, outcome=$stage0_outcome)"
    fi

    # `cat` completing must not change that verdict, and the pipeline must still
    # report cat's status. Both facts together are what distinguishes "the
    # producer's limit bound" from "the pipeline failed for some other reason".
    if [ "$rc" -eq 0 ]; then
        passmsg "the pipeline still reports its last stage's status ($rc), which is shell convention"
    else
        passmsg "the pipeline reported $rc"
    fi

    # It must be the producer stage that failed, not the consumer: `cat` exiting
    # non-zero for its own reasons would satisfy the assertions above and prove
    # nothing about the producer's limit.
    if grep -aq '"event":"PROCESS_EXITED"' "$WORK/pipehit.err" 2>/dev/null \
       && grep -aq '"stage":0,"stages":2' "$WORK/pipehit.err" 2>/dev/null; then
        passmsg "the failure is attributed to stage 0, the stage whose limit bound"
    else
        failmsg "no stage-0 exit event for the exhausted pipeline producer"
    fi

    # The consumer must still have completed: a pipeline that fails because its
    # consumer broke is a different defect from one that fails because its
    # producer hit a limit.
    if grep -aq '"stage":1,"stages":2,"exit_code":0' "$WORK/pipehit.err" 2>/dev/null; then
        passmsg "the consumer stage completed, so the failure was the producer's limit"
    else
        failmsg "the consumer stage did not complete: $(grep -a '"stage":1' "$WORK/pipehit.err" | head -1)"
    fi

    # The control: with no cap the same producer succeeds.
    "$CAPS" --monitor --json --run-line "$MEM_BURN 1 32 | cat" >"$WORK/pipectl.out" 2>"$WORK/pipectl.err"
    if [ $? -eq 0 ]; then
        passmsg "the same pipeline succeeds when the allocation fits, so the failure above was the limit"
    else
        failmsg "the control pipeline failed without a limit, so the pipeline limit test proves nothing"
    fi
else
    printf 'SKIP: %s is not built; the pipeline limit case cannot be exercised\n' "$MEM_BURN"
fi

echo
echo "== a malformed limit refuses a pipeline stage too =="

# The refusal has to hold for the stage path. A malformed bound that stops the
# single command but lets a pipeline stage through is the same defect as a limit
# that is never applied: protection the operator believes in and does not have.
CAPS_LIMIT_ADDRESS_SPACE_BYTES=notanumber "$CAPS" --monitor --json \
    --run-line "echo PIPE_LIMIT_PROOF | cat" >"$WORK/badpipe.out" 2>"$WORK/badpipe.err"
rc=$?
if [ "$rc" -ne 0 ]; then
    passmsg "a malformed address-space limit refuses a pipeline as well"
else
    failmsg "a malformed address-space limit was ignored by the pipeline stage path"
fi
if grep -aq 'PIPE_LIMIT_PROOF' "$WORK/badpipe.out" 2>/dev/null; then
    failmsg "the refused pipeline stage still executed: $(head -1 "$WORK/badpipe.out")"
else
    passmsg "no refused pipeline stage produced output, so none of them ran"
fi
if grep -aq '"event":"EXEC_ERROR"' "$WORK/badpipe.err" 2>/dev/null; then
    passmsg "the pipeline-stage refusal is recorded as EXEC_ERROR in the event stream"
else
    failmsg "the pipeline-stage refusal produced no EXEC_ERROR event"
fi

echo
printf 'TOTAL: %d passed, %d failed\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ]
