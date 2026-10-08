#!/usr/bin/env bash
# Controlled workload tests.
#
# These run the real first-party workload binaries. Assertions are about
# observable behaviour (argument rejection, signal handling, resource
# counters, cleanup) and never about exact timings.
#
#   usage: test_workloads.sh <workload-binary-dir>
set -u

dir=${1:?usage: test_workloads.sh <workload-binary-dir>}

fail=0
failmsg() {
    echo "FAIL: $*" >&2
    fail=1
}

for wl in caps_cpu_burn caps_memory_burn caps_io_burn caps_mixed_burn caps_fork_tree; do
    [ -x "$dir/$wl" ] || {
        echo "FAIL: workload binary missing: $dir/$wl" >&2
        exit 1
    }
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# ---------------------------------------------------------------------------
# 1. Argument validation: every workload must reject out-of-range and
#    non-numeric arguments with the documented usage exit code.
# ---------------------------------------------------------------------------
assert_rejects() {
    local wl="$1"
    shift
    local out status
    out=$("$dir/$wl" "$@" 2>&1 >/dev/null)
    status=$?
    if [ "$status" -ne 2 ]; then
        failmsg "$wl $* : expected usage exit 2, got $status (stderr: $out)"
        return
    fi
    case "$out" in
        usage:*) ;;
        *) failmsg "$wl $* : expected a usage message, got: $out" ;;
    esac
    echo "PASS: $wl rejects '$*' with a usage error"
}

echo "== workload argument validation =="
for wl in caps_cpu_burn caps_memory_burn caps_io_burn caps_mixed_burn; do
    assert_rejects "$wl" 0
    assert_rejects "$wl" 31
    assert_rejects "$wl" abc
    assert_rejects "$wl" ""
    assert_rejects "$wl" -5
    assert_rejects "$wl" "3.5"
    assert_rejects "$wl" "99999999999999999999"
done
assert_rejects caps_fork_tree 0
assert_rejects caps_fork_tree 31
assert_rejects caps_fork_tree 3 0
assert_rejects caps_fork_tree 3 5
assert_rejects caps_fork_tree 3 2 extra
assert_rejects caps_memory_burn 3 0
assert_rejects caps_memory_burn 3 257
assert_rejects caps_io_burn 3 0
assert_rejects caps_io_burn 3 65
assert_rejects caps_mixed_burn 3 64 0
assert_rejects caps_mixed_burn 3 64 65

# ---------------------------------------------------------------------------
# 2. caps_cpu_burn actually consumes CPU time and terminates on its own.
# ---------------------------------------------------------------------------
echo "== caps_cpu_burn =="
cpu_out=$("$dir/caps_cpu_burn" 1 2>/dev/null)
cpu_status=$?
[ "$cpu_status" -eq 0 ] || failmsg "caps_cpu_burn 1 exited $cpu_status"
case "$cpu_out" in
    *checksum:*) ;;
    *) failmsg "caps_cpu_burn printed no checksum: $cpu_out" ;;
esac
rounds=$(printf '%s\n' "$cpu_out" | sed -n 's/^caps_workload: mixing rounds: //p')
[ -n "$rounds" ] && [ "$rounds" -gt 0 ] ||
    failmsg "caps_cpu_burn performed no mixing rounds (rounds='$rounds')"
echo "PASS: caps_cpu_burn ran real work ($rounds mixing rounds) and exited 0"

# CPU time must be observable through the kernel for a process that claims
# to be CPU-bound.  /proc/self/stat is read for the child while it runs.
cpu_ms_before=0
cpuprobe() {
    # $1 = pid, prints utime+stime in ms
    local ticks hz
    hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
    read -r _ _ _ _ _ _ _ _ _ _ _ _ _ ut st _ <"/proc/$1/stat" 2>/dev/null || {
        echo 0
        return
    }
    echo $(((ut + st) * 1000 / hz))
}

