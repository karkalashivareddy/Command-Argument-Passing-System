#!/usr/bin/env bash
# Smoke test for the one-shot execution interface:
#   ./caps echo hello        -> prints "hello", exit 0
#   ./caps no_such_cmd_xyz   -> command-not-found error, exit 127
set -u

bin=${1:?usage: test_smoke.sh <binary>}

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

[ -x "$bin" ] || fail "binary not found or not executable: $bin"

# 1. Valid command with an argument.
out=$(echo "" | "$bin" echo hello) || fail "'echo hello' exited with $?"
[ "$out" = "hello" ] || fail "'echo hello' output was: $out"
echo "PASS: $bin echo hello -> hello"

# 2. Unknown command: error on stderr, exit status 127.
err=$(echo "" | "$bin" no_such_cmd_xyz 2>&1 >/dev/null)
status=$?
[ "$status" -eq 127 ] || fail "'no_such_cmd_xyz' exit $status (expected 127)"
case "$err" in
    *"command not found: no_such_cmd_xyz"*) ;;
    *) fail "unexpected error message: $err" ;;
esac
echo "PASS: unknown command -> command not found, exit 127"

echo "PASS: smoke test OK ($bin)"
exit 0