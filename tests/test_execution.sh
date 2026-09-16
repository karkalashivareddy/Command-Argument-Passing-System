#!/usr/bin/env bash
# Execution tests: external commands run correctly with their arguments.
set -u

bin=${1:?usage: test_execution.sh <binary>}
helper=${2:?usage: test_execution.sh <binary> <helper>}
fail=0

failmsg() {
    echo "FAIL: $*" >&2
    fail=1
}

equal() {
    local label="$1" got="$2" expect="$3"
    if [ "$got" != "$expect" ]; then
        failmsg "$label: got '$got', expected '$expect'"
    else
        echo "PASS: $label"
    fi
}

echo "Execution: one-shot mode"
equal "one-shot echo" "$(echo '' | "$bin" echo one two)" "one two"
equal "one-shot printf options" "$(echo '' | "$bin" printf '%s-%s' a b)" "a-b"
equal "true exits 0" "$("$bin" true; echo $?)" "0"
equal "false exits 1" "$("$bin" false; echo $?)" "1"

echo "Execution: argument passing to a real program"
# helper "print" echoes argv[1..], proving argv reaches main()
out=$(echo '' | "$bin" "$helper" print alpha beta gamma 2>/dev/null)
[ "$out" = "$(printf 'alpha\nbeta\ngamma')" ] || failmsg "helper argv: '$out'"
echo "PASS: helper received argv[]

Execution: REPL mode"
out=$(printf '%s\n' 'echo in-repl' | "$bin" 2>/dev/null)
equal "REPL echo" "$out" "in-repl"

out=$(printf '%s\n' 'printf %s-%s x y' | "$bin" 2>/dev/null)
equal "REPL printf" "$out" "x-y"

out=$(printf '%s\n' "$helper print p1 p2 p3" | "$bin" 2>/dev/null)
equal "REPL helper argv" "$out" "$(printf 'p1\np2\np3')"

echo "Execution: sequential commands in one session"
out=$(printf '%s\n' 'echo first' 'echo second' | "$bin" 2>/dev/null)
equal "sequential echoes" "$out" "$(printf 'first\nsecond')"

echo "Execution: EOF immediately"
out=$(printf '' | "$bin" 2>/dev/null)
[ "$?" -eq 0 ] || failmsg "immediate EOF status"

echo "Execution: --version"
out=$("$bin" --version)
case "$out" in
    *"Command Argument Passing System"*) echo "PASS: --version" ;;
    *) failmsg "--version output: '$out'" ;;
esac

[ "$fail" -eq 0 ] || exit 1
echo "PASS: test_execution.sh ($bin)"
exit 0