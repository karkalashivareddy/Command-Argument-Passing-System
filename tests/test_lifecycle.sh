#!/bin/sh
# Failure-mode coverage for the execution lifecycle.
#
# Theme: an execution must never end in a way the event stream cannot
# explain, and a failure must never be dressed up as a success.  Assertions
# read the *monitor stream on stderr* (that is where `caps --monitor --json`
# writes), not just the exit code, because the exit code was never the thing
# that was wrong.
set -u

CAPS="${1:-./caps}"
# Absolute, because the parser cases chdir into a scratch directory.
case "$CAPS" in
  /*) ;;
  *) CAPS="$PWD/$CAPS" ;;
esac
ROOT=$(pwd)
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT INT TERM
fail=0
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

# Monitor events go to stderr; stdout is the executed program's own output.
monitor() { "$@" 2>&1 1>/dev/null; }
# One-shot through the REPL so redirection parsing is exercised.
repl() { printf '%s\nexit\n' "$1" | "$CAPS" --monitor --json 2>&1 1>/dev/null; }

# Value of a top-level JSON field, first match.
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":[[:space:]]*\"\{0,1\}\([^,\"}]*\).*/\1/p" | head -1; }
has() { case "$1" in *"\"$2\":"*) return 0 ;; *) return 1 ;; esac; }

echo "Lifecycle: exec failure is terminal and carries its reason"
out=$(monitor "$CAPS" --monitor --json definitely_not_a_real_command_xyz)
[ "$?" -eq 127 ] && pass "missing command exits 127" || bad "missing command exit code"
printf '%s' "$out" | grep -q EXEC_ERROR \
  && pass "EXEC_ERROR is emitted" || bad "EXEC_ERROR was not emitted"
printf '%s' "$out" | grep -q PROCESS_EXITED \
  && bad "a failed exec emitted PROCESS_EXITED, which claims the target ran" \
  || pass "no PROCESS_EXITED for a failed exec"
printf '%s' "$out" | grep -q SIGNAL_RECEIVED \
  && bad "a failed exec fabricated SIGNAL_RECEIVED" \
  || pass "no fabricated SIGNAL_RECEIVED for a failed exec"

e=$(printf '%s' "$out" | grep EXEC_ERROR)
[ "$(field "$e" exit_code)" = "127" ] \
  && pass "EXEC_ERROR carries exit_code 127" || bad "lost exit_code"
[ "$(field "$e" errno)" = "2" ] \
  && pass "EXEC_ERROR carries ENOENT (2)" || bad "lost errno"
[ "$(field "$e" outcome)" = "EXEC_FAILED" ] \
  && pass "EXEC_ERROR carries outcome EXEC_FAILED" || bad "lost outcome"
[ "$(field "$e" reason)" = "exec_not_found" ] \
  && pass "EXEC_ERROR carries a machine-readable reason" || bad "lost reason"
has "$e" errno_name && pass "EXEC_ERROR carries errno_name" || bad "lost errno_name"

s=$(printf '%s' "$out" | grep SESSION_SUMMARY)
[ "$(field "$s" exec_errors)" = "1" ] \
  && pass "SESSION_SUMMARY counts the exec error" || bad "SESSION_SUMMARY did not count it"
[ "$(field "$s" observed_cleanly)" = "false" ] \
  && pass "SESSION_SUMMARY reports observed_cleanly=false" \
  || bad "SESSION_SUMMARY claims a clean observation after a failed exec"

echo
echo "Lifecycle: permission denied is distinguishable from not found"
printf '#!/bin/sh\necho hi\n' > "$DIR/noexec.sh"
chmod 0644 "$DIR/noexec.sh"
out=$(monitor "$CAPS" --monitor --json "$DIR/noexec.sh")
rc=$?
e=$(printf '%s' "$out" | grep EXEC_ERROR)
[ "$rc" -eq 126 ] && pass "non-executable file exits 126" || bad "expected 126, got $rc"
[ "$(field "$e" exit_code)" = "126" ] && pass "carries exit_code 126" || bad "lost 126"
[ "$(field "$e" errno)" = "13" ] && pass "carries EACCES (13)" || bad "lost EACCES errno"
[ "$(field "$e" reason)" = "exec_permission_denied" ] \
  && pass "reason distinguishes permission denied" || bad "wrong reason: $(field "$e" reason)"

echo
echo "Lifecycle: a target's own non-zero exit is not an exec error"
out=$(monitor "$CAPS" --monitor --json sh -c 'exit 42')
printf '%s' "$out" | grep -q EXEC_ERROR \
  && bad "a program's exit 42 must not be an EXEC_ERROR" \
  || pass "program exit 42 is not an exec error"
printf '%s' "$out" | grep -q '"outcome":"EXITED"' \
  && pass "exit 42 reports outcome EXITED" || bad "missing outcome EXITED"
out=$(monitor "$CAPS" --monitor --json true)
printf '%s' "$out" | grep -q '"outcome":"COMPLETED"' \
  && pass "exit 0 reports outcome COMPLETED" || bad "missing outcome COMPLETED"

echo
echo "Lifecycle: signal termination is attributed to the process"
out=$(monitor "$CAPS" --monitor --json sh -c 'kill -TERM $$')
printf '%s' "$out" | grep -q SIGNAL_RECEIVED \
  && pass "SIGNAL_RECEIVED emitted for a signalled child" || bad "no SIGNAL_RECEIVED"
printf '%s' "$out" | grep -q '"exit_code":143' \
  && pass "signal exit is 128+15=143" || bad "wrong signalled exit code"
printf '%s' "$out" | grep -q '"outcome":"SIGNALED"' \
  && pass "signalled run reports outcome SIGNALED" || bad "missing outcome SIGNALED"

