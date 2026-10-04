#!/bin/sh
# Cross-view proof: one real execution, followed through every view CAPS has.
#
# WHAT THIS PROVES, AND WHY IT IS A SCRIPT RATHER THAN A TEST
# -----------------------------------------------------------
# Most of this repository's suites assert one subsystem at a time: the C engine's
# event stream, a repository's aggregation, a route's response shape. Each of
# those can be green while the product contradicts itself across views -- and did.
#
# The concrete defect this script exists to keep closed: the Process Explorer
# reported `capsOwned: true` for a CAPS-owned process while the Process Detail
# route, which re-reads procfs per request, reported `capsOwned: false` for the
# same `(pid, startTicks, bootId)`. Both responses were type-correct. Only walking
# the whole chain finds that.
#
# So this starts the real gateway, runs one real pipeline through the real C
# engine, and then reads the SAME facts back out of every view:
#
#   terminal -> engine -> pipeline evidence -> process identity
#            -> host telemetry -> persistence -> SSE
#            -> Process Explorer -> Process Detail -> analytics -> replay
#
# and requires them to agree on sessionId, pid, startTicks, bootId, ownership,
# lifecycle and provenance. It asserts nothing about pixels and nothing about a
# subsystem in isolation.
#
# Usage: scripts/cross-view-proof.sh [gateway-url]
# Requires: node, curl, and a built ./caps at the repository root.
set -eu

GATEWAY="${1:-${CAPS_GATEWAY_URL:-http://127.0.0.1:3000}}"
REPO="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/caps-cross-view.$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }

api() { # method path [body]
  if [ "$#" -ge 3 ]; then
    curl -fsS -X "$1" "$GATEWAY$2" -H 'content-type: application/json' -d "$3"
  else
    curl -fsS -X "$1" "$GATEWAY$2"
  fi
}

jget() { # file jq-ish dotted path (node expression body)
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const path = process.argv[2].split(".");
    let v = body;
    for (const k of path) { if (v === null || v === undefined) break; v = v[k]; }
    process.stdout.write(v === null || v === undefined ? "" : String(v));
  ' "$1" "$2"
}

printf 'Cross-view proof against %s\n' "$GATEWAY"
printf 'Repository: %s\n\n' "$REPO"

# --------------------------------------------------------------- preflight
api GET /api/ready > "$WORK/ready.json"
[ "$(jget "$WORK/ready.json" ready)" = "true" ] || { echo "gateway is not ready"; cat "$WORK/ready.json"; exit 1; }
pass "gateway is ready and the real C engine is available"

api GET /api/capabilities > "$WORK/caps.json"
VERSION=$(jget "$WORK/caps.json" version)
pass "capabilities report version $VERSION"

# ------------------------------------------------- one real pipeline execution
# Two stages, so there is a stage index, a per-stage pid, and a process group to
# carry across every view below.
#
# The producer is `sleep`, not `seq`: the host inventory and Process Detail can
# only describe a process that is still alive, and `seq 1 500 | wc -l` finishes
# in a few milliseconds -- long before the observer's next discovery pass, which
# would make the identity checks below silently vacuous. `sleep` holds the
# pipeline open long enough for a real observation, and the payload is checked
# separately below so the payload is not what proves the process is alive.
api POST /api/terminal/execute '{"commandLine":"sleep 12 | cat","timeoutMs":30000}' > "$WORK/exec.json"
SESSION=$(jget "$WORK/exec.json" sessionId)
[ -n "$SESSION" ] || { echo "the terminal refused the command line:"; cat "$WORK/exec.json"; exit 1; }
STAGES=$(jget "$WORK/exec.json" stageCount)
pass "the terminal accepted a two-stage command line ($SESSION, $STAGES stages)"

# ------------------------------------------------------------- engine evidence
# The gateway's own event stream is the normalized form of the C monitor's JSON
# on stderr. Reading it back proves the engine's evidence survived normalization,
# and it is what supplies the stage-0 pid the host views are then joined on.
api GET "/api/sessions/$SESSION/replay" > "$WORK/replay.json"
i=0
while [ "$i" -lt 60 ]; do
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.exit(r.events.filter((e) => e.type === "process.started").length === 2 ? 0 : 1);
  ' "$WORK/replay.json" && break
  i=$((i + 1)); sleep 0.1
done

node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!r.events.some((e) => e.type === "execution.created")) { console.error("no execution.created"); process.exit(1); }
  const started = r.events.filter((e) => e.type === "process.started");
  if (started.length !== 2) { console.error(`expected 2 process.started, saw ${started.length}`); process.exit(1); }
  // The stage index travels inside the payload: it is a property of what the
  // engine reported about that program, alongside its own argv and exit code.
  const stages = started.map((e) => e.payload.stage).sort();
  if (stages[0] !== 0 || stages[1] !== 1) { console.error("stage indices:", stages); process.exit(1); }
  const pgids = new Set(started.map((e) => e.payload.pgid));
  if (pgids.size !== 1) { console.error("stages do not share one process group:", [...pgids]); process.exit(1); }
' "$WORK/replay.json" && pass "the engine's pipeline evidence survived normalization: two stages in one process group" \
  || bad "the normalized event stream does not match the engine's own evidence"

# The per-stage pid must be distinct. If both stages claimed one pid, every
# downstream view would be right about a process that never existed.
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const started = r.events.filter((e) => e.type === "process.started").sort((a,b)=>a.payload.stage-b.payload.stage);
  const pids = started.map((e) => e.pid);
  if (pids[0] === pids[1]) { console.error("both stages report pid", pids[0]); process.exit(1); }
' "$WORK/replay.json" && pass "each pipeline stage carries its own distinct pid" \
  || bad "the stages do not carry distinct pids"

PID=$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const s = r.events.find((e) => e.type === "process.started" && e.payload.stage === 0);
  process.stdout.write(String(s.pid));
' "$WORK/replay.json")
pass "the stage-0 program is pid $PID"

# --------------------------------------------------------------- SSE delivery
# Read the live stream while the pipeline is still running. The window is
# deliberately short: this asserts that the SAME evidence reaches a subscriber in
# real time, not that the whole run fits inside one read.
curl -fsS -N --max-time 3 -H 'accept: text/event-stream' \
  "$GATEWAY/api/sessions/$SESSION/events" > "$WORK/sse.txt" 2>/dev/null || true
grep -q '^event: caps.event$' "$WORK/sse.txt" \
  && pass "SSE delivers the same evidence on the caps.event frame" \
  || bad "SSE did not deliver a caps.event frame"
node -e '
  const fs = require("fs");
  const txt = fs.readFileSync(process.argv[1], "utf8");
  const events = [...txt.matchAll(/^data: (.+)$/gm)].map(m => JSON.parse(m[1]));
  const started = events.filter((e) => e.type === "process.started");
  if (started.length === 0) { console.error("no process.started on the live stream"); process.exit(1); }
  // The subscriber must be told about the same stage-0 pid the event stream and
  // the host inventory both name.
  if (!started.some((e) => e.pid === Number(process.argv[2]))) {
    console.error("the live stream does not carry pid", process.argv[2], "; it carries", started.map(e=>e.pid));
    process.exit(1);
  }
' "$WORK/sse.txt" "$PID" && pass "the live SSE stream carries the same stage-0 pid as the persisted stream" \
  || bad "the SSE stream disagrees with the persisted stream about which process ran"

