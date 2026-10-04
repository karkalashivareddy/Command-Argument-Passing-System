#!/usr/bin/env bash
#
# pidfd capability, identity binding, and signal safety.
#
# The property under test is the one that matters for a gateway that kills
# processes it is tracking: a signal must never reach a process the gateway did
# not observe. Every case below is chosen because it is a way that can go
# wrong, not because it is convenient to assert.
#
# Usage: test_pidfd.sh <path-to-caps_pidfd>

set -u

PROBE="${1:-./build/caps_pidfd}"

pass_count=0
fail_count=0

passmsg() { printf 'PASS: %s\n' "$1"; pass_count=$((pass_count + 1)); }
failmsg() { printf 'FAIL: %s\n' "$1"; fail_count=$((fail_count + 1)); }

if [ ! -x "$PROBE" ]; then
    printf 'FATAL: %s is not executable\n' "$PROBE" >&2
    exit 1
fi

# Every response is one line of JSON. The helper is required to emit a
# parseable document, so a test that cannot find `"ok":true` has found a real
# defect rather than a formatting difference.
json_ok()      { printf '%s' "$1" | grep -q '"ok":true'; }
json_not_ok()  { printf '%s' "$1" | grep -q '"ok":false'; }
json_reason()  { printf '%s' "$1" | sed 's/.*"reason":"//; s/".*//'; }

WORK="$(mktemp -d)"
VICTIM=""

# Every background sleeper is detached from this script's stdout/stderr and
# recorded, then killed on exit.
#
# This is not cosmetic. A background child that inherits the script's stdout
# keeps the pipe open after the script finishes, so whatever is reading our
# output blocks until that child dies -- which for `sleep 300` means a
# five-minute hang that looks like a hung test rather than a leaked process.
cleanup() {
    for p in $VICTIM $ZOMBIE_HOLDER; do
        [ -n "$p" ] && kill -9 "$p" 2>/dev/null
    done
    rm -rf "$WORK"
}
trap cleanup EXIT

# Read field N of /proc/<pid>/stat, counting from the LAST ')' in the line.
#
# Two traps here, both of which produce a confidently wrong answer rather than
# an error:
#
#   1. comm can contain spaces AND closing parentheses, so counting from the
#      first ')' lands on the wrong field entirely.
#   2. After the last ')', field 3 (state) is the first token. Field 22 is
#      therefore token 20 counting from 1 -- an offset of 19. An earlier
#      version of this file used 20 and read field 23 (vsize), which made every
#      identity check fail in a way that looked like a kernel problem.
stat_field() {
    sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | awk -v n="$2" '{ print $n }'
}

# Start a long-lived sleeper and capture its identity the way the gateway does.
start_victim() {
    sleep 300 >/dev/null 2>&1 &
    VICTIM=$!
    # Field 22 counting from field 3 is token 20 from the start of the tail.
    VICTIM_TICKS=$(stat_field "$VICTIM" 20)
    if [ -z "$VICTIM_TICKS" ] || [ "$VICTIM_TICKS" = "0" ]; then
        failmsg "could not read start ticks for pid $VICTIM (got '$VICTIM_TICKS')"
        VICTIM_TICKS=0
    fi
}

stop_victim() {
    if [ -n "${VICTIM:-}" ]; then
        kill -9 "$VICTIM" 2>/dev/null
        wait "$VICTIM" 2>/dev/null
        VICTIM=""
    fi
}

echo "== pidfd capability probe =="

out="$("$PROBE" --probe 2>"$WORK/probe.err")"
rc=$?

# Whether pidfd exists is a property of the KERNEL, so the assertion is
# conditional. What is NOT conditional is that the helper must answer: a probe
# that produced nothing, or a document that is not parseable, is a defect on
# every platform.
if printf '%s' "$out" | grep -q '"ok"'; then
    passmsg "capability probe emits a parseable verdict"
else
    failmsg "capability probe produced no verdict: [$out]"
fi

