#!/usr/bin/env bash
# Redirection descriptor-ownership regressions
#
# Guarded bug: when a standard descriptor (0/1/2) is already closed,
# open() may return that slot for a redirection file.  A child that then
# runs the destructive pattern
#
#     dup2(fd, target);
#     close(fd);          /* closes target when fd == target! */
#
# with fd == target closes the freshly installed descriptor and breaks
# redirection.  The ownership rule that fixes it: never close a
# descriptor that is already the destination.
#
# Reachability through the REPL: closing stdout (fd 1) and stderr
# (fd 2) before the command is directly reproducible.  Closing stdin
# (fd 0) mid-session is NOT: the REPL reads commands from fd 0, so it is
# always open when redirection files are opened before fork().  Test A
# therefore verifies clean startup/exit with stdin closed; the ownership
# fix covers the unreachable fd-0 case by construction.
set -u

bin=${1:?usage: test_fd_edge.sh <binary>}
fail=0

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

failmsg() {
    echo "FAIL: $*" >&2
    fail=1
}

# run_with_closed_fd <fdnum> <script>
# Run caps inside a sub-shell, executing with the given fd already closed.
# The script is fed on a *different* open fd (stdin for fd 1/2 cases), so
# the REPL runs normally with exactly one standard descriptor missing.
# Results are left in $tmp/{out,err,status}.
run_with_closed_fd() {
    local fdnum="$1" script="$2"
    case "$fdnum" in
    0) ( exec 0<&-;  "$bin" > "$tmp/out" 2> "$tmp/err"; echo $? > "$tmp/status" ) ;;
    1) ( exec 1>&-;  "$bin" < "$script" 2> "$tmp/err"; echo $? > "$tmp/status" ) ;;
    2) ( exec 2>&-;  "$bin" < "$script" > "$tmp/out"; echo $? > "$tmp/status" ) ;;
    esac
}

echo "FD edge: stdin closed at startup exits cleanly (no busy loop)"
run_with_closed_fd 0 ""
[ "$(cat "$tmp/status")" = "0" ] || failmsg "closed-stdin startup status=$(cat "$tmp/status")"
echo "PASS: clean exit with stdin closed"

echo "FD edge: stdout closed, '>' still writes the file"
printf 'echo hello > %s/out_b\n' "$tmp" > "$tmp/script"
printf 'exit 0\n' >> "$tmp/script"
run_with_closed_fd 1 "$tmp/script"
[ "$(cat "$tmp/out_b")" = "hello" ] || failmsg "closed-stdout '>' produced: '$(cat "$tmp/out_b")'"
[ "$(cat "$tmp/status")" = "0" ] || failmsg "closed-stdout '>' status=$(cat "$tmp/status")"
echo "PASS: > works with stdout closed"

echo "FD edge: stdout closed, '>>' still appends"
printf 'first\n' > "$tmp/out_c"
printf 'echo second >> %s/out_c\n' "$tmp" > "$tmp/script"
printf 'exit 0\n' >> "$tmp/script"
run_with_closed_fd 1 "$tmp/script"
[ "$(cat "$tmp/out_c")" = "first
second" ] || failmsg "closed-stdout '>>' produced: '$(cat "$tmp/out_c")'"
[ "$(cat "$tmp/status")" = "0" ] || failmsg "closed-stdout '>>' status=$(cat "$tmp/status")"
echo "PASS: >> works with stdout closed"

echo "FD edge: stdout closed, combined '< in > out' still works"
printf 'from_file\n' > "$tmp/in_d"
printf 'cat < %s/in_d > %s/out_d\n' "$tmp" "$tmp" > "$tmp/script"
printf 'exit 0\n' >> "$tmp/script"
run_with_closed_fd 1 "$tmp/script"
[ "$(cat "$tmp/out_d")" = "from_file" ] || failmsg "closed-stdout '< >' produced: '$(cat "$tmp/out_d")'"
[ "$(cat "$tmp/status")" = "0" ] || failmsg "closed-stdout '< >' status=$(cat "$tmp/status")"
echo "PASS: combined < > works with stdout closed"

echo "FD edge: stderr closed, '>' still writes (no crash, no noise)"
printf 'echo hi > %s/out_e\n' "$tmp" > "$tmp/script"
printf 'exit 0\n' >> "$tmp/script"
run_with_closed_fd 2 "$tmp/script"
[ "$(cat "$tmp/out_e")" = "hi" ] || failmsg "closed-stderr '>' produced: '$(cat "$tmp/out_e")'"
[ "$(cat "$tmp/status")" = "0" ] || failmsg "closed-stderr status=$(cat "$tmp/status")"
echo "PASS: > works with stderr closed"

echo "FD edge: ordinary redirection is unchanged"
printf 'echo hello > %s/out_f\n' "$tmp" > "$tmp/script_f"
printf 'cat < %s/out_f\n' "$tmp" >> "$tmp/script_f"
out=$("$bin" < "$tmp/script_f" 2>/dev/null)
[ "$out" = "hello" ] || failmsg "ordinary 'echo > f / cat < f' produced: '$out'"
printf 'echo world >> %s/out_f\n' "$tmp" > "$tmp/script_g"
printf 'cat < %s/out_f\n' "$tmp" >> "$tmp/script_g"
out=$("$bin" < "$tmp/script_g" 2>/dev/null)
[ "$out" = "hello
world" ] || failmsg "append then read produced: '$out'"
echo "PASS: > >> < continue to behave normally"

echo "FD edge: redirection operators must be whitespace-separated tokens"
printf 'echo hello>%s/out_h\n' "$tmp" > "$tmp/script_h"
printf 'exit 42\n' >> "$tmp/script_h"
out=$("$bin" < "$tmp/script_h" 2>/dev/null)
# "hello>/path" is one literal token; echo prints it, no file is written.
[ "$out" = "hello>$tmp/out_h" ] || failmsg "embedded '>' not literal: '$out'"
[ ! -e "$tmp/out_h" ] || failmsg "embedded '>' unexpectedly created a file"
echo "PASS: 'cmd>file' is a literal token (no shell lexer)"

[ "$fail" -eq 0 ] || exit 1
echo "PASS: test_fd_edge.sh ($bin)"
exit 0
