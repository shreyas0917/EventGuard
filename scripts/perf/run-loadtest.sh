#!/usr/bin/env bash
# Reproducible load test in an isolated environment.
#
# Runs the compiled API and consumer on the host against the disposable stack from
# docker-compose.test.yml (never the development database), drives them with k6 in
# Docker, then measures end-to-end results from the database.
#
#   npm run test:infra:up
#   RATE=100 DURATION=60s bash scripts/perf/run-loadtest.sh
#
# Results land in loadtest/results/<runId>/ (k6.txt, k6-summary.json, report.md/json, logs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_ID="${RUN_ID:-$(date +%Y%m%d%H%M%S)}"
export RATE="${RATE:-100}" DURATION="${DURATION:-60s}" WALLETS="${WALLETS:-50}"
export DUPLICATE_SHARE="${DUPLICATE_SHARE:-0.1}" STORM_VUS="${STORM_VUS:-100}"
API_PORT="${API_PORT:-3101}"
OUT_DIR="$ROOT/loadtest/results/$RUN_ID"
mkdir -p "$OUT_DIR"

# Everything below points at the disposable test stack
export NODE_ENV=test
export DATABASE_URL="postgresql://eventguard:eventguard@localhost:55432/eventguard_test?connection_limit=30"
export REDIS_HOST=localhost REDIS_PORT=56379 REDIS_DB=0
export KAFKA_BROKERS=localhost:59092 KAFKA_TOPIC="eventguard.perf.$RUN_ID" KAFKA_CONSUMER_GROUP="perf-$RUN_ID"
export BACKEND_PORT="$API_PORT" CONSUMER_METRICS_PORT=9465
export JWT_SECRET="perf-only-jwt-secret-0123456789abcdefghij" ADMIN_API_KEY="perf-admin-key-0123456789"
export AUTH_DEMO_LOGIN=true RECONCILIATION_INTERVAL_MS=0
# The load generator is a single IP; the per-IP limit would otherwise cap it at 100/min
export RATE_LIMIT_MAX_REQUESTS=1000000000

echo "== run $RUN_ID: $RATE events/s for $DURATION, $DUPLICATE_SHARE duplicate share, storm of $STORM_VUS"
docker compose -f "$ROOT/docker-compose.test.yml" ps --status running --services | grep -qx postgres \
  || { echo "Test stack is not running. Start it with: npm run test:infra:up"; exit 1; }

cd "$ROOT/backend"
echo "== build"
npx tsc -p .
echo "== migrate the disposable test database"
npx prisma migrate deploy --schema prisma/schema.prisma > /dev/null

echo "== start API and consumer (logs in $OUT_DIR)"
SERVICE_NAME=eventguard-api node dist/server.js > "$OUT_DIR/api.log" 2>&1 &
API_PID=$!
SERVICE_NAME=eventguard-consumer node dist/eventConsumer.js > "$OUT_DIR/consumer.log" 2>&1 &
CONSUMER_PID=$!
trap 'kill $API_PID $CONSUMER_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "localhost:$API_PORT/health/ready")" = 200 ] && break
  sleep 1
done
curl -sf "localhost:$API_PORT/health/ready" > /dev/null || { echo "API not ready; see $OUT_DIR/api.log"; exit 1; }
# Without a live consumer only the recovery sweep would process events, and the numbers would be meaningless
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "localhost:$CONSUMER_METRICS_PORT/health")" = 200 ] && break
  sleep 1
done
curl -sf "localhost:$CONSUMER_METRICS_PORT/health" > /dev/null || { echo "Consumer not running; see $OUT_DIR/consumer.log"; exit 1; }

echo "== k6"
LOADTEST_DIR="$ROOT/loadtest"
command -v cygpath > /dev/null && LOADTEST_DIR="$(cygpath -w "$LOADTEST_DIR")"
MSYS_NO_PATHCONV=1 docker run --rm -i --add-host=host.docker.internal:host-gateway \
  -v "$LOADTEST_DIR:/loadtest" grafana/k6:0.54.0 run \
  -e BASE_URL="http://host.docker.internal:$API_PORT" -e RUN_ID="$RUN_ID" -e ADMIN_KEY="$ADMIN_API_KEY" \
  -e RATE="$RATE" -e DURATION="$DURATION" -e WALLETS="$WALLETS" \
  -e DUPLICATE_SHARE="$DUPLICATE_SHARE" -e STORM_VUS="$STORM_VUS" \
  --summary-export "/loadtest/results/$RUN_ID/k6-summary.json" /loadtest/ingest.js | tee "$OUT_DIR/k6.txt" \
  || echo "k6 reported a threshold failure; see $OUT_DIR/k6.txt"

echo "== end-to-end report"
npx tsx scripts/loadtest-report.ts "$RUN_ID" --wait-seconds "${REPORT_WAIT_SECONDS:-180}" --out "$OUT_DIR/report.json" \
  | tee "$OUT_DIR/report.md"
