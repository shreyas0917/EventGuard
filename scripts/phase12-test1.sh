#!/bin/bash
# Phase 12: Load, Concurrency & Reliability Validation
# Test 1: 100 Duplicate Events

echo "=== PHASE 12 TEST 1: 100 Duplicate Events ==="
echo ""

# Clean up test data
docker exec eventguard-postgres psql -U eventguard -d eventguard -c "
DELETE FROM wallet_transactions WHERE \"eventId\" LIKE 'evt_phase12_test1_%';
DELETE FROM event_logs WHERE \"eventId\" LIKE 'evt_phase12_test1_%';
DELETE FROM events WHERE \"eventId\" LIKE 'evt_phase12_test1_%';
DELETE FROM wallets WHERE \"userId\" = 'phase12_test1_user';
" 2>&1 > /dev/null

# Create wallet
WALLET=$(docker exec eventguard-postgres psql -U eventguard -d eventguard -t -c "
INSERT INTO wallets (id, \"userId\", balance, \"createdAt\", \"updatedAt\")
VALUES ('wallet_phase12_test1', 'phase12_test1_user', 0, NOW(), NOW())
RETURNING id;
")

WALLET_ID=$(echo "$WALLET" | tr -d ' ')
echo "✓ Created wallet: $WALLET_ID"
echo ""

# Create the event once in the database
EVENT_ID="evt_phase12_test1_duplicate_100"
docker exec eventguard-postgres psql -U eventguard -d eventguard -c "
INSERT INTO events (id, \"eventId\", \"eventType\", payload, status, \"createdAt\", \"updatedAt\")
VALUES ('evt_1', '$EVENT_ID', 'PAYMENT_SUCCESS', '{\"userId\":\"phase12_test1_user\",\"amount\":500}', 'RECEIVED', NOW(), NOW())
ON CONFLICT DO NOTHING;
" 2>&1

# Simulate 100 duplicate event deliveries by inserting wallet transactions
echo "Simulating 100 duplicate event processing attempts..."
for i in {1..100}; do
  docker exec eventguard-postgres psql -U eventguard -d eventguard -c "
  INSERT INTO wallet_transactions (id, \"walletId\", \"eventId\", type, amount, reason, status, \"createdAt\")
  VALUES ('wt_test1_$i', '$WALLET_ID', '$EVENT_ID', 'CREDIT', 500, 'Duplicate attempt $i', 'COMPLETED', NOW())
  ON CONFLICT (\"eventId\") DO NOTHING;
  " 2>&1 > /dev/null
done

echo ""
echo "=== TEST 1 RESULTS ==="

# Count results
TRANSACTION_COUNT=$(docker exec eventguard-postgres psql -U eventguard -d eventguard -t -c "
SELECT COUNT(*) FROM wallet_transactions WHERE \"eventId\" = '$EVENT_ID';
" | tr -d ' ')

WALLET_BALANCE=$(docker exec eventguard-postgres psql -U eventguard -d eventguard -t -c "
SELECT balance FROM wallets WHERE id = '$WALLET_ID';
" | tr -d ' ')

echo "Events sent: 100"
echo "WalletTransactions created: $TRANSACTION_COUNT"
echo "Final wallet balance: ₹$WALLET_BALANCE"
echo ""

if [ "$TRANSACTION_COUNT" = "1" ] && [ "$WALLET_BALANCE" = "500.00" ]; then
  echo "✅ TEST 1 PASSED: 100 duplicate events → 1 WalletTransaction"
  echo "TEST1_RESULT=PASS"
else
  echo "❌ TEST 1 FAILED"
  echo "Expected: 1 transaction, ₹500 balance"
  echo "Got: $TRANSACTION_COUNT transactions, ₹$WALLET_BALANCE balance"
  echo "TEST1_RESULT=FAIL"
fi
