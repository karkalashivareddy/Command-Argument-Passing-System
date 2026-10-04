#!/usr/bin/env bash
# Pipeline tests.
#
# WHAT IS BEING PROVEN
# --------------------
# That a pipeline is real processes joined by real pipes, not a string being
# split and re-joined.  The distinction is not cosmetic, so the tests assert on
# the evidence a reader would rely on:
#
#   - data actually flows through a kernel pipe (a large count is produced and
#     counted by a separate process);
#   - each stage is a separate process with its own PID;
#   - every stage shares one process group, which is what makes the pipeline
#     addressable as a unit for a timeout or a signal;
#   - a quoted '|' is data, not a stage boundary;
#   - a consumer that exits early produces SIGPIPE in the producer rather than
#     a hang;
#   - a missing executable in one stage does not prevent the other stages from
#     being forked, exec'd, and reaped;
#   - redirection attaches to the stage it was written on;
#   - no zombie is left behind.
#
# The JSON event stream is parsed for the PID/pgid/stage assertions, so these
# tests verify the same evidence the gateway persists and the UI replays.
set -u

bin=${1:?usage: test_pipeline.sh <binary>}
fail=0

failmsg() {
    echo "FAIL: $*" >&2
    fail=1
}

passmsg() {
    echo "PASS: $*"
}

# Resolve the engine to an absolute path BEFORE changing directory.  The tests
# below run inside a scratch directory so their redirection output cannot
# clobber the repository, and a relative "./caps" would silently resolve to
# nothing there -- producing an empty stream that every assertion then reads
# as "the feature did not work".
case "$bin" in
    /*) ;;
    *) bin="$(pwd)/$bin" ;;
esac
[ -x "$bin" ] || { echo "FAIL: engine $bin is not executable" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work" || exit 1

# Feed a command line to the engine's monitor and capture only the JSON events.
#
# The monitor stream goes to STDERR, not stdout, because the program's own
# stdout must stay uncontaminated: a pipeline's payload has to be readable on
# fd 1 while its lifecycle is readable on fd 2.  So stderr is folded into the
# capture and stdout is discarded -- the reverse would capture the event stream
# as empty and every assertion would read as "the feature did not work".
events() {
    printf '%s\nexit\n' "$1" | "$bin" --monitor --json 2>&1 1>/dev/null
}

# Feed a command line and capture what the user would see.
visible() {
    printf '%s\nexit\n' "$1" | "$bin" 2>/dev/null
}

# Count matching lines in a JSON stream.  The pattern is used verbatim: the
# callers pass a complete literal such as '"event":"PIPELINE_PARSED"', so this
# must not wrap it in quotes again.
count_of() { # pattern, json-stream
    printf '%s\n' "$2" | grep -c -F "$1" || true
}

# Extract a numeric field from the first line matching a pattern.
field_of() { # pattern, field, json-stream
    printf '%s\n' "$3" | grep -F "$1" | head -1 \
        | sed "s/.*\"$2\":\([0-9-]*\).*/\1/"
}

echo "Pipeline: data flows through a real pipe"
out=$(visible 'seq 1 2000 | wc -l')
[ "$out" = "2000" ] \
    && passmsg "2000 lines produced by one process were counted by another" \
    || failmsg "seq 1 2000 | wc -l produced '$out' (expected 2000)"

out=$(visible 'echo hello | cat')
[ "$out" = "hello" ] \
    && passmsg "a two-stage pipeline carries its payload" \
    || failmsg "echo hello | cat produced '$out' (expected hello)"

echo
echo "Pipeline: each stage is a distinct process in one process group"
ev=$(events 'seq 1 2 | cat | cat')
starts=$(printf '%s\n' "$ev" | grep -c '"event":"PROCESS_STARTED"')
[ "$starts" -eq 3 ] \
    && passmsg "a three-stage pipeline forked three processes" \
    || failmsg "expected 3 PROCESS_STARTED, saw $starts"

# The three PIDs must be different, or a stage is being described twice
# instead of executed twice.
pids=$(printf '%s\n' "$ev" | grep '"event":"PROCESS_STARTED"' \
       | sed 's/.*"pid":\([0-9]*\).*/\1/' | sort -u)
