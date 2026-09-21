#!/usr/bin/env bash
# Signal-model tests (Phase 7).
#   * child restores SIGINT default before exec (probe signal 2 -> 130)
#   * parent ignores SIGINT and survives, continuing to reap its child
#   * REPL reports signal-terminated children (WIFSIGNALED/WTERMSIG)
set -u

bin=${1:?usage: test_signals.sh <binary>}
helper=${2:?usage: test_signals.sh <binary> <helper>}
fail=0

failmsg() {
    echo "FAIL: $*" >&2
    fail=1
}

echo "Signals: child restores SIGINT default before exec"
# If caps's child inherited SIG_IGN, raise(SIGINT) in the probe would be
# ignored and the probe would exit 0.  With the reset, it terminates by
# SIGINT -> caps exits 130.
echo '' | "$bin" "$helper" signal 2 2>/dev/null >/dev/null
status=$?
[ "$status" -eq 130 ] || failmsg "SIGINT-terminated child status=$status (want 130)"
echo "PASS: child died from SIGINT (130)"

echo "Signals: REPL reports SIGINT termination"
err=$(printf '%s\n' "$helper signal 2" | "$bin" 2>&1 >/dev/null)
case "$err" in
    *"terminated by signal 2"*) echo "PASS: REPL reports signal 2" ;;
    *) failmsg "signal-2 report: '$err'" ;;
esac

echo "Signals: parent ignores SIGINT while a foreground child runs"
# caps (parent) runs 'sh -c sleep 1'.  We SIGINT caps itself:
# it must survive (SIG_IGN) and still reap the child normally.
"$bin" sh -c 'sleep 1' 2>/dev/null &
pids_pid=$!
sleep 0.3
kill -INT "$pids_pid" 2>/dev/null
wait "$pids_pid"
status=$?
[ "$status" -eq 0 ] || failmsg "parent died or mis-reaped after SIGINT: status=$status"
echo "PASS: parent survived SIGINT (status=$status)"

echo "Signals: REPL survives a SIGTERM-terminated child"
out=$(printf '%s\n' "$helper signal 15" 'echo after-term' | "$bin" 2>/dev/null)
[ "$out" = "after-term" ] || failmsg "REPL died after SIGTERM child: '$out'"
echo "PASS: REPL survives child signal"

[ "$fail" -eq 0 ] || exit 1
echo "PASS: test_signals.sh ($bin)"
exit 0