# ------------------------------------------------------- host process identity
# The identity is the join key between every host view. It has to exist, and the
# ownership decision has to be reachable, or none of the host surfaces can say
# anything about a CAPS process.
IDENTITY=""
i=0
while [ "$i" -lt 60 ]; do
  api GET "/api/system/processes?limit=2000" > "$WORK/procs.json"
  IDENTITY=$(node -e '
    const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const hit = b.processes.find((p) => p.identity.pid === Number(process.argv[2]));
    if (hit && hit.identity.startTicks !== null) process.stdout.write(hit.identity.key);
  ' "$WORK/procs.json" "$PID")
  [ -n "$IDENTITY" ] && break
  i=$((i + 1)); sleep 0.25
done
[ -n "$IDENTITY" ] || { echo "no host identity for pid $PID"; exit 1; }
pass "the host inventory publishes a full identity for the executed program ($IDENTITY)"

node -e '
  const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const hit = b.processes.find((p) => p.identity.key === process.argv[2]);
  if (!hit) { console.error("the identity vanished between reads"); process.exit(1); }
  // A CAPS-forked process that is not attributed to CAPS is the defect this
  // whole script was written for.
  if (hit.capsOwned !== true) { console.error("inventory reports capsOwned =", hit.capsOwned); process.exit(1); }
  if (hit.rowState !== "LIVE") { console.error("rowState:", hit.rowState, hit.stateReason); process.exit(1); }
  const conf = hit.relationshipConfidence;
  if (!conf || conf.provenance === "UNAVAILABLE") { console.error("relationshipConfidence unresolved:", JSON.stringify(conf)); process.exit(1); }
' "$WORK/procs.json" "$IDENTITY" \
  && pass "the Process Explorer row is LIVE, CAPS-owned, with a settled parent link" \
  || bad "the Process Explorer row does not agree that this process is CAPS-owned"

# ------------------------------------------------------------- process detail
# The identity contains a literal '#', which is a URL fragment delimiter. Sending
# it raw silently truncates the request to the path component, and the gateway
# answers 400 -- which looks like a rejected identity rather than an unencoded one.
ENC=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$IDENTITY")
api GET "/api/system/processes/$ENC" > "$WORK/detail.json"
node -e '
  const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const p = b.process;
  if (!p) { console.error("no process row in the detail response"); process.exit(1); }
  if (p.identity.key !== process.argv[2]) { console.error("detail identity:", p.identity.key); process.exit(1); }
  if (p.identity.startTicks === null) { console.error("detail row has no start ticks"); process.exit(1); }
  // THE regression: the detail route re-reads procfs per request and used to
  // report capsOwned=false for a process the inventory reported as true.
  if (p.capsOwned !== true) { console.error("Process Detail reports capsOwned =", p.capsOwned, "for a CAPS-owned process"); process.exit(1); }
  if (p.relationshipConfidence.reason && /Not settled yet/.test(p.relationshipConfidence.reason)) {
    console.error("detail row still carries the unsettled placeholder"); process.exit(1);
  }
  // Provenance must be present on a real measurement.
  if (p.rssBytes.provenance !== "OBSERVED" && p.rssBytes.provenance !== "UNAVAILABLE") {
    console.error("rssBytes provenance:", p.rssBytes.provenance); process.exit(1);
  }
' "$WORK/detail.json" "$IDENTITY" \
  && pass "Process Detail agrees with the inventory on identity, ownership, and provenance" \
  || bad "Process Detail disagrees with the Process Explorer about the same identity"

# ------------------------------------------------- persistence and completion
# Read the session back only after the host views have been compared: the
# pipeline above is deliberately long enough to still be running while the
# identity is observed.
status=""
i=0
while [ "$i" -lt 120 ]; do
  api GET "/api/sessions/$SESSION" > "$WORK/session.json"
  status=$(jget "$WORK/session.json" status)
  case "$status" in COMPLETED|FAILED|TIMED_OUT|CANCELLED) break ;; esac
  i=$((i + 1)); sleep 0.25
done
[ "$status" = "COMPLETED" ] || { echo "execution ended as $status"; exit 1; }
pass "the execution completed through the real engine"

# The complete lifecycle, now that both stages have been reaped.
api GET "/api/sessions/$SESSION/replay" > "$WORK/replay.json"
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const want = ["execution.created", "process.started", "process.exited", "execution.completed"];
  for (const t of want) {
    if (!r.events.some((e) => e.type === t)) { console.error("missing event:", t, r.events.map(e=>e.type)); process.exit(1); }
  }
  const exited = r.events.filter((e) => e.type === "process.exited");
  if (exited.length !== 2) { console.error(`expected 2 process.exited, saw ${exited.length}`); process.exit(1); }
  // Every stage exit must be attributable to its own start.
  const starts = r.events.filter((e) => e.type === "process.started");
  for (const s of starts) {
    const e = exited.find((x) => x.pid === s.pid && x.payload.stage === s.payload.stage);
    if (!e) { console.error(`no exit for pid ${s.pid} stage ${s.payload.stage}`); process.exit(1); }
  }
  if (!r.integrity || !r.integrity.valid) { console.error("integrity:", JSON.stringify(r.integrity)); process.exit(1); }
' "$WORK/replay.json" && pass "every stage's exit is attributable to its own start, and the stream passes its invariant check" \
  || bad "the lifecycle in the event stream is incomplete or unattributable"