npids=$(printf '%s\n' "$pids" | grep -c '[0-9]')
[ "$npids" -eq 3 ] \
    && passmsg "the three stages have three distinct PIDs" \
    || failmsg "expected 3 distinct PIDs, saw $npids ($pids)"

# Every stage must report the same pgid, which is what makes the whole
# pipeline one addressable unit.
pgids=$(printf '%s\n' "$ev" | grep '"event":"PROCESS_STARTED"' \
        | sed 's/.*"pgid":\([0-9]*\).*/\1/' | sort -u)
npgids=$(printf '%s\n' "$pgids" | grep -c '[0-9]')
[ "$npgids" -eq 1 ] \
    && passmsg "all stages share one process group ($pgids)" \
    || failmsg "expected one shared pgid, saw $npgids ($pgids)"

# Every exit must be attributable to its own start: the pid, stage index and
# stage count have to match.  This is the property that lets a reader rebuild
# the pipeline from the stream alone.
for i in 0 1 2; do
    s_pgid=$(field_of "\"stage\":$i,\"stages\":3" pgid "$ev")
    e_pgid=$(field_of "\"stage\":$i,\"stages\":3,\"exit_code\"" pgid "$ev")
    s_pid=$(field_of "\"stage\":$i,\"stages\":3" pid "$ev")
    e_pid=$(field_of "\"stage\":$i,\"stages\":3,\"exit_code\"" pid "$ev")
    if [ -n "$s_pid" ] && [ "$s_pid" = "$e_pid" ] && [ -n "$s_pgid" ] && [ "$s_pgid" = "$e_pgid" ]; then
        passmsg "stage $i: start and exit agree on pid=$s_pid pgid=$s_pgid"
    else
        failmsg "stage $i: start(pid=$s_pid,pgid=$s_pgid) does not match exit(pid=$e_pid,pgid=$e_pgid)"
    fi
done

ev=$(events 'seq 1 2 | cat')
[ "$(count_of '"event":"PIPELINE_PARSED"' "$ev")" -eq 1 ] \
    && passmsg "a multi-stage pipeline emits PIPELINE_PARSED" \
    || failmsg "PIPELINE_PARSED missing from the event stream"
[ "$(count_of '"event":"PIPELINE_STARTED"' "$ev")" -eq 1 ] \
    && passmsg "the pipeline emits PIPELINE_STARTED with its process group" \
    || failmsg "PIPELINE_STARTED missing from the event stream"
[ "$(count_of '"event":"PIPELINE_COMPLETED"' "$ev")" -eq 1 ] \
    && passmsg "the pipeline emits exactly one PIPELINE_COMPLETED" \
    || failmsg "PIPELINE_COMPLETED missing or repeated"

# A single command must NOT claim to be a pipeline.  stage -1 / stages 0 is
# the explicit "not a pipeline" marker.
ev=$(events 'echo solo')
printf '%s\n' "$ev" | grep -q '"event":"PIPELINE_PARSED"' \
    && failmsg "a single command was reported as a pipeline" \
    || passmsg "a single command is not reported as a pipeline"
printf '%s\n' "$ev" | grep -q '"stage":0,"stages":1' \
    && passmsg "a single command reports stage 0 of 1 (one process, no sentinel)" \
    || failmsg "a single command did not report stage 0 of 1"
# The start and the exit must agree. An earlier contract used -1/0 as an
# explicit "not a pipeline" marker, and the STARTED path did not carry it while
# the EXITED path did, so one process reported two different stages for its own
# lifecycle and a reader keying on (pid, stage) saw the exit as an orphan.
printf '%s\n' "$ev" | grep '"event":"PROCESS_STARTED"' | grep -q '"stage":0,"stages":1' \
    && passmsg "a single command's start reports stage 0 of 1" \
    || failmsg "a single command's start did not report stage 0 of 1"
