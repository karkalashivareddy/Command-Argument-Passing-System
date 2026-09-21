#!/usr/bin/env bash
# Exit-status and process-lifecycle tests.
# Uses the deterministic status_probe helper for controlled outcomes.
set -u

bin=${1:?usage: test_exit_status.sh <binary>}
helper=${2:?usage: test_exit_status.sh <binary> <helper>}
fail=0

failmsg() {
    echo "FAIL: $*" >&2
    fail=1
}

# run_once <line...> : run one-shot caps with the helper and print its status
run_once_status() {
    echo '' | "$bin" "$@" 2>/dev/null >/dev/null
    echo $?
}

echo "Status: normal exits"
[ "$(run_once_status "$helper" exit 0)" = "0" ]   || failmsg "exit 0 -> $?"
[ "$(run_once_status "$helper" exit 7)" = "7" ]   || failmsg "exit 7"
[ "$(run_once_status "$helper" exit 42)" = "42" ] || failmsg "exit 42"
[ "$(run_once_status false)" = "1" ]              || failmsg "false -> 1"
echo "PASS: exit 0 / 7 / 42 / false=1"

echo "Status: signal termination"
[ "$(run_once_status "$helper" signal 9)" = "137" ]  || failmsg "SIGKILL -> 137"
[ "$(run_once_status "$helper" signal 15)" = "143" ] || failmsg "SIGTERM -> 143"
[ "$(run_once_status "$helper" signal 11)" = "139" ] || failmsg "SIGSEGV -> 139"
echo "PASS: signals -> 128+signum"

echo "Status: REPL reports signal-terminated child via waitpid macros"
err=$(printf '%s\n' "$helper signal 15" | "$bin" 2>&1 >/dev/null)
case "$err" in
    *"terminated by signal 15"*) echo "PASS: WIFSIGNALED/WTERMSIG report" ;;
    *) failmsg "signal report: '$err'" ;;
esac

echo "Status: REPL survives a killed child"
out=$(printf '%s\n' "$helper signal 9" 'echo survived' | "$bin" 2>/dev/null)
[ "$out" = "survived" ] || failmsg "REPL died after child signal: '$out'"
echo "PASS: parent survives child signal"

echo "Status: REPL last_status propagates into exit"
out_status=$(printf '%s\n' "$helper exit 3" 'exit' | "$bin" 2>/dev/null >/dev/null; echo $?)
[ "$out_status" = "3" ] || failmsg "exit after status-3 command -> '$out_status'"
echo "PASS: exit inherits last status"

echo "Status: one-shot signal-terminated process still reports status"
err=$(echo '' | "$bin" "$helper" signal 9 2>&1 >/dev/null)
status=$?
[ "$status" -eq 137 ] || failmsg "signal 9 one-shot status $status (want 137)"
[ -z "$err" ] || failmsg "one-shot signal produced unexpected stderr: '$err'"
echo "PASS: one-shot propagates 137 without noise"

[ "$fail" -eq 0 ] || exit 1
echo "PASS: test_exit_status.sh ($bin)"
exit 0