"$dir/caps_cpu_burn" 3 >/dev/null 2>&1 &
cpu_pid=$!
sleep 1
before=$(cpuprobe "$cpu_pid")
sleep 1
after=$(cpuprobe "$cpu_pid")
wait "$cpu_pid"
cpu_status=$?
[ "$cpu_status" -eq 0 ] || failmsg "background caps_cpu_burn exited $cpu_status"
if [ "$after" -gt "$before" ]; then
    echo "PASS: caps_cpu_burn accumulated $((after - before)) ms of kernel CPU time in 1 s"
else
    failmsg "caps_cpu_burn accumulated no kernel CPU time ($before -> $after ms)"
fi

# ---------------------------------------------------------------------------
# 3. caps_memory_burn reaches its resident target and releases it.
# ---------------------------------------------------------------------------
echo "== caps_memory_burn =="
"$dir/caps_memory_burn" 4 32 >/dev/null 2>&1 &
mem_pid=$!
sleep 2
rss_kb=$(awk '/^VmRSS:/ {print $2}' "/proc/$mem_pid/status" 2>/dev/null || echo 0)
wait "$mem_pid"
mem_status=$?
[ "$mem_status" -eq 0 ] || failmsg "caps_memory_burn exited $mem_status"
if [ "${rss_kb:-0}" -ge 20000 ]; then
    echo "PASS: caps_memory_burn reached ${rss_kb} kB RSS (target 32 MiB)"
else
    failmsg "caps_memory_burn RSS was only ${rss_kb} kB (expected ~32000 kB)"
fi

# ---------------------------------------------------------------------------
# 4. caps_io_burn reports I/O through /proc/<pid>/io and cleans up.
# ---------------------------------------------------------------------------
echo "== caps_io_burn =="
before_io=$(ls -1 "${TMPDIR:-/tmp}" 2>/dev/null | grep -c '^caps-io-' || true)
"$dir/caps_io_burn" 3 4 >"$tmp/io.out" 2>"$tmp/io.err" &
io_pid=$!
sleep 1
# /proc/<pid>/io mixes character counters (rchar/wchar, always real) with
# block-device counters (read_bytes/write_bytes, zero while the page cache
# absorbs the writes). Both are reported; only character counters are
# asserted, because a cache write is not a lie about the process.
io_rchar=0
io_wchar=0
io_read_bytes=0
io_write_bytes=0
if [ -r "/proc/$io_pid/io" ]; then
    io_rchar=$(awk '/^rchar:/ {print $2}' "/proc/$io_pid/io" 2>/dev/null || echo 0)
    io_wchar=$(awk '/^wchar:/ {print $2}' "/proc/$io_pid/io" 2>/dev/null || echo 0)
    io_write_bytes=$(awk '/^write_bytes:/ {print $2}' "/proc/$io_pid/io" 2>/dev/null || echo 0)
    io_read_bytes=$(awk '/^read_bytes:/ {print $2}' "/proc/$io_pid/io" 2>/dev/null || echo 0)
else
    failmsg "/proc/$io_pid/io is not readable in this environment"
fi
wait "$io_pid"
io_status=$?
[ "$io_status" -eq 0 ] || failmsg "caps_io_burn exited $io_status ($(cat "$tmp/io.err"))"
if [ "${io_wchar:-0}" -gt 0 ] && [ "${io_rchar:-0}" -gt 0 ]; then
    echo "PASS: caps_io_burn produced kernel I/O counters (rchar=${io_rchar}B wchar=${io_wchar}B; block: read=${io_read_bytes}B write=${io_write_bytes}B)"
else
    failmsg "caps_io_burn produced no /proc/<pid>/io counters (rchar=${io_rchar} wchar=${io_wchar})"
fi
after_io=$(ls -1 "${TMPDIR:-/tmp}" 2>/dev/null | grep -c '^caps-io-' || true)
[ "$after_io" -eq "$before_io" ] ||
    failmsg "caps_io_burn leaked $((after_io - before_io)) workspace director(ies)"
