#!/usr/bin/env bash
# End-to-end auth smoke test against a running stack (docker compose up).
# Exercises the real pipeline: demo login -> wallet -> admin-created PAYMENT_SUCCESS
# -> outbox -> Kafka -> consumer -> wallet credit, plus the access-control denials.
set -euo pipefail

API="${API:-http://localhost:3001}"
ADMIN_KEY="${ADMIN_API_KEY:-dev-admin-key-change-me}"
RUN="$(date +%s)"
USER_ID="smoke_user_${RUN}"
EVENT_ID="evt_smoke_${RUN}"
FAILURES=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "  ok    $1 ($3)"; else echo "  FAIL  $1: expected $2, got $3"; FAILURES=$((FAILURES + 1)); fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
json_field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=$1;console.log(v===undefined?'':v)})" ; }

echo "Anonymous access"
check "GET /api/events without a token" 401 "$(status "$API/api/events")"
check "POST /api/dlq/x/replay without a token" 401 "$(status -X POST "$API/api/dlq/x/replay")"

echo "Demo login"
USER_TOKEN=$(curl -s -X POST "$API/api/auth/demo-login" -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\"}" | json_field 'JSON.parse(s).token')
ADMIN_TOKEN=$(curl -s -X POST "$API/api/auth/demo-login" -H 'Content-Type: application/json' \
  -d "{\"userId\":\"smoke_admin\",\"role\":\"admin\",\"adminKey\":\"$ADMIN_KEY\"}" | json_field 'JSON.parse(s).token')
check "user token issued" yes "$([ -n "$USER_TOKEN" ] && echo yes || echo no)"
check "admin token issued" yes "$([ -n "$ADMIN_TOKEN" ] && echo yes || echo no)"
check "admin login with a wrong key" 401 "$(status -X POST "$API/api/auth/demo-login" -H 'Content-Type: application/json' \
  -d '{"userId":"x","role":"admin","adminKey":"wrong-key-0123456789"}')"

U=(-H "Authorization: Bearer $USER_TOKEN")
A=(-H "Authorization: Bearer $ADMIN_TOKEN")

echo "Authorization"
check "user creates own wallet" 201 "$(status -X POST "$API/api/wallets" "${U[@]}" -H 'Content-Type: application/json' -d '{}')"
check "user reads someone else's wallet" 403 "$(status "$API/api/wallets/someone_else" "${U[@]}")"
check "user creates a PAYMENT_SUCCESS event" 403 "$(status -X POST "$API/api/events" "${U[@]}" -H 'Content-Type: application/json' \
  -d "{\"eventId\":\"$EVENT_ID\",\"eventType\":\"PAYMENT_SUCCESS\",\"payload\":{\"userId\":\"$USER_ID\",\"paymentId\":\"pay_x\",\"orderId\":\"order_x\",\"amount\":1000}}")"
check "user lists the DLQ" 403 "$(status "$API/api/dlq" "${U[@]}")"
check "admin pagination over the cap" 400 "$(status "$API/api/events?limit=100000" "${A[@]}")"

echo "Pipeline still credits exactly once"
BODY="{\"eventId\":\"$EVENT_ID\",\"eventType\":\"PAYMENT_SUCCESS\",\"payload\":{\"userId\":\"$USER_ID\",\"paymentId\":\"pay_$RUN\",\"orderId\":\"order_$RUN\",\"amount\":100}}"
check "admin creates the event" 201 "$(status -X POST "$API/api/events" "${A[@]}" -H 'Content-Type: application/json' -d "$BODY")"
check "same event again" 409 "$(status -X POST "$API/api/events" "${A[@]}" -H 'Content-Type: application/json' -d "$BODY")"

BALANCE=""
for _ in $(seq 1 20); do
  BALANCE=$(curl -s "$API/api/wallets/$USER_ID" "${U[@]}" | json_field 'JSON.parse(s).wallet?.balance')
  [ "$BALANCE" = "100" ] && break
  sleep 1
done
check "owner sees the credited balance" 100 "$BALANCE"
check "exactly one ledger entry" 1 "$(curl -s "$API/api/wallets/$USER_ID/transactions" "${U[@]}" | json_field 'JSON.parse(s).total')"

echo
if [ "$FAILURES" -eq 0 ]; then echo "All checks passed"; else echo "$FAILURES check(s) failed"; exit 1; fi