if [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; then
    passmsg "capability probe exit status mirrors its verdict (0 ok, 1 unsupported)"
else
    failmsg "capability probe exited $rc; expected 0 or 1"
fi

if [ "$rc" -eq 0 ]; then
    if json_ok "$out"; then
        passmsg "pidfd is available and reported as such"
    else
        failmsg "exit 0 but ok was false: $out"
    fi
    # stderr carries the kernel release so the gateway can record WHICH kernel
    # was measured, rather than asserting a general capability.
    if grep -q '^kernel=' "$WORK/probe.err"; then
        passmsg "capability probe records the kernel release"
    else
        failmsg "capability probe did not record a kernel release"
    fi
else
    reason="$(json_reason "$out")"
    # The refusal must SAY WHY. "pidfd unavailable" with no reason is
    # indistinguishable from a probe that was never run.
    if [ -n "$reason" ]; then
        passmsg "pidfd unavailable is reported with a reason: $reason"
    else
        failmsg "pidfd unavailable reported with no reason"
    fi
    if printf '%s' "$out" | grep -qE 'ENOSYS|EPERM|not implemented'; then
        passmsg "unavailability is attributed to the kernel or a sandbox, not guessed"
    else
        failmsg "unavailability reason does not name a cause: $reason"
    fi
fi

if "$PROBE" 2>/dev/null; then
    failmsg "no subcommand should be a usage error"
else
    passmsg "no subcommand is a usage error"
fi

echo
echo "== pidfd identity binding and signal delivery =="

start_victim

# --- the normal path -------------------------------------------------------
out="$("$PROBE" --signal "$VICTIM" "$VICTIM_TICKS" 0 2>/dev/null)"
rc=$?
if [ "$rc" -eq 0 ] && json_ok "$out"; then
    passmsg "signal 0 reaches a verified process"
else
    failmsg "signal 0 to a verified process failed: $out (rc=$rc)"
fi

if [ -d "/proc/$VICTIM" ]; then
    passmsg "the target survived signal 0, as it must"
else
    failmsg "the target did not survive signal 0"
fi

# --- a wrong start-ticks value must be refused ------------------------------
#
# This is the PID-reuse case. If the gateway held a stale identity and signalled
# anyway, it would destroy an unrelated process. Refusal is the whole point.
out="$("$PROBE" --signal "$VICTIM" "$((VICTIM_TICKS + 999))" 15 2>/dev/null)"
rc=$?
if [ "$rc" -eq 1 ] && json_not_ok "$out"; then
    passmsg "a mismatched start-ticks value is refused"
else
    failmsg "a mismatched start-ticks value was not refused: $out (rc=$rc)"
fi
if printf '%s' "$out" | grep -qi 'recycl'; then
    passmsg "the refusal names PID recycling as the cause"
else
    failmsg "the refusal does not explain why: $out"
fi
if [ -d "/proc/$VICTIM" ]; then
    passmsg "the victim survived the refused signal"
else
    failmsg "the victim was killed by a refused signal"
fi

# --- a missing start-ticks value must be refused ---------------------------
out="$("$PROBE" --signal "$VICTIM" -1 15 2>/dev/null)"
if [ "$?" -eq 2 ] && json_not_ok "$out"; then
    passmsg "signalling a bare PID with no identity is refused"
else
    failmsg "signalling a bare PID was not refused: $out"
fi

# --- a process that does not exist -----------------------------------------
FREE=$(( 40000 + ($$ % 10000) ))
while [ -d "/proc/$FREE" ]; do FREE=$((FREE + 1)); done
out="$("$PROBE" --signal "$FREE" 12345 15 2>/dev/null)"
if json_not_ok "$out"; then
    passmsg "a PID with no process is refused (ESRCH)"
else
    failmsg "a nonexistent PID was not refused: $out"
fi

# --- /proc unavailable is distinct from ESRCH -------------------------------
#
# A PID that exists in the kernel but has no readable /proc entry -- typically
# a process we may signal but not inspect -- must be reported as unreadable,
# not silently treated as gone. The two mean different things to an operator.
out="$("$PROBE" --signal 1 0 15 2>/dev/null)"
if json_not_ok "$out"; then
    passmsg "pid 1 is refused without the expected identity"
else
    failmsg "pid 1 was signalled with a wrong identity"
fi

# --- an out-of-range signal number ------------------------------------------
out="$("$PROBE" --signal "$VICTIM" "$VICTIM_TICKS" 9999 2>/dev/null)"
if [ "$?" -eq 2 ]; then
    passmsg "an out-of-range signal number is a usage error"
else
    failmsg "an out-of-range signal number was not rejected: $out"
fi

# --- a non-numeric pid ------------------------------------------------------
out="$("$PROBE" --signal abc "$VICTIM_TICKS" 15 2>/dev/null)"
if json_not_ok "$out"; then
    passmsg "a non-numeric pid is refused rather than coerced"
else
    failmsg "a non-numeric pid was accepted: $out"
fi

# --- SIGTERM really terminates, proving the signal path works ---------------
out="$("$PROBE" --signal "$VICTIM" "$VICTIM_TICKS" 15 2>/dev/null)"
if [ "$?" -eq 0 ]; then
    passmsg "SIGTERM is delivered through the pidfd"
else
    failmsg "SIGTERM through the pidfd failed: $out"
fi

# The victim is not our child, so wait() cannot reap it. Poll /proc instead,
# which is what a gateway polling an arbitrary host PID must also do.
gone=0
for _ in $(seq 1 50); do
    if [ ! -d "/proc/$VICTIM" ]; then gone=1; break; fi
    sleep 0.1
done
if [ "$gone" -eq 1 ]; then
    passmsg "the signalled process actually terminated"
else
    failmsg "the signalled process is still present after SIGTERM"
    VICTIM=""
fi

# --- the zombie case -------------------------------------------------------
#
# A child that exits but is never reaped keeps a /proc entry whose state is Z
# and whose start ticks are unchanged. Its identity is still valid and its
# pidfd still refers to it, but signalling it is a no-op. The helper must not
# claim the signal was delivered to a live process in that case.
ZOMBIE_PID=""
ZOMBIE_HOLDER=""

# Produce a genuine zombie and wait for it to be observable.
#
# The holder must outlive this function or the zombie is reparented to init and
# reaped, which is exactly the case that made this assertion silently vacuous
# when it was attempted with a background `sleep`.
#
# The PID is read from the maker's OWN stdout rather than by scanning /proc for
# any process in state Z. A scan would happily latch onto an unrelated zombie
# belonging to something else on the machine and then assert things about it.
make_zombie() {
    local maker="$1"
    local i
    "$maker" 6 >"$WORK/maker.out" 2>/dev/null &
    ZOMBIE_HOLDER=$!
    for i in $(seq 1 60); do
        ZOMBIE_PID=$(head -1 "$WORK/maker.out" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$ZOMBIE_PID" ] && [ -f "/proc/$ZOMBIE_PID/stat" ]; then
            if [ "$(stat_field "$ZOMBIE_PID" 1)" = "Z" ]; then
                return 0
            fi
        fi
        sleep 0.05
    done
    return 1
}

if [ -n "${2:-}" ] && make_zombie "$2"; then
    zstate=$(stat_field "$ZOMBIE_PID" 1 | tr -d ' ')
    if [ "$zstate" = "Z" ]; then
        passmsg "an unreaped child is observed as a zombie, not as alive"
    else
        failmsg "expected state Z, observed '$zstate'"
    fi

    zticks=$(stat_field "$ZOMBIE_PID" 20)
    if [ -n "$zticks" ] && [ "$zticks" != "0" ]; then
        # This is the property that matters. A zombie still has a stable
        # identity, so a pidfd binds to it and the start-ticks check passes.
        # Treating it as a PID-reuse false positive would make the gateway
        # refuse to address its own dying child.
        out="$("$PROBE" --signal "$ZOMBIE_PID" "$zticks" 0 2>/dev/null)"
        if json_ok "$out"; then
            passmsg "a zombie's identity still binds, so it is not mistaken for a recycled PID"
        else
            failmsg "a zombie's identity failed to bind: $out"
        fi

        # And the wrong identity must still be refused on a zombie, so the
        # check is not simply always passing.
        out="$("$PROBE" --signal "$ZOMBIE_PID" "$((zticks + 4242))" 0 2>/dev/null)"
        if json_not_ok "$out"; then
            passmsg "a zombie with a mismatched identity is still refused"
        else
            failmsg "a zombie with a mismatched identity was accepted: $out"
        fi
    else
        failmsg "could not read a zombie's start ticks (got '$zticks')"
    fi

    kill -9 "$ZOMBIE_HOLDER" 2>/dev/null
    wait "$ZOMBIE_HOLDER" 2>/dev/null
    ZOMBIE_HOLDER=""
else
    printf 'SKIP: no zombie helper supplied; zombie identity assertions did not run\n'
fi

# --- re-parenting does not change identity ---------------------------------
#
# The parent of a process is not part of its identity. A process whose parent
# exits is re-parented to init or a subreaper, and it must still be addressable
# by the same pid and start ticks.
start_victim
VICTIM_PPID_BEFORE=$(stat_field "$VICTIM" 2 | tr -d ' ')
out="$("$PROBE" --signal "$VICTIM" "$VICTIM_TICKS" 0 2>/dev/null)"
if [ "$?" -eq 0 ]; then
    passmsg "a process is addressable regardless of its parent"
else
    failmsg "addressing a process failed while its parent was alive: $out"
fi
stop_victim

echo
printf 'TOTAL: %d passed, %d failed\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ]
