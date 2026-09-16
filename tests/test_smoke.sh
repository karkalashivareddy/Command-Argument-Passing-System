#!/usr/bin/env bash
# Smoke and argument-parsing tests for Phase 3.
set -u

bin=${1:?usage: test_smoke.sh <binary>}

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

[ -x "$bin" ] || fail "binary not found or not executable: $bin"

# --- Exec smoke tests (from Phase 2) ---

out=$(echo "" | "$bin" echo hello) || fail "'echo hello' exited with $?"
[ "$out" = "hello" ] || fail "'echo hello' output was: $out"
echo "PASS: echo hello -> hello"

err=$(echo "" | "$bin" no_such_cmd_xyz 2>&1 >/dev/null)
status=$?
[ "$status" -eq 127 ] || fail "'no_such_cmd_xyz' exit $status (expected 127)"
echo "PASS: unknown command -> exit 127"

# --- Argument vector parsing (--parse) ---

parse_out() {
    # Pipe a line into --parse and strip the banner line.
    printf '%s\n' "$1" | "$bin" --parse 2>/dev/null | grep '^argv\['
}

# helper: assert token count
assert_argc() {
    local input="$1"
    local expect="$2"
    local out
    out=$(printf '%s\n' "$input" | "$bin" --parse 2>/dev/null)
    local got
    got=$(echo "$out" | grep '^argc = ' | sed 's/argc = //')
    [ "$got" = "$expect" ] || fail "--parse '$input': argc=$got (expected $expect)"
    echo "PASS: --parse '$input' -> argc=$expect"
}

assert_argc "" 0
assert_argc "   " 0
assert_argc "echo" 1
assert_argc "echo hello" 2
assert_argc "echo   hello   world" 3
assert_argc "  ls -la /tmp  " 3

assert_tokens() {
    local input="$1"
    shift
    local expected=("$@")
    local tokens
    tokens=$(parse_out "$input")
    local idx=0
    for exp in "${expected[@]}"; do
        local got
        got=$(echo "$tokens" | grep "argv\[$idx\] =" | sed "s/argv\[$idx\] = //")
        [ "$got" = "$exp" ] || fail "token $idx: got '$got', expected '$exp'"
        idx=$((idx + 1))
    done
}

assert_tokens "echo hello" "echo" "hello"
assert_tokens "ls -la /tmp" "ls" "-la" "/tmp"
assert_tokens "  echo  hi  there  " "echo" "hi" "there"
assert_tokens "single" "single"

# argv[argc] must be NULL
last_line=$(parse_out "echo hi" | tail -1)
echo "$last_line" | grep -q 'argv\[2\] = (null)' || fail "argv[argc] not NULL: $last_line"
echo "PASS: argv[argc] == NULL"

# --- All passed ---

echo "PASS: smoke + parser tests OK ($bin)"
exit 0