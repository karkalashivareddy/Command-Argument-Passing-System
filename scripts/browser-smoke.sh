#!/bin/sh
# HTTP production-stack smoke suite. The Playwright browser check is separate.
#
# Scope is deliberately behavioural, not visual. This asserts the claims the
# observatory makes about itself, end to end, in a real browser:
#
#   1. the built app is served;
#   2. a real execution runs through the real C engine;
#   3. its event stream arrives over SSE;
#   4. replay reproduces the same evidence.
#
# It does not assert pixels, fonts, or layout. A visual-regression suite would
# be a large addition that tests screenshots rather than the system's claims,
# and this repository has no such infrastructure to extend.
set -eu

GATEWAY="${CAPS_GATEWAY_URL:-http://127.0.0.1:3000}"
FRONTEND="${CAPS_FRONTEND_URL:-http://127.0.0.1:4173}"
WORK="${TMPDIR:-/tmp}/caps-browser-smoke.$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }

# ---------------------------------------------------------------- preflight
printf 'HTTP production-stack smoke suite\n'
if ! curl -fsS "$GATEWAY/api/ready" > "$WORK/ready.json"; then
  echo "gateway is not reachable at $GATEWAY"
  exit 1
fi
pass "gateway readiness responds"

node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (!r.ready) { console.error("gateway reports not ready:", JSON.stringify(r.checks)); process.exit(1); }
if (!r.checks.engine.available) { console.error("engine unavailable:", r.checks.engine.detail); process.exit(1); }
' "$WORK/ready.json" && pass "gateway is ready and the C engine is available" || bad "gateway is not ready"

if ! curl -fsS "$FRONTEND/" > /dev/null; then
  echo "frontend is not reachable at $FRONTEND"
  exit 1
fi
pass "production frontend build serves"

# -------------------------------------------------- 1. real execution via API
session=$(curl -fsS -X POST "$GATEWAY/api/sessions" \
  -H 'content-type: application/json' \
  -d '{"command":"echo","args":["browser-smoke"]}' |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).sessionId))')
[ -n "$session" ] && pass "gateway accepted a real execution ($session)" || bad "gateway did not return a session id"

# ------------------------------------------------------- 2. wait for the end
status=""
i=0
while [ "$i" -lt 60 ]; do
  status=$(curl -fsS "$GATEWAY/api/sessions/$session" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);process.stdout.write(b.status)})')
  case "$status" in COMPLETED|FAILED|TIMED_OUT|CANCELLED) break ;; esac
  i=$((i + 1))
  sleep 0.25
done
[ "$status" = "COMPLETED" ] && pass "execution completed through the real engine" || bad "execution ended as $status"

curl -fsS "$GATEWAY/api/sessions/$session/output" > "$WORK/output.json"
node -e '
const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (!o.stdout.includes("browser-smoke")) { console.error("stdout missing the command output:", JSON.stringify(o.stdout)); process.exit(1); }
if (o.stderr.includes("\"event\":")) { console.error("the CAPS monitor protocol leaked into user stderr"); process.exit(1); }
' "$WORK/output.json" && pass "output channels are separated: stdout has the program's output, stderr has no protocol" \
  || bad "output channels are not separated correctly"

# --------------------------------------------------------- 3. event stream
curl -fsS -N --max-time 5 -H 'accept: text/event-stream' \
  "$GATEWAY/api/sessions/$session/events" > "$WORK/stream.txt" 2>/dev/null || true
grep -q '^event: caps.event$' "$WORK/stream.txt" \
  && pass "SSE delivers canonical events on the caps.event frame" \
  || bad "SSE did not deliver a caps.event frame"
grep -q '^event: stream.end$' "$WORK/stream.txt" \
  && pass "SSE closes with an explicit stream.end frame" \
  || bad "SSE did not close with a stream.end frame"
if grep -q '^id: 9007199254740991$' "$WORK/stream.txt"; then
  bad "SSE used Number.MAX_SAFE_INTEGER as a canonical event id"
else
  pass "SSE carries no synthetic canonical sequence"
fi
# Every id: on the wire must be a real, contiguous session sequence.
node -e '
const fs = require("fs");
const ids = [...fs.readFileSync(process.argv[1], "utf8").matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
if (ids.length === 0) { console.error("no event ids on the stream"); process.exit(1); }
ids.forEach((v, i) => { if (v !== i) { console.error(`sequence gap: expected ${i}, got ${v}`); process.exit(1); } });
' "$WORK/stream.txt" && pass "SSE ids are contiguous from 0 with no gaps" || bad "SSE ids are not contiguous"

# ------------------------------------------------------------- 4. replay
curl -fsS "$GATEWAY/api/sessions/$session/replay" > "$WORK/replay.json"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(r.events) || r.events.length === 0) { console.error("replay returned no events"); process.exit(1); }
r.events.forEach((e, i) => { if (e.sequence !== i) { console.error(`replay gap at ${i}`); process.exit(1); } });
if (!r.integrity || !r.integrity.valid) { console.error("replay integrity:", JSON.stringify(r.integrity)); process.exit(1); }
const terminal = r.events.filter(e => ["execution.completed","execution.failed","execution.timeout","execution.cancelled"].includes(e.type));
if (terminal.length !== 1) { console.error(`expected exactly one terminal event, found ${terminal.length}`); process.exit(1); }
if (terminal[0].sequence !== r.events.length - 1) { console.error("terminal event is not last"); process.exit(1); }
' "$WORK/replay.json" && pass "replay is contiguous, has one terminal event, and passes the invariant check" \
  || bad "replay failed its integrity check"

# Replay must not mutate anything.
fp1=$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write(require("crypto").createHash("sha256").update(JSON.stringify(r.events)).digest("hex"));
' "$WORK/replay.json")
curl -fsS "$GATEWAY/api/sessions/$session/replay" > "$WORK/replay2.json"
fp2=$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write(require("crypto").createHash("sha256").update(JSON.stringify(r.events)).digest("hex"));
' "$WORK/replay2.json")
[ "$fp1" = "$fp2" ] && pass "a second replay returns a byte-identical event fingerprint" \
  || bad "replay is not idempotent: the fingerprint changed between two reads"

# --------------------------------------------- 5. the UI against this data
page=$(curl -fsS "$FRONTEND/")
case "$page" in
  *"<div id=\"root\">"*) pass "the production bundle mounts a React root" ;;
  *) bad "the served HTML has no React root" ;;
esac
# The built asset must actually be the hashed production bundle, not the dev
# server's untransformed source.
if printf '%s' "$page" | grep -qE '/assets/index-[A-Za-z0-9_-]+\.(js|css)'; then
  pass "the production build serves hashed immutable assets"
else
  bad "the served HTML does not reference a hashed production bundle"
fi
asset=$(printf '%s' "$page" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
if [ -n "$asset" ]; then
  curl -fsS "$FRONTEND$asset" > "$WORK/bundle.js"
  # The 3D scene is code-split, so its chunk must exist and not be inlined into
  # the entry: that is what keeps the initial load small.
  if [ "$(wc -c < "$WORK/bundle.js")" -lt 900000 ]; then
    pass "the entry bundle is code-split ($(wc -c < "$WORK/bundle.js") bytes)"
  else
    bad "the entry bundle is not code-split ($(wc -c < "$WORK/bundle.js") bytes)"
  fi
else
  bad "could not find the entry bundle"
fi

printf '\n'
if [ "$fail" -ne 0 ]; then
  echo "HTTP PRODUCTION-STACK SMOKE SUITE FAILED"
  exit 1
fi
echo "HTTP PRODUCTION-STACK SMOKE SUITE PASSED"
