#!/usr/bin/env bash
# Parser tests: tokenization of command lines into argv[].
# Invokes the --parse debug mode of caps, which prints the built argv.
set -u

bin=${1:?usage: test_parser.sh <binary>}
fail=0

failmsg() {
    echo "FAIL: $*" >&2
    fail=1
}

# parse_line <input> -> prints "argc=N" then "argv[i]=..." lines
parse_line() {
    printf '%s\n' "$1" | "$bin" --parse 2>/dev/null
}

# expect_argv <input> <n> <token...>
expect_argv() {
    local input="$1" expect_n="$2"
    shift 2
    local out
    out=$(parse_line "$input")
    local got_n
    got_n=$(echo "$out" | sed -n 's/^argc = //p')

    if [ "$got_n" != "$expect_n" ]; then
        failmsg "argc for '$input' = '$got_n', expected '$expect_n'"
        return
    fi

    local i=0
    for expected in "$@"; do
        local got
        got=$(echo "$out" | sed -n "s/^argv\[$i\] = //p")
        [ "$got" = "$expected" ] || failmsg "token $i of '$input' = '$got', expected '$expected'"
        i=$((i + 1))
    done

    # argv[expect_n] must be the NULL terminator
    local term
    term=$(echo "$out" | sed -n "s/^argv\[$expect_n\] = //p")
    [ "$term" = "(null)" ] || failmsg "argv[$expect_n] of '$input' is '$term', expected NULL"
}

echo "Parser: empty and whitespace-only input"
expect_argv "" 0
expect_argv "   " 0
expect_argv "		" 0

echo "Parser: single command"
expect_argv "ls" 1 "ls"
expect_argv "   ls   " 1 "ls"

echo "Parser: command + arguments"
expect_argv "echo hello" 2 "echo" "hello"
expect_argv "ls -la /tmp" 3 "ls" "-la" "/tmp"
expect_argv "echo one two three" 4 "echo" "one" "two" "three"

echo "Parser: whitespace handling (leading/trailing/repeated/tabs)"
expect_argv "  echo   hi   there  " 3 "echo" "hi" "there"
expect_argv "echo	hi	there" 3 "echo" "hi" "there"
expect_argv "   echo		 hi" 2 "echo" "hi"

echo "Parser: tokens are passed literally (no quoting/expansion)"
expect_argv 'echo "a b"' 3 'echo' '"a' 'b"'
expect_argv 'printf $HOME *.c' 3 'printf' '$HOME' '*.c'

echo "Parser: unusual tokens"
expect_argv "--flag value" 2 "--flag" "value"
expect_argv "exit 0" 2 "exit" "0"

echo "Parser: long single token (no fixed-size buffer crash)"
long=$(printf 'x%.0s' $(seq 1 100000))
out=$(parse_line "$long")
got_n=$(echo "$out" | sed -n 's/^argc = //p')
[ "$got_n" = "1" ] || failmsg "long token argc='$got_n'"
term=$(echo "$out" | sed -n 's/^argv\[1\] = //p')
[ "$term" = "(null)" ] || failmsg "long token terminator is '$term'"

[ "$fail" -eq 0 ] || exit 1
echo "PASS: test_parser.sh ($bin)"
exit 0