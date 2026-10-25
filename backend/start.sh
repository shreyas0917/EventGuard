#!/bin/sh
# EventGuard Backend Process Manager for Alpine (BusyBox ash-compatible)
# Starts: API (includes in-process outbox + retry workers) + Kafka consumer only.

set -eu

API_PID=""
CONSUMER_PID=""

cleanup() {
  echo "[start.sh] Received termination signal, shutting down services..."
  if [ -n "${API_PID}" ]; then
    kill -TERM "${API_PID}" 2>/dev/null || true
  fi
  if [ -n "${CONSUMER_PID}" ]; then
    kill -TERM "${CONSUMER_PID}" 2>/dev/null || true
  fi
  if [ -n "${API_PID}" ]; then
    wait "${API_PID}" 2>/dev/null || true
  fi
  if [ -n "${CONSUMER_PID}" ]; then
    wait "${CONSUMER_PID}" 2>/dev/null || true
  fi
  echo "[start.sh] All processes terminated cleanly."
  exit 0
}

trap cleanup TERM INT

echo "[start.sh] Working directory: $(pwd)"
echo "[start.sh] Applying Prisma migrations (deploy only)..."
npx prisma migrate deploy --schema=prisma/schema.prisma
echo "[start.sh] Prisma migrate deploy completed."

echo "[start.sh] Starting EventGuard API server..."
npm run dev &
API_PID=$!

echo "[start.sh] Starting EventGuard Kafka Consumer..."
npx tsx src/eventConsumer.ts &
CONSUMER_PID=$!

echo "[start.sh] API_PID=${API_PID} CONSUMER_PID=${CONSUMER_PID}"

# Portable substitute for `wait -n` (unsupported / unreliable on BusyBox ash):
# stay alive while both children are running; exit if either dies.
while kill -0 "${API_PID}" 2>/dev/null && kill -0 "${CONSUMER_PID}" 2>/dev/null; do
  sleep 1
done

EXIT_CODE=1
if ! kill -0 "${API_PID}" 2>/dev/null; then
  wait "${API_PID}" 2>/dev/null || EXIT_CODE=$?
  echo "[start.sh] API process exited with status ${EXIT_CODE}"
elif ! kill -0 "${CONSUMER_PID}" 2>/dev/null; then
  wait "${CONSUMER_PID}" 2>/dev/null || EXIT_CODE=$?
  echo "[start.sh] Consumer process exited with status ${EXIT_CODE}"
fi

echo "[start.sh] Process exited unexpectedly. Stopping companion services..."
kill -TERM "${API_PID}" "${CONSUMER_PID}" 2>/dev/null || true
wait "${API_PID}" 2>/dev/null || true
wait "${CONSUMER_PID}" 2>/dev/null || true
exit 1
