#!/usr/bin/env bash
# Smoke, parser, and interactive REPL tests (Phases 2-4).
set -u

bin=${1:?usage: test_smoke.sh <binary>}

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

[ -x "$bin" ] || fail "binary not found or not executable: $bin"

# --- 1. Exec smoke (one-shot) ---

out=$(echo "" | "$bin" echo hello) || fail "'echo hello' exited with $?"
[ "$out" = "hello" ] || fail "'echo hello' output was: $out"
echo "PASS: one-shot echo hello -> hello"

# --- 2. Argument parsing (--parse) ---

assert_argc() {
    local input="$1" expect="$2" got
    got=$(printf '%s\n' "$input" | "$bin" --parse 2>/dev/null | grep '^argc = ' | sed 's/argc = //')
    [ "$got" = "$expect" ] || fail "--parse '$input': argc=$got (expected $expect)"
    echo "PASS: --parse '$input' -> argc=$expect"
}

assert_argc "" 0
assert_argc "echo" 1
assert_argc "echo hello world" 3

# --- 3. Interactive REPL ---

repl() {
    printf '%s\n' "$@" | "$bin" 2>/dev/null
}

repl_err() {
    printf '%s\n' "$@" | "$bin" 2>&1 >/dev/null
}

# 3a. echo inside REPL
out=$(repl "echo repl-hello")
[ "$out" = "repl-hello" ] || fail "REPL echo output: $out"
echo "PASS: REPL echo repl-hello -> repl-hello"

# 3b. blank line is silently ignored
out=$(repl "" "echo after-blank")
[ "$out" = "after-blank" ] || fail "blank line produced output: $out"
echo "PASS: blank line ignored"

# 3c. command-not-found then echo still works (resilience)
out=$(repl "no_such_xyz_12345" "echo still-alive")
[ "$out" = "still-alive" ] || fail "resilience failed: $out"
echo "PASS: bad command then echo works"

# 3d. EOF exits 0 (send nothing, expect exit 0)
printf '' | "$bin" 2>/dev/null >/dev/null
[ $? -eq 0 ] || fail "EOF did not exit 0"
echo "PASS: EOF exits 0"

# 3e. exit [N] sets the return code
printf 'exit 42\n' | "$bin" 2>/dev/null >/dev/null
[ $? -eq 42 ] || fail "exit 42 -> $? (expected 42)"
echo "PASS: exit 42 -> 42"

# 3f. help text goes to stderr and contains expected keywords
help_out=$(repl_err "help")
case "$help_out" in
    *Built-in*help*exit*) echo "PASS: help text present" ;;
    *) fail "unexpected help output: $help_out" ;;
esac

# 3g. --help flag works
help_flag=$("$bin" --help 2>&1 >/dev/null)
case "$help_flag" in
    *Usage*parse*command*) echo "PASS: --help flag works" ;;
    *) fail "unexpected --help output: $help_flag" ;;
esac

# --- All passed ---
echo "PASS: all tests OK ($bin)"
exit 0