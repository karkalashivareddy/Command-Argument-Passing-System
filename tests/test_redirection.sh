#!/usr/bin/env bash
# Redirection tests: > (truncate), >> (append), < (input).
# Redirection happens in the REPL, which feeds stdin a scripted
# command sequence; each command's stdout is what we assert on.
set -u

bin=${1:?usage: test_redirection.sh <binary>}
fail=0

failmsg() {
    echo "FAIL: $*" >&2
    fail=1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Redir: > truncating output"
out=$(printf '%s\n' "echo alpha > $tmp/o" "cat $tmp/o" | "$bin" 2>/dev/null)
[ "$out" = "alpha" ] || failmsg "'>' produced: '$out'"
echo "PASS: > writes output"

echo "Redir: > overwrites previous content"
printf 'old\nold\n' > "$tmp/o"
out=$(printf '%s\n' "echo new > $tmp/o" "cat $tmp/o" | "$bin" 2>/dev/null)
[ "$out" = "new" ] || failmsg "'>' did not truncate: '$out'"
echo "PASS: > truncates existing file"

echo "Redir: >> appends"
printf 'first\n' > "$tmp/o"
out=$(printf '%s\n' "echo second >> $tmp/o" "cat $tmp/o" | "$bin" 2>/dev/null)
[ "$out" = "first
second" ] || failmsg "'>>' did not append: '$out'"
echo "PASS: >> appends"

echo "Redir: < feeds input"
printf 'from_file\n' > "$tmp/i"
out=$(printf '%s\n' "cat < $tmp/i" | "$bin" 2>/dev/null)
[ "$out" = "from_file" ] || failmsg "'<' produced: '$out'"
echo "PASS: < feeds stdin"

echo "Redir: combined < and >"
printf 'ping\n' > "$tmp/i"
printf '%s\n' "cat < $tmp/i > $tmp/o" "cat $tmp/o" | "$bin" >/dev/null 2>&1
out=$(cat "$tmp/o")
[ "$out" = "ping" ] || failmsg "combined < > produced: '$out'"
echo "PASS: combined < and >"

echo "Redir: operator may precede the command"
out=$(printf '%s\n' "> $tmp/o echo hello" "cat $tmp/o" | "$bin" 2>/dev/null)
[ "$out" = "hello" ] || failmsg "leading operator produced: '$out'"
echo "PASS: operator before command works"

echo "Redir: missing input file does not run the command"
out=$(printf '%s\n' "cat < $tmp/missing" "echo alive" | "$bin" 2>/dev/null)
[ "$out" = "alive" ] || failmsg "missing input file broke REPL: '$out'"
err=$(printf '%s\n' "cat < $tmp/missing" | "$bin" 2>&1 >/dev/null | grep 'caps:')
case "$err" in
    *"No such file or directory"*) echo "PASS: missing input file reported" ;;
    *) failmsg "missing input message: '$err'" ;;
esac

echo "Redir: unwritable target reports error, command not run"
out=$(printf '%s\n' "echo hi > $tmp/no_such_dir/f" "echo alive" | "$bin" 2>/dev/null)
[ "$out" = "alive" ] || failmsg "unwritable target broke REPL: '$out'"
err=$(printf '%s\n' "echo hi > $tmp/no_such_dir/f" | "$bin" 2>&1 >/dev/null)
case "$err" in
    *"caps:"*) echo "PASS: unwritable target reported" ;;
    *) failmsg "unwritable target message: '$err'" ;;
esac

echo "Redir: operator without a command is a syntax error"
out=$(printf '%s\n' "> $tmp/o" | "$bin" 2>&1 >/dev/null)
case "$out" in
    *"syntax error"*) echo "PASS: nothing to redirect is rejected" ;;
    *) failmsg "no-command redirection: '$out'" ;;
esac

echo "Redir: operator without a file is a syntax error"
out=$(printf '%s\n' "echo hi >" | "$bin" 2>&1 >/dev/null)
case "$out" in
    *"syntax error"*) echo "PASS: missing target is rejected" ;;
    *) failmsg "missing-target message: '$out'" ;;
esac

echo "Redir: built-ins reject redirection"
err=$(printf '%s\n' "help > $tmp/o" "echo alive" | "$bin" 2>&1 >/dev/null)
case "$err" in
    *"not supported"*) echo "PASS: built-in + redirection rejected" ;;
    *) failmsg "built-in redirection message: '$err'" ;;
esac
out=$(printf '%s\n' "help > $tmp/o" "echo alive" | "$bin" 2>/dev/null)
[ "$out" = "alive" ] || failmsg "built-in redirection broke REPL: '$out'"
echo "PASS: REPL survives rejected built-in redirection"

[ "$fail" -eq 0 ] || exit 1
echo "PASS: test_redirection.sh ($bin)"
exit 0