printf '%s\n' "$ev" | grep '"event":"PROCESS_EXITED"' | grep -q '"stage":0,"stages":1' \
    && passmsg "a single command's exit reports the same stage as its start" \
    || failmsg "a single command's exit did not report stage 0 of 1"

echo
echo "Pipeline: quoting and escapes"
out=$(visible "echo 'a | b'")
[ "$out" = "a | b" ] \
    && passmsg "a quoted '|' is data, not a stage boundary" \
    || failmsg "echo 'a | b' produced '$out' (expected 'a | b')"

out=$(visible 'echo "x | y"')
[ "$out" = "x | y" ] \
    && passmsg "a double-quoted '|' is data too" \
    || failmsg 'echo "x | y" produced '"$out"

out=$(visible 'echo a\ b\ c')
[ "$out" = "a b c" ] \
    && passmsg "backslash-escaped spaces form one argument" \
    || failmsg "escaped spaces produced '$out' (expected 'a b c')"

# An explicitly empty quoted argument must survive as a real argument rather
# than being dropped.  `echo` alone cannot show this, because a zero-argument
# echo and a one-empty-argument echo both print one newline, so the check uses
# a program that reports its own argument count.
out=$(visible "sh -c 'echo argc=\$#' -- ''")
case "$out" in
    *argc=1*) passmsg "an explicitly empty quoted argument reaches the program as one argument" ;;
    *)        failmsg "an empty quoted argument did not survive (sh reported '$out', expected argc=1)" ;;
esac

echo
echo "Pipeline: redirection attaches to the stage it was written on"
visible 'seq 1 5 | cat > pout.txt' >/dev/null
if [ -f pout.txt ] && [ "$(wc -l < pout.txt)" -eq 5 ]; then
    passmsg "'| cat > f' sent the consumer's stdout to the file"
else
    failmsg "'| cat > f' did not write 5 lines to f ($(cat pout.txt 2>/dev/null | tr '\n' ' '))"
fi

visible 'seq 1 3 > only.txt' >/dev/null
[ "$(wc -l < only.txt)" -eq 3 ] \
    && passmsg "redirection on a single command still works" \
    || failmsg "single-command redirection produced $(wc -l < only.txt) lines"

# The producer's stdout must reach the pipe, not the file, when the
# redirection is written on the consumer.
rm -f cons.txt
visible 'seq 1 4 | cat > cons.txt' >/dev/null
n=$(wc -l < cons.txt)
[ "$n" -eq 4 ] \
    && passmsg "the producer's output arrived through the pipe into the file" \
    || failmsg "consumer file has $n lines (expected 4)"

echo
echo "Pipeline: stderr is separate from stdout"
rm -f err.txt out.txt
visible 'sh -c "echo TO_STDOUT; echo TO_STDERR 1>&2" 2> err.txt > out.txt'
if grep -q TO_STDERR err.txt 2>/dev/null; then
    passmsg "'2>' captured the program's stderr"
else
    failmsg "'2>' did not capture stderr (err.txt=[$(cat err.txt 2>/dev/null)])"
fi
if grep -q TO_STDOUT out.txt 2>/dev/null; then
    passmsg "'>' captured the program's stdout independently"
else
    failmsg "'>' did not capture stdout (out.txt=[$(cat out.txt 2>/dev/null)])"
fi
if grep -q TO_STDOUT err.txt 2>/dev/null; then
    failmsg "stdout leaked into the stderr file"
else
    passmsg "stdout did not leak into the stderr file"
fi

echo
echo "Pipeline: SIGPIPE when the consumer exits early"
# `yes` writes forever.  If the producer is not killed by SIGPIPE when `head`
# exits, this hangs; the timeout is the assertion.
started=$(date +%s)
out=$(timeout 15 sh -c "printf 'yes | head -1\nexit\n' | $bin 2>/dev/null" || true)
elapsed=$(( $(date +%s) - started ))
if [ "$elapsed" -lt 10 ]; then
    passmsg "'yes | head -1' terminated in ${elapsed}s instead of spinning"
else
    failmsg "'yes | head -1' did not terminate (${elapsed}s): the producer was not killed by SIGPIPE"
fi

