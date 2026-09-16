#!/usr/bin/env bash
# Smoke, parser, REPL, and built-in tests (Phases 2-5).
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
repl() { printf '%s\n' "$@" | "$bin" 2>/dev/null; }
repl_err() { printf '%s\n' "$@" | "$bin" 2>&1 >/dev/null; }

out=$(repl "echo repl-hello")
[ "$out" = "repl-hello" ] || fail "REPL echo output: $out"
echo "PASS: REPL echo works"

out=$(repl "" "echo after-blank")
[ "$out" = "after-blank" ] || fail "blank line produced output: $out"
echo "PASS: blank line ignored"

out=$(repl "no_such_xyz_12345" "echo still-alive")
[ "$out" = "still-alive" ] || fail "resilience failed: $out"
echo "PASS: bad command then echo works"

printf '' | "$bin" 2>/dev/null >/dev/null
[ $? -eq 0 ] || fail "EOF did not exit 0"
echo "PASS: EOF exits 0"

# --- 4. Built-ins ---

# exit [N]
printf 'exit 42\n' | "$bin" 2>/dev/null >/dev/null
[ $? -eq 42 ] || fail "exit 42 -> $? (expected 42)"
echo "PASS: exit 42 -> 42"

# exit without N uses last command status (false -> 1)
printf 'false\nexit\n' | "$bin" 2>/dev/null >/dev/null
[ $? -eq 1 ] || fail "false;exit -> $? (expected 1)"
echo "PASS: exit uses last status"

# help text
help_out=$(repl_err "help")
case "$help_out" in
    *Built-in*help*exit*cd*) echo "PASS: help lists built-ins" ;;
    *) fail "help text lacks built-ins: $help_out" ;;
esac

# cd changes the shell's working directory (parent-process semantics):
# subsequent external commands inherit the new cwd.
tmpdir=$(mktemp -d) || fail "mktemp -d failed"
trap 'rm -rf "$tmpdir"' EXIT
out=$(repl "cd $tmpdir" "pwd")
[ "$out" = "$tmpdir" ] || fail "cd+$tmpdir then pwd gave: $out"
echo "PASS: cd affects subsequent commands (parent process)"

# cd to a nonexistent directory reports an error and keeps the shell alive
err=$(repl_err "cd /no/such/dir_xyz" "echo alive")
case "$err" in
    *"cd: /no/such/dir_xyz"*) echo "PASS: cd error message" ;;
    *) fail "unexpected cd error: $err" ;;
esac
out=$(repl "cd /no/such/dir_xyz" "echo alive")
[ "$out" = "alive" ] || fail "shell died after failed cd: $out"
echo "PASS: failed cd keeps shell alive"

# --- 5. Error paths (one-shot) ---
# non-executable file -> EACCES -> 126
notexec=$(mktemp) || fail "mktemp failed"
trap 'rm -f "$notexec"; rm -rf "$tmpdir"' EXIT
chmod 644 "$notexec"
"$bin" "$notexec" 2>/dev/null >/dev/null
[ $? -eq 126 ] || fail "EACCES exit $? (expected 126)"
echo "PASS: permission denied -> 126"

# unknown command -> 127
"$bin" no_such_cmd_xyz 2>/dev/null >/dev/null
[ $? -eq 127 ] || fail "ENOENT exit $? (expected 127)"
echo "PASS: not found -> 127"

# --- All passed ---
echo "PASS: all tests OK ($bin)"
exit 0