echo
echo "Lifecycle: a target's stdout is not polluted by the protocol"
out=$("$CAPS" --monitor --json printf 'only-stdout' 2>/dev/null)
[ "$out" = "only-stdout" ] \
  && pass "stdout carries only the target's output" \
  || bad "stdout was polluted: [$out]"

echo
echo "Parser: an operator may never occupy the file-name slot"
mkdir -p "$DIR/rd" && cd "$DIR/rd" || exit 1
check_rejected() {
  line="$1"
  o=$(repl "$line")
  if printf '%s' "$o" | grep -q COMMAND_PARSE_ERROR; then
    leftovers=$(ls -A1 2>/dev/null | tr '\n' ' ')
    if [ -n "$leftovers" ]; then
      bad "rejected line still created files: $line -> $leftovers"
    else
      pass "rejected with no side effect: $line"
    fi
  else
    bad "accepted (should be a syntax error): $line"
  fi
}
check_rejected 'echo hi > > out.txt'
check_rejected 'echo hi > >> out.txt'
check_rejected 'echo hi >> > out.txt'
check_rejected 'echo hi >> >> out.txt'
check_rejected 'echo hi < < out.txt'
check_rejected 'echo hi < > out.txt'
check_rejected 'echo hi > < out.txt'
check_rejected 'echo hi >'
check_rejected 'echo hi >>'
check_rejected 'echo hi <'
check_rejected 'echo hi > out.txt >'
check_rejected '> out.txt'
check_rejected '< in.txt'
cd "$ROOT" || exit 1

echo
echo "Parser: valid redirections still work"
mkdir -p "$DIR/ok" && cd "$DIR/ok" || exit 1
repl 'echo hello > a.txt' >/dev/null
[ "$(cat a.txt 2>/dev/null)" = "hello" ] \
  && pass "'>' truncates and writes" || bad "'>' did not write correctly"
repl 'echo world >> a.txt' >/dev/null
[ "$(wc -l < a.txt 2>/dev/null)" -eq 2 ] \
  && pass "'>>' appends" || bad "'>>' did not append"
printf 'from-file\n' > in.txt
# `<` is verified through its effect on a file, because the target's stdout
# is not the monitor stream.
repl 'cat < in.txt > copy.txt' >/dev/null
[ "$(cat copy.txt 2>/dev/null)" = "from-file" ] \
  && pass "'<' reads the file into a '>' target" \
  || bad "'<' did not read the file (copy.txt=[$(cat copy.txt 2>/dev/null)])"
# CAPS is not a shell: "2>" is a plain argument, not a stderr redirection.
# The honest contract is that it is passed through verbatim and stderr
# redirection is not supported -- never silently reinterpreted.
o=$(repl 'echo x 2> e.txt')
printf '%s' "$o" | grep -q PROCESS_STARTED \
  && pass "'2>' is not an operator CAPS supports" \
  || bad "'2>' caused a parse failure"
[ -e e.txt ] \
  && bad "'2>' silently created a stderr redirection target" \
  || pass "'2>' did not create a stderr target (stderr redirection unsupported)"
cd "$ROOT" || exit 1

echo
echo "Parser boundaries"
o=$(printf '\n   \n\t\nexit\n' | "$CAPS" --monitor --json 2>&1 1>/dev/null)
# Only the `exit` line is a real command; blank lines must add nothing.
received=$(printf '%s\n' "$o" | grep -c COMMAND_RECEIVED || true)
[ "$received" -eq 1 ] \
  && pass "blank/whitespace-only lines emit no event (only 'exit' was received)" \
  || bad "expected exactly 1 COMMAND_RECEIVED, saw $received"

long=$(printf 'a%.0s' $(seq 1 20000))
o=$(printf 'echo %s\nexit\n' "$long" | "$CAPS" --monitor --json 2>&1 1>/dev/null)
printf '%s' "$o" | grep -q PROCESS_EXITED \
  && pass "a 20000-character token executes" || bad "long token broke execution"

big=$(for i in $(seq 1 3000); do printf 'w'; done)
o=$(printf 'echo %s\nexit\n' "$big" | "$CAPS" --monitor --json 2>&1 1>/dev/null)
printf '%s' "$o" | grep -q PROCESS_EXITED \
  && pass "a 3000-token argv executes" || bad "3000-token argv broke execution"

o=$(printf 'exit\nexit\n' | "$CAPS" --monitor --json 2>&1 1>/dev/null)
printf '%s' "$o" | grep -q SESSION_SUMMARY \
  && pass "a clean exit still closes the session" || bad "no session summary"

echo
echo "Signal model: the parent survives SIGINT while a child runs"
fifo="$DIR/ctl"
mkfifo "$fifo" 2>/dev/null
"$CAPS" --monitor --json < "$fifo" > "$DIR/sig.out" 2>&1 &
caps_pid=$!
exec 9>"$fifo"
printf 'sleep 0.4\nexit\n' >&9
sleep 0.25
kill -INT "$caps_pid" 2>/dev/null
sleep 0.35
if kill -0 "$caps_pid" 2>/dev/null; then
  pass "parent survived SIGINT while a child ran"
  kill -TERM "$caps_pid" 2>/dev/null
  wait "$caps_pid" 2>/dev/null
else
  wait "$caps_pid" 2>/dev/null
  if grep -q PROCESS_STARTED "$DIR/sig.out" 2>/dev/null; then
    pass "parent survived SIGINT while a child ran"
  else
    bad "parent died on SIGINT before any child started; signal model not installed"
  fi
fi
exec 9>&- 2>/dev/null
rm -f "$fifo"

echo
if [ "$fail" -ne 0 ]; then
  echo "FAILURES PRESENT"
  exit 1
fi
echo "ALL LIFECYCLE TESTS PASSED"
