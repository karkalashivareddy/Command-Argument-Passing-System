#!/usr/bin/env bash
# Error-path tests: invalid commands must never kill the REPL,
# and every error must produce the caps: prefix on stderr.
set -u

bin=${1:?usage: test_errors.sh <binary>}
fail=0

failmsg() {
    echo "FAIL: $*" >&2
    fail=1
}

echo "Errors: unknown command (one-shot)"
err=$(echo '' | "$bin" no_such_cmd_xyz 2>&1 >/dev/null)
status=$?
[ "$status" -eq 127 ] || failmsg "ENOENT status '$status' (want 127)"
case "$err" in
    *"caps: command not found: no_such_cmd_xyz"*) echo "PASS: not-found message" ;;
    *) failmsg "not-found message: '$err'" ;;
esac

echo "Errors: unknown command with a path"
err=$(echo '' | "$bin" /no/such/dir/file 2>&1 >/dev/null)
status=$?
[ "$status" -eq 127 ] || failmsg "path ENOENT status $status (want 127)"
echo "PASS: path ENOENT -> 127"

echo "Errors: non-executable file"
tmpf=$(mktemp)
trap 'rm -f "$tmpf"' EXIT
chmod 644 "$tmpf"
err=$(echo '' | "$bin" "$tmpf" 2>&1 >/dev/null)
status=$?
[ "$status" -eq 126 ] || failmsg "EACCES status $status (want 126)"
case "$err" in
    *"caps: $tmpf: permission denied"*) echo "PASS: EACCES message" ;;
    *) failmsg "EACCES message: '$err'" ;;
esac

echo "Errors: REPL survives an invalid command"
out=$(printf '%s\n' 'no_such_cmd_xyz' 'echo after' | "$bin" 2>/dev/null)
[ "$out" = "after" ] || failmsg "REPL did not survive: '$out'"
echo "PASS: REPL survives invalid command"

echo "Errors: REPL ignores blank lines"
out=$(printf '%s\n' '' '   ' '	' 'echo fin' | "$bin" 2>/dev/null)
[ "$out" = "fin" ] || failmsg "blank lines disturbed output: '$out'"
echo "PASS: blank lines ignored"

echo "Errors: long input line does not crash"
long=$(printf 'y%.0s' $(seq 1 20000))
out=$(printf '%s\n' "$long" 'echo alive' | "$bin" 2>/dev/null)
[ "$out" = "alive" ] || failmsg "long line crashed the REPL: '$out'"
echo "PASS: 20000-char command line handled"

echo "Errors: error prefix on stderr, not stdout (one-shot)"
stdout=$(echo '' | "$bin" no_such_cmd_xyz 2>/dev/null)
[ "$stdout" = "" ] || failmsg "error leaked to stdout: '$stdout'"
echo "PASS: diagnostics go to stderr"

[ "$fail" -eq 0 ] || exit 1
echo "PASS: test_errors.sh ($bin)"
exit 0
