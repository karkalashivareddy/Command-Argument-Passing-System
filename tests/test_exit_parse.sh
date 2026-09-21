#!/usr/bin/env bash
# Exit-status argument validation (built-in `exit` hardening).
#
# Replaces the former atoi()-based parsing: invalid, partially numeric,
# overflowing, and out-of-range inputs must be rejected with a clear
# diagnostic and must never be silently coerced (e.g. "exit hello" -> 0,
# "exit 12abc" -> 12, "exit 256" -> 0, "exit 999...9" -> 255).
#
# Chosen semantics (documented in README): `exit` accepts an integer in
# [0,255]; anything else prints "exit: invalid status: '<arg>'" and
# keeps the REPL alive with last_status = 1.
set -u

bin=${1:?usage: test_exit_parse.sh <binary>}
fail=0

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

failmsg() {
    echo "FAIL: $*" >&2
    fail=1
}

# expect_status <name> <expected status> <script lines...>
# The script must exit via `exit N`; assert the final status and that no
# invalid-status diagnostic was emitted (i.e. the argument was accepted).
expect_status() {
    local name="$1" want="$2"
    shift 2
    printf '%s\n' "$@" > "$tmp/script"
    "$bin" < "$tmp/script" > "$tmp/out" 2> "$tmp/err"
    local got=$?
    if [ "$got" != "$want" ]; then
        failmsg "$name: status=$got (want $want)"
        return
    fi
    case "$(cat "$tmp/err")" in
        *"exit: invalid status"*) failmsg "$name: unexpected rejection" ;;
    esac
    echo "PASS: $name -> $got"
}

# expect_reject <name> <expected status> <expected stdout> <script lines...>
# The invalid `exit` must be rejected: a diagnostic is printed, the REPL
# survives (a following command runs), and the final status equals the
# last valid one issued.
expect_reject() {
    local name="$1" want_status="$2" want_out="$3"
    shift 3
    printf '%s\n' "$@" > "$tmp/script"
    "$bin" < "$tmp/script" > "$tmp/out" 2> "$tmp/err"
    local got=$?
    [ "$got" = "$want_status" ] ||
        failmsg "$name: status=$got (want $want_status)"
    [ "$(cat "$tmp/out")" = "$want_out" ] ||
        failmsg "$name: stdout='$(cat "$tmp/out")' (want '$want_out')"
    case "$(cat "$tmp/err")" in
        *"caps: exit: invalid status"*)
            echo "PASS: $name rejected with diagnostic" ;;
        *) failmsg "$name: missing invalid-status diagnostic";;
    esac
}

echo "Exit parse: valid statuses are accepted"
expect_status "exit 0"        0 "exit 0"
expect_status "exit 1"        1 "exit 1"
expect_status "exit 42"      42 "exit 42"
expect_status "exit 255"    255 "exit 255"
expect_status "exit uses last status" 1 "false" "exit"

echo "Exit parse: non-numeric input is rejected, REPL survives"
expect_reject "exit hello"        7 "alive" 'exit hello' 'echo alive' 'exit 7'
expect_reject "exit empty string" 7 "alive" 'exit ""'   'echo alive' 'exit 7'
expect_reject "exit 12abc"        7 "alive" 'exit 12abc' 'echo alive' 'exit 7'

echo "Exit parse: range and overflow are rejected"
expect_reject "exit 256 out of range"   7 "alive" 'exit 256' 'echo alive' 'exit 7'
expect_reject "exit -1 out of range"    7 "alive" 'exit -1' 'echo alive' 'exit 7'
expect_reject "exit -999 out of range"  7 "alive" 'exit -999' 'echo alive' 'exit 7'
expect_reject "exit overflow (ERANGE)"  7 "alive" 'exit 999999999999999999999999' 'echo alive' 'exit 7'

echo "Exit parse: rejected input leaves a usable last status"
out=$(printf '%s\n' 'exit hello' 'exit 0' | "$bin" 2>/dev/null)
[ "$?" -eq 0 ] || failmsg "exit-after-reject status=$?"
[ -z "$out" ] || failmsg "unexpected stdout: '$out'"
echo "PASS: rejection then exit 0 works"

[ "$fail" -eq 0 ] || exit 1
echo "PASS: test_exit_parse.sh ($bin)"
exit 0