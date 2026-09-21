#!/usr/bin/env bash
# Real-time execution monitor tests.
#
# Deterministic by design: we assert event presence, event ordering,
# numeric PIDs, correct exit/signal codes, command names, and non-negative
# durations — never exact timestamps or wall-clock values.
set -u

bin=${1:?usage: test_monitor.sh <binary>}
helper=${2:?usage: test_monitor.sh <binary> <helper>}
fail=0

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

failmsg() {
    echo "FAIL: $*" >&2
    fail=1
}

# json_events <args...>: one-shot monitor; print JSON event lines (stderr).
json_events() {
    echo '' | "$bin" --monitor --json "$@" 2>&1 >/dev/null | grep '^{'
}

# json_events_repl <script>: REPL monitor; print JSON event lines (stderr).
json_events_repl() {
    "$bin" --monitor --json < "$1" 2>&1 >/dev/null | grep '^{'
}

# event_names <events>: extract the ordered event-name sequence.
event_names() {
    printf '%s\n' "$1" | sed -n 's/.*"event":"\([^"]*\)".*/\1/p'
}

# assert_sequence <name> <events> <expected "A B C ...">
assert_sequence() {
    local name="$1" events="$2" want="$3" got
    got=$(event_names "$events" | tr '\n' ' ' | sed 's/ $//')
    if [ -z "$got" ]; then
        failmsg "$name: no events captured: '$events'"
        return
    fi
    [ "$got" = "$want" ] || failmsg "$name: sequence '$got' (want '$want')"
    echo "PASS: $name"
}

echo "Monitor: successful command lifecycle (one-shot)"
events=$(json_events "$helper" exit 42)
assert_sequence "exit-42 order" "$events" \
    "COMMAND_RECEIVED PARSED PROCESS_STARTED PROCESS_EXITED SESSION_SUMMARY"
[ "$(event_names "$events" | grep -c '^PROCESS_EXITED$')" = "1" ] ||
    failmsg "expected exactly one PROCESS_EXITED"
printf '%s\n' "$events" | grep -qF '"event":"PROCESS_EXITED"' || failmsg "no PROCESS_EXITED event"
printf '%s\n' "$events" | grep -F '"event":"PROCESS_EXITED"' | grep -qF '"exit_code":42' ||
    failmsg "exit_code 42 not reported"
printf '%s\n' "$events" | grep -F '"event":"PROCESS_EXITED"' | grep -Eq '"duration_ms":[0-9]+' ||
    failmsg "duration_ms missing or negative"
printf '%s\n' "$events" | grep -Eq '"pid":[0-9]+' || failmsg "pid missing or non-numeric"
printf '%s\n' "$events" | grep -Fq '"command":"'"$helper"' exit 42"' ||
    failmsg "command string not reported"
echo "PASS: exit code, pid, duration, command fields"

echo "Monitor: exec failure lifecycle (command not found)"
events=$(json_events no_such_cmd_zzz)
assert_sequence "exec-error order" "$events" \
    "COMMAND_RECEIVED PARSED PROCESS_STARTED EXEC_ERROR SESSION_SUMMARY"
printf '%s\n' "$events" | grep -Fq '"event":"EXEC_ERROR"' || failmsg "no EXEC_ERROR event"
printf '%s\n' "$events" | grep -Fq '"command":"no_such_cmd_zzz"' || failmsg "EXEC_ERROR command wrong"
err=$(echo '' | "$bin" --monitor --json no_such_cmd_zzz 2>&1 >/dev/null)
case "$err" in
    *"caps: command not found: no_such_cmd_zzz"*) echo "PASS: real diagnostic still reported" ;;
    *) failmsg "missing not-found diagnostic: '$err'" ;;
esac

echo "Monitor: signal lifecycle (child killed by SIGKILL)"
events=$(json_events "$helper" signal 9)
assert_sequence "signal order" "$events" \
    "COMMAND_RECEIVED PARSED PROCESS_STARTED SIGNAL_RECEIVED PROCESS_EXITED SESSION_SUMMARY"
printf '%s\n' "$events" | grep -Fq '"event":"SIGNAL_RECEIVED"' || failmsg "no SIGNAL_RECEIVED"
printf '%s\n' "$events" | grep -F '"event":"SIGNAL_RECEIVED"' | grep -qF '"signal":9' ||
    failmsg "signal number 9 not reported"
printf '%s\n' "$events" | grep -F '"event":"PROCESS_EXITED"' | grep -qF '"exit_code":137' ||
    failmsg "128+9 = 137 not reported"

echo "Monitor: REPL session summary counts are accumulated from events"
# echo one  -> succeeds; false -> fails; exit 7 is a built-in (no process
# events, only COMMAND_RECEIVED + PARSED) and ends the session.
printf '%s\n' 'echo one' 'false' 'exit 7' > "$tmp/repl"
repl_events=$(json_events_repl "$tmp/repl")
assert_sequence "repl order" "$repl_events" \
    "COMMAND_RECEIVED PARSED PROCESS_STARTED PROCESS_EXITED COMMAND_RECEIVED PARSED PROCESS_STARTED PROCESS_EXITED COMMAND_RECEIVED PARSED SESSION_SUMMARY"
printf '%s\n' "$repl_events" | grep -Fq '"commands":2' || failmsg "summary commands != 2"
printf '%s\n' "$repl_events" | grep -Fq '"succeeded":1' || failmsg "summary succeeded != 1"
printf '%s\n' "$repl_events" | grep -Fq '"failed":1' || failmsg "summary failed != 1"
status=$("$bin" --monitor --json < "$tmp/repl" >/dev/null 2>/dev/null; echo $?)
[ "$status" = "7" ] || failmsg "REPL exit status=$status (want 7)"

echo "Monitor: every captured event is one well-formed JSON object"
[ -n "$repl_events" ] || failmsg "no REPL events to validate"
while IFS= read -r line; do
    case "$line" in
        "{"*"}") ;;
        *) failmsg "non-object JSON line: $line" ;;
    esac
done <<< "$repl_events"
if command -v jq >/dev/null 2>&1; then
    while IFS= read -r line; do
        printf '%s\n' "$line" | jq -e . >/dev/null 2>&1 ||
            failmsg "jq rejected JSON line: $line"
    done <<< "$repl_events"
    echo "PASS: JSON validated with jq"
else
    echo "PASS: JSON shape validated (jq not installed)"
fi

echo "Monitor: text mode shows live events and a session summary"
out=$(echo '' | "$bin" --monitor false 2>&1 >/dev/null)
case "$out" in
    *"PROCESS_EXITED"*"status=1"*) echo "PASS: text mode shows exit event" ;;
    *) failmsg "text mode missing PROCESS_EXITED: '$out'" ;;
esac
case "$out" in
    *"Succeeded: 0"*"Failed: 1"*"Signals: 0"*) echo "PASS: text summary counts" ;;
    *) failmsg "text summary wrong: '$out'" ;;
esac

echo "Monitor: JSON prompt suppression keeps stderr clean (REPL)"
bad=$(printf '%s\n' 'exit 0' | "$bin" --monitor --json 2>&1 >/dev/null)
case "$bad" in
    *'caps>'*) failmsg "REPL prompt leaked into JSON stream" ;;
    *) echo "PASS: no prompt in JSON stream" ;;
esac

[ "$fail" -eq 0 ] || exit 1
echo "PASS: test_monitor.sh ($bin)"
exit 0