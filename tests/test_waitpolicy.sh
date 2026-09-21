#!/usr/bin/env bash
# waitpid() failure-policy tests.
#
# Directly exercises process_wait_child() through the wait_probe helper:
#   - the normal path reaps a real child and decodes its status;
#   - the terminal path (waitpid on a non-child -> ECHILD) returns -1
#     without retrying or hanging, and emits exactly one diagnostic.
#
# Deterministic: ECHILD is reproduced with our own parent pid, which can
# never be our child, so no mocking or timing is involved.
set -u

probe=${1:?usage: test_waitpolicy.sh <wait_probe>}
fail=0

failmsg() {
    echo "FAIL: $*" >&2
    fail=1
}

out=$("$probe" 2>/dev/null)
err=$("$probe" 2>&1 >/dev/null)

case "$out" in
    *"normal status=7"*) echo "PASS: normal wait reaps child and decodes status" ;;
    *) failmsg "normal wait path wrong: '$out'" ;;
esac

case "$out" in
    *"terminal rc=-1"*) echo "PASS: terminal waitpid failure returns -1" ;;
    *) failmsg "terminal wait path wrong: '$out'" ;;
esac

count=$(printf '%s\n' "$err" | grep -c 'waitpid:')
[ "$count" = "1" ] || failmsg "expected exactly one waitpid diagnostic, got $count"
[ "$count" = "1" ] && echo "PASS: exactly one terminal diagnostic"

case "$err" in
    *"waitpid:"*) ;;
    *) failmsg "no waitpid diagnostic reported: '$err'" ;;
esac

[ "$fail" -eq 0 ] || exit 1
echo "PASS: test_waitpolicy.sh ($probe)"
exit 0