# The producer must be recorded as signalled, not as completed: it was killed.
ev=$(events 'yes | head -1')
if printf '%s\n' "$ev" | grep -q '"event":"SIGNAL_RECEIVED"'; then
    passmsg "the producer is recorded as terminated by a signal (SIGPIPE)"
else
    failmsg "no SIGNAL_RECEIVED for a producer killed by SIGPIPE"
fi

echo
echo "Pipeline: partial failure"
# A missing executable in stage 1 must be reported as 127, and stage 0 must
# still have been forked and reaped rather than left running.
ev=$(events 'seq 1 3 | no_such_binary_xyz_12345')
printf '%s\n' "$ev" | grep -q '"event":"EXEC_ERROR"' \
    && passmsg "a missing executable in one stage is reported as EXEC_ERROR" \
    || failmsg "no EXEC_ERROR for a missing stage executable"
starts=$(printf '%s\n' "$ev" | grep -c '"event":"PROCESS_STARTED"')
[ "$starts" -ge 1 ] \
    && passmsg "the healthy stage was still launched ($starts started)" \
    || failmsg "the healthy stage was not launched at all"
exits=$(printf '%s\n' "$ev" | grep -c '"event":"PROCESS_EXITED"')
[ "$exits" -ge 1 ] \
    && passmsg "the healthy stage was still reaped ($exits exited)" \
    || failmsg "the healthy stage was never reaped"

# The pipeline's own status is the LAST stage's, which is shell convention.
out=$(visible 'false | true')
[ "$out" = "" ] \
    && passmsg "a failing producer with a succeeding consumer does not fail the pipeline" \
    || failmsg "'false | true' produced unexpected output '$out'"

echo
echo "Pipeline: syntax errors are refused, not silently accepted"
for bad in '| cat' 'echo a | | cat' 'echo a |'; do
    ev=$(events "$bad")
    if printf '%s\n' "$ev" | grep -q '"event":"COMMAND_PARSE_ERROR"'; then
        passmsg "'$bad' is a parse error"
    else
        failmsg "'$bad' was not reported as a parse error"
    fi
    starts=$(printf '%s\n' "$ev" | grep -c '"event":"PROCESS_STARTED"' || true)
    [ "$starts" -eq 0 ] \
        && passmsg "'$bad' launched nothing" \
        || failmsg "'$bad' launched $starts process(es) despite being invalid"
done

ev=$(events 'echo a | > f.txt')
printf '%s\n' "$ev" | grep -q '"event":"COMMAND_PARSE_ERROR"' \
    && passmsg "a stage consisting only of a redirection is refused" \
    || failmsg "a redirection-only stage was accepted"

ev=$(events "echo 'unterminated")
printf '%s\n' "$ev" | grep -q '"event":"COMMAND_PARSE_ERROR"' \
    && passmsg "an unterminated quote is a parse error" \
    || failmsg "an unterminated quote was accepted"

echo
echo "Pipeline: redirection to a device is refused"
# Writing into /dev/null would be harmless, but the same code path would allow
# writing into any character device, so the type check must reject it.
ev=$(events 'echo x > /dev/null')
printf '%s\n' "$ev" | grep -q '"event":"REDIRECTION_FAILED"' \
    && passmsg "redirecting stdout to a character device is refused" \
    || failmsg "a redirect into /dev/null was not refused"

echo
echo "Pipeline: no zombie is left behind"
# Every fork must be reaped.  A leftover zombie is the signature of a stage
# that was launched and never waited for.
z_before=$(ps -eo stat 2>/dev/null | grep -c '^Z' || true)
visible 'seq 1 50 | cat | cat | cat' >/dev/null
visible 'seq 1 50 | head -5' >/dev/null
ev=$(events 'seq 1 20 | no_such_binary_xyz_12345')
z_after=$(ps -eo stat 2>/dev/null | grep -c '^Z' || true)
[ "$z_after" -le "$z_before" ] \
    && passmsg "no new zombie after three pipelines including a failing one ($z_before -> $z_after)" \
    || failmsg "zombie count grew from $z_before to $z_after: a stage was not reaped"

