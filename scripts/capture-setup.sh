#!/bin/sh
# Start the gateway and the production frontend build for documentation capture.
#
# Uses a dedicated database and workspace so a screenshot session never touches
# the developer's real recordings.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="${1:-$ROOT/docs/screenshots}"
# Docker Desktop commonly holds 3000 on this machine; pick a free port explicitly.
PORT="${CAPS_SHOT_PORT:-3100}"
PREVIEW_PORT="${CAPS_SHOT_PREVIEW_PORT:-4173}"
DB="${CAPS_SHOT_DB:-/tmp/caps-shots/caps-observatory.db}"
WORK="${CAPS_SHOT_WORK:-/tmp/caps-shots/work}"

mkdir -p "$OUT" "$WORK"
rm -f "$DB" "$DB-wal" "$DB-shm"

cd "$ROOT"
make caps workloads

cd "$ROOT/web/backend"
CAPS_DATABASE_PATH="$DB" \
CAPS_WORKSPACE="$WORK" \
CAPS_LOG_LEVEL=warn \
  nohup env CAPS_PORT="$PORT" node --disable-warning=ExperimentalWarning node_modules/tsx/dist/cli.mjs src/server.ts \
  > /tmp/caps-shots-gateway.log 2>&1 &
echo $! > /tmp/caps-shots-gateway.pid

for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/ready" > /dev/null 2>&1; then
    echo "gateway ready after ${i}s"
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/ready" || { echo "gateway failed to start"; cat /tmp/caps-shots-gateway.log; exit 1; }
echo

cd "$ROOT/web/frontend"
npm run build > /tmp/caps-shots-build.log 2>&1 || { tail -20 /tmp/caps-shots-build.log; exit 1; }
nohup npx vite preview --host 127.0.0.1 --port "$PREVIEW_PORT" --strictPort > /tmp/caps-shots-preview.log 2>&1 &
echo $! > /tmp/caps-shots-preview.pid

for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PREVIEW_PORT/" > /dev/null 2>&1; then
    echo "preview ready after ${i}s"
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PREVIEW_PORT/" > /dev/null || { echo "preview failed to start"; cat /tmp/caps-shots-preview.log; exit 1; }
echo
echo "frontend: http://127.0.0.1:$PREVIEW_PORT"
echo "gateway:  http://127.0.0.1:$PORT"
echo "screenshot output directory: $OUT"