node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const stagePids = r.events.filter((e) => e.type === "process.started").map((e) => e.pid);
  if (s.status !== "COMPLETED") { console.error("row says", s.status); process.exit(1); }
  if (s.exitCode !== 0) { console.error("exit code", s.exitCode); process.exit(1); }
  // The row names its identifier as `id`; the replay document names the same
  // value as `sessionId`. They must be the same session.
  if (s.id !== r.sessionId) { console.error("replay is for", r.sessionId, "not", s.id); process.exit(1); }
  if (r.status !== s.status) { console.error("replay status", r.status, "vs row", s.status); process.exit(1); }
  // The row names ONE pid. For a pipeline that is the last stage the engine
  // reported, so the requirement is that it is one of this session stages -- not
  // a specific one. What must never happen is a pid from another session.
  if (!stagePids.includes(s.pid)) {
    console.error("the session row names pid", s.pid, "which is not one of its stages", stagePids);
    process.exit(1);
  }
' "$WORK/session.json" "$WORK/replay.json" \
  && pass "persistence agrees with the event stream on session, status and exit code, and the row's pid is one of its stages" \
  || bad "the persisted session and the event stream disagree"

# Replay must be a read: two reads of the same session are byte-identical.
api GET "/api/sessions/$SESSION/replay" > "$WORK/replay2.json"
if cmp -s "$WORK/replay.json" "$WORK/replay2.json"; then
  pass "replay is idempotent: a second read returns an identical document"
else
  bad "replay mutated between two reads"
fi

# ------------------------------------------------------------------- analytics
api GET /api/analytics/overview > "$WORK/analytics.json"
node -e '
  const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const t = a.processTelemetry;
  // Every average must arrive with the sample count that produced it. A count of
  // zero beside a non-null average is a fabricated denominator.
  const pairs = [
    ["averageMinorFaults", "minorFaultSamples"],
    ["averageMajorFaults", "majorFaultSamples"],
    ["averageRssBytes", "rssSamples"],
    ["averageCpuPercent", "cpuPercentSamples"],
  ];
  for (const [avg, count] of pairs) {
    if (t[avg] !== null && !(t[count] > 0)) {
      console.error(`${avg} = ${t[avg]} with ${count} = ${t[count]}`); process.exit(1);
    }
    if (avg === "averageMinorFaults" && typeof t.minorFaultSamples !== "number") {
      console.error("minorFaultSamples is missing from the analytics response"); process.exit(1);
    }
  }
' "$WORK/analytics.json" && pass "analytics reports every average with a real sample count" \
  || bad "analytics reports an average without its denominator"

# -------------------------------------------------------------- capabilities
node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const g = c.guardrails;
  // RLIMIT_AS is address space. Describing it as physical memory anywhere in the
  // capabilities document is the one naming claim this product must never make,
  // because the number is otherwise indistinguishable from a memory limit.
  const as = g.addressSpace;
  if (!as) { console.error("no addressSpace guardrail is published"); process.exit(1); }
  const text = JSON.stringify(as);
  if (!/address space/i.test(text)) { console.error("RLIMIT_AS is not described as address space"); process.exit(1); }
  if (/physical memory limit|caps physical/i.test(text)) { console.error("RLIMIT_AS is described as a physical-memory limit"); process.exit(1); }
  // Every guardrail states whether it is actually in force. A limit reported as
  // configured with no enforcement statement is the failure mode this product
  // exists to avoid.
  for (const k of ["wallTime", "stdout", "cpuTime", "addressSpace"]) {
    if (typeof g[k].enforced !== "boolean") { console.error(k, "does not state whether it is enforced"); process.exit(1); }
  }
  // Thermal is observation-only and must never claim a sensor it did not read.
  if (g.thermal.sensor !== null && typeof g.thermal.sensor === "object" && g.thermal.celsius === 0) {
    console.error("thermal reports a fabricated 0 degrees"); process.exit(1);
  }
  if (!c.processIdentity || !["VERIFIED","UNVERIFIED","UNAVAILABLE"].includes(c.processIdentity.confidence)) {
    console.error("processIdentity confidence is not one of the three documented values"); process.exit(1);
  }
  if (!c.processIdentity.invariant) { console.error("processIdentity states no invariant"); process.exit(1); }
' "$WORK/caps.json" && pass "the capabilities document names address space correctly, states what is enforced, and reports its identity confidence" \
  || bad "the capabilities document overstates or misstates what CAPS measured"

printf '\n'
if [ "$fail" -ne 0 ]; then
  echo "CROSS-VIEW PROOF FAILED"
  exit 1
fi
echo "CROSS-VIEW PROOF PASSED"