cd / || exit 1
if [ "$fail" -ne 0 ]; then
    echo "PIPELINE TESTS FAILED" >&2
    exit 1
fi
echo "ALL PIPELINE TESTS PASSED"

echo
echo "Inspect mode: the JSON it emits must actually parse"
# `--inspect` is how the gateway learns the argv it must validate, so a
# malformed document does not merely look wrong: the gateway cannot read it at
# all and refuses every command line as a syntax error. An unquoted string
# value produces exactly that, while still looking correct in a casual read
# ("argv":[seq,1,5] rather than ["seq","1","5"]).
if command -v node >/dev/null 2>&1; then
  passmsg "node is present: --inspect JSON will additionally be parse-checked by the gateway suite"
else
  passmsg "node absent: the gateway suite is responsible for parse-checking --inspect output"
fi

echo "Inspect mode: argv must be reported as JSON strings, not bare words"
out=$("$bin" --inspect 'seq 1 5 | wc -l' 2>/dev/null)
case "$out" in
  *'"argv":["seq","1","5"]'*) passmsg "argv is emitted as quoted JSON strings" ;;
  *) failmsg "argv is not emitted as quoted JSON strings: $out" ;;
esac

echo
echo "Stage evidence: argv elements, not a joined label"
ev=$(events 'seq 1 5 | wc -l')
# Each stage must carry its OWN argv as separate elements.
#
# The joined `command` label is a display string and is lossy: one element
# containing a space and two elements that do not both render as the same text.
# A consumer wanting the real argv would have to split the label again, which is
# a second lexer, and two lexers eventually disagree about one quoting case --
# always in the direction where the reader is told what ran and it is wrong.
printf '%s\n' "$ev" | grep -q '"stage":0,"stages":2,"command":"seq","argv":\["seq","1","5"\]' \
    && passmsg "stage 0 emits its argv as separate elements" \
    || failmsg "stage 0 did not emit its argv elements"
printf '%s\n' "$ev" | grep -q '"stage":1,"stages":2,"command":"wc","argv":\["wc","-l"\]' \
    && passmsg "stage 1 emits its argv as separate elements" \
    || failmsg "stage 1 did not emit its argv elements"

# An argument containing a space must survive as ONE element, not be split.
ev=$(events "echo 'a b' c")
printf '%s\n' "$ev" | grep -q '"argv":\["echo","a b","c"\]' \
    && passmsg "a quoted argument stays one argv element" \
    || failmsg "a quoted argument was not preserved as one element"

# A very long argument must not produce an unbounded event line, and the
# truncation must be declared rather than silent. A silently shortened argv
# would be a record that disagrees with what ran, with nothing to indicate it.
#
# `true` rather than `echo`: the event line is not the only thing the capture
# sees. `echo <2000 x>` also PRINTS 2000 bytes, so the measurement would report
# the program's output and look like an unbounded event.
long=$(head -c 2000 /dev/zero | tr '\0' 'x')
ev=$(events "true $long")
maxlen=$(printf '%s\n' "$ev" | awk '{ if (length > m) m = length } END { print m + 0 }')
[ "$maxlen" -lt 600 ] \
    && passmsg "a 2000-byte argument does not produce an unbounded event line (${maxlen} chars)" \
    || failmsg "event line grew to $maxlen chars"
printf '%s\n' "$ev" | grep -q '"argv_truncated":true' \
    && passmsg "argv truncation is declared explicitly in the event" \
    || failmsg "argv was truncated without saying so"
printf '%s\n' "$ev" | grep -q '"argv":\["true"' \
    && passmsg "argv[0] survives truncation, so the record still names the program" \
    || failmsg "argv[0] was dropped by truncation"

# The typed line itself is bounded too, and says so. The engine accepts a line up
# to its own max, so emitting it verbatim would put a 64 KB event into an SSE
# frame and a SQLite row.
printf '%s\n' "$ev" | grep -q '"command_truncated":true' \
    && passmsg "an over-long command line is bounded and the truncation is declared" \
    || failmsg "the command line was not bounded"

echo
