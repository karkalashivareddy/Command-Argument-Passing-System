#!/bin/sh
# waitpid() failure must not make an execution disappear.
#
# The probe links the execution objects directly so it can call
# process_wait_child() on a pid that is not its child, which is the only
# reachable permanent failure (ECHILD).  This asserts the *contract*:
#   - the function reports failure,
#   - it reports it exactly once,
#   - it never fabricates a status for a child it did not reap.
set -u

PROBE="${1:-./build/wait_probe}"
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
fail=0
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

out=$("$PROBE" 2>&1)
status=$?

[ "$status" -eq 0 ] && pass "probe ran" || bad "probe exited $status"

printf '%s' "$out" | grep -q 'normal status=' \
  && pass "a real child is reaped and its status decoded" \
  || bad "normal wait path regressed"

printf '%s' "$out" | grep -q 'terminal rc=-1' \
  && pass "a permanent waitpid() failure is reported as failure" \
  || bad "terminal waitpid failure not reported"

count=$(printf '%s\n' "$out" | grep -c 'waitpid:')
[ "$count" -eq 1 ] \
  && pass "the terminal failure is reported exactly once (saw $count)" \
  || bad "terminal failure reported $count times, expected exactly 1"

printf '%s' "$out" | grep -q 'No child processes' \
  && pass "the real errno is preserved in the diagnostic" \
  || bad "errno reason lost"

if [ "$fail" -ne 0 ]; then
  echo "FAILURES PRESENT"
  exit 1
fi
echo "ALL WAIT-FAILURE TESTS PASSED"
