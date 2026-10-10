#!/usr/bin/env bash
# Reproduce the locally runnable Linux CI path, including the real production
# gateway and Chromium UI checks. CodeQL remains a GitHub Actions check.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != Linux ]]; then
  echo "verify-linux.sh requires Linux (WSL2 is supported)" >&2
  exit 2
fi
for tool in make gcc clang node npm curl seq timeout; do
  command -v "$tool" >/dev/null || { echo "required tool is missing: $tool" >&2; exit 2; }
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 5)) process.exit(1)' || {
  echo "Node.js 22.5 or newer is required" >&2
  exit 2
}

echo "== repository gates =="
make test-scripts

for compiler in gcc clang; do
  echo "== $compiler strict build and process tests =="
  make clean
  make CC="$compiler" CFLAGS="-std=c11 -Wall -Wextra -Wpedantic -Werror -g"
  make clean
  make CC="$compiler"
  make test CC="$compiler"
  make test-asan CC="$compiler"
  make test-workloads CC="$compiler"
  make test-workloads-asan CC="$compiler"
done

echo "== backend =="
make clean
make CC=gcc
make test-helpers CC=gcc
(
  cd web/backend
  npm ci
  npm run typecheck
  npm run build
  node node_modules/vitest/vitest.mjs run
  node node_modules/vitest/vitest.mjs run tests/api
  npm audit --audit-level=high
)

echo "== frontend =="
(
  cd web/frontend
  npm ci
  npm run typecheck
  npm run build
  node node_modules/vitest/vitest.mjs run
  npm audit --audit-level=high
  npx playwright install chromium
)

work="$(mktemp -d "${TMPDIR:-/tmp}/caps-verify.XXXXXX")"
gateway_port=""
preview_port=""
gateway_pid=""
preview_pid=""
cleanup() {
  if [[ -n "$preview_pid" ]]; then kill "$preview_pid" 2>/dev/null || true; wait "$preview_pid" 2>/dev/null || true; fi
  if [[ -n "$gateway_pid" ]]; then kill "$gateway_pid" 2>/dev/null || true; wait "$gateway_pid" 2>/dev/null || true; fi
  rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Choose a pair that is not already serving a CAPS endpoint. The children
# below are checked during readiness so a bind failure cannot accidentally
# cause the smoke suite to exercise a pre-existing service.
port_is_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}
for _ in $(seq 1 40); do
  candidate=$((30000 + (RANDOM % 20000)))
  if ! port_is_open "$candidate" && ! port_is_open "$((candidate + 1))"; then
    gateway_port="$candidate"
    preview_port="$((candidate + 1))"
    break
  fi
done
if [[ -z "$gateway_port" ]]; then
  echo "could not find an unused loopback port pair for the production stack" >&2
  exit 1
fi

echo "== real production stack =="
(
  cd web/backend
  CAPS_PORT="$gateway_port" \
  CAPS_DATABASE_PATH="$work/caps.db" \
  CAPS_WORKSPACE="$work/work" \
  CAPS_LOG_LEVEL=info \
  node --disable-warning=ExperimentalWarning --import tsx src/server.ts
) >"$work/gateway.log" 2>&1 &
gateway_pid=$!

(
  cd web/frontend
  CAPS_PROXY_TARGET="http://127.0.0.1:$gateway_port" \
  node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port "$preview_port" --strictPort
) >"$work/preview.log" 2>&1 &
preview_pid=$!

ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$gateway_pid" 2>/dev/null || ! kill -0 "$preview_pid" 2>/dev/null; then
    echo "production stack process exited during startup" >&2
    cat "$work/gateway.log" "$work/preview.log" >&2
    exit 1
  fi
  if curl -fsS --max-time 2 "http://127.0.0.1:$gateway_port/api/ready" >/dev/null && curl -fsS --max-time 2 "http://127.0.0.1:$preview_port/" >/dev/null; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "production stack failed to start" >&2
  cat "$work/gateway.log" "$work/preview.log" >&2
  exit 1
fi

CAPS_GATEWAY_URL="http://127.0.0.1:$gateway_port" \
CAPS_FRONTEND_URL="http://127.0.0.1:$preview_port" \
  sh scripts/browser-smoke.sh || {
    echo "HTTP production-stack smoke failed; service logs follow" >&2
    cat "$work/gateway.log" "$work/preview.log" >&2
    exit 1
  }
CAPS_BROWSER_GATEWAY="http://127.0.0.1:$gateway_port" \
CAPS_BROWSER_FRONTEND="http://127.0.0.1:$preview_port" \
  node web/frontend/scripts/browser-smoke.mjs || {
    echo "Playwright smoke failed; service logs follow" >&2
    cat "$work/gateway.log" "$work/preview.log" >&2
    echo "If Chromium reports a missing shared library, run 'npx playwright install-deps chromium' in web/frontend." >&2
    exit 1
  }

echo "LINUX VERIFICATION PASSED"
