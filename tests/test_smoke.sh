#!/usr/bin/env bash
# Smoke test for Phase 1: the binary must exist, run, and exit 0.
set -u

bin=${1:?usage: test_smoke.sh <binary>}

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

[ -x "$bin" ] || fail "binary not found or not executable: $bin"

out=$("$bin") || fail "$bin exited with status $?"

case "$out" in
    *"Command Argument Passing System"*)
        echo "PASS: $bin printed its banner"
        ;;
    *)
        fail "unexpected banner output: $out"
        ;;
esac

echo "PASS: smoke test OK ($bin)"
exit 0