echo "PASS: caps_io_burn removed its private workspace"

# ---------------------------------------------------------------------------
# 5. caps_mixed_burn correlates CPU + RSS + I/O for one PID.
# ---------------------------------------------------------------------------
echo "== caps_mixed_burn =="
"$dir/caps_mixed_burn" 3 32 4 >"$tmp/mixed.out" 2>"$tmp/mixed.err" &
mixed_pid=$!
sleep 1
mixed_rss=$(awk '/^VmRSS:/ {print $2}' "/proc/$mixed_pid/status" 2>/dev/null || echo 0)
# CPU time is read as a DELTA over a second, not as one sample after a fixed
# sleep. The workload sleeps 25 ms per iteration, so on a loaded runner a single
# sample can land before the process has been charged a whole CLK_TCK tick and
# read 0 ms even though it is genuinely CPU-bound. That made this assertion
# depend on host load rather than on the workload: it failed in CI on a busy
# 2-core runner while passing on an idle machine. Measuring growth across an
# interval tests the claim actually being made -- that the kernel charges this
# PID for CPU while it runs -- and cannot be satisfied by a lucky sample.
mixed_cpu_before=$(cpuprobe "$mixed_pid")
sleep 1
mixed_cpu_after=$(cpuprobe "$mixed_pid")
mixed_cpu=$((mixed_cpu_after - mixed_cpu_before))
wait "$mixed_pid"
mixed_status=$?
[ "$mixed_status" -eq 0 ] ||
    failmsg "caps_mixed_burn exited $mixed_status ($(cat "$tmp/mixed.err"))"
if [ "${mixed_rss:-0}" -ge 20000 ] && [ "${mixed_cpu:-0}" -gt 0 ]; then
    echo "PASS: caps_mixed_burn showed rss=${mixed_rss}kB and cpu=+${mixed_cpu}ms for one PID"
else
    failmsg "caps_mixed_burn missing a signal (rss=${mixed_rss}kB cpu=+${mixed_cpu}ms)"
fi

# ---------------------------------------------------------------------------
# 6. caps_fork_tree creates a real, bounded, fully reaped process tree.
# ---------------------------------------------------------------------------
echo "== caps_fork_tree =="
# /proc/<pid>/task/<tid>/children is a bare, space-separated PID list — it has
# no "PPid:" label, so it is read directly.
#
# `cat` rather than an input redirect. A redirect over a glob is an "ambiguous
# redirect" error in bash as soon as it matches more than one path, and the
# number of task directories is not fixed: an AddressSanitizer build creates
# extra threads, so /proc/<pid>/task/*/children matches two files and the
# redirect fails. The failure looks like "this process has no children", which
# is why the sanitizer run reported zero children for a workload that had them.
read_children() {
    cat "/proc/$1/task"/*/children 2>/dev/null |
        tr -s ' \t' '\n' |
        grep -E '^[0-9]+$' || true
}

"$dir/caps_fork_tree" 4 2 >"$tmp/tree.out" 2>"$tmp/tree.err" &
tree_pid=$!

# Poll for the tree rather than sleeping a fixed interval.
#
# A fixed `sleep 1` is a race that passes on a fast machine and fails under
# AddressSanitizer, where start-up is several times slower: the children are
# forked later than the sample, so the suite reports "exposed 0 direct
# children" for a workload that did exactly what it was asked. Sampling
# repeatedly over a window removes the race and works at any speed.
#
# The window must stay inside the workload's own 4-second budget, otherwise the
# tree can exit before it is observed and the failure would be genuine.
wait_for() {
    # wait_for <expected-count> <description>
    local want="$1" what="$2" i
    for i in $(seq 1 60); do
        if [ "$(read_children "$tree_pid" | wc -l | tr -d ' ')" -ge "$want" ]; then
            return 0
        fi
        # The process must still be alive; once it exits the tree is gone.
        kill -0 "$tree_pid" 2>/dev/null || return 1
        sleep 0.05
    done
    return 1
}

wait_for 2 "direct children" || true
tree_children=$(read_children "$tree_pid" | wc -l | tr -d ' ')
grandchild_count=0
# The grandchild appears one level deeper and therefore later than the direct
# children, so it needs its own wait rather than being read on the same sample.
# Sampling it once immediately after the children appear was a second race: the
# fork that creates the grandchild had not happened yet, so the assertion failed
# for a correct workload.
for _ in $(seq 1 40); do
    grandchild_count=0
    for child in $(read_children "$tree_pid"); do
        gc=$(read_children "$child" | wc -l | tr -d ' ')
        grandchild_count=$((grandchild_count + gc))
    done
    [ "${grandchild_count:-0}" -ge 1 ] && break
    kill -0 "$tree_pid" 2>/dev/null || break
    sleep 0.05
done
wait "$tree_pid"
tree_status=$?
[ "$tree_status" -eq 0 ] || failmsg "caps_fork_tree exited $tree_status ($(cat "$tmp/tree.err"))"
if [ "${tree_children:-0}" -ge 2 ]; then
    echo "PASS: caps_fork_tree exposed $tree_children direct children via /proc"
else
    failmsg "caps_fork_tree exposed $tree_children direct children (expected 2)"
fi
if [ "${grandchild_count:-0}" -ge 1 ]; then
    echo "PASS: caps_fork_tree exposed $grandchild_count grandchild process(es)"
else
    failmsg "caps_fork_tree exposed no grandchild"
fi
# No zombies may survive: the parent reaps every worker.
#
# The wait above has already returned, so the parent is gone and reaping is
# complete; a short settle only guards against the kernel's own teardown of the
# /proc entries, and is not where the correctness of this assertion comes from.
sleep 1
zombies=$(awk -v p="$tree_pid" '$4==p {c++} END{print c+0}' /proc/[0-9]*/stat 2>/dev/null)
[ "${zombies:-0}" -eq 0 ] || failmsg "caps_fork_tree left $zombies unreaped child(ren)"
echo "PASS: caps_fork_tree reaped every child (no zombies)"

# ---------------------------------------------------------------------------
# 7. Signal handling: SIGINT and SIGTERM must end each workload cleanly with
#    the documented stop exit code, not die from an unhandled signal.
# ---------------------------------------------------------------------------
echo "== workload signal handling =="
assert_signal_clean() {
    local wl="$1" sig="$2" pid status
    "$dir/$wl" 30 >/dev/null 2>&1 &
    pid=$!
    sleep 1
    if ! kill -"$sig" "$pid" 2>/dev/null; then
        failmsg "$wl: could not send SIG$sig to $pid"
        return
    fi
    wait "$pid"
    status=$?
    if [ "$status" -eq 4 ]; then
        echo "PASS: $wl handled SIG$sig and exited with the stop code 4"
    else
        failmsg "$wl died on SIG$sig (wait status $status); it must handle it and exit 4"
    fi
}

for wl in caps_cpu_burn caps_memory_burn caps_io_burn caps_mixed_burn caps_fork_tree; do
    assert_signal_clean "$wl" INT
    assert_signal_clean "$wl" TERM
done

# ---------------------------------------------------------------------------
# 8. Output stays bounded: a CPU workload must not flood stdout.
# ---------------------------------------------------------------------------
echo "== bounded output =="
bytes=$("$dir/caps_cpu_burn" 1 2>/dev/null | wc -c)
if [ "$bytes" -gt 4096 ]; then
    failmsg "caps_cpu_burn produced $bytes bytes of output (cap is 4096)"
else
    echo "PASS: caps_cpu_burn stdout is bounded ($bytes bytes)"
fi

if [ "$fail" -ne 0 ]; then
    echo "FAIL: workload tests failed" >&2
    exit 1
fi
echo "PASS: all workload tests OK ($dir)"
exit 0
