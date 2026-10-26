-- Durable money invariants enforced by PostgreSQL itself, so no code path
-- (including ad-hoc scripts) can write an impossible ledger state.
-- Prisma's schema language cannot express CHECK constraints; they live here.

-- Ledger rows: positive amounts and a closed set of types and statuses
ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "wallet_transactions_type_valid" CHECK ("type" IN ('CREDIT', 'DEBIT')),
  ADD CONSTRAINT "wallet_transactions_status_valid" CHECK ("status" IN ('PENDING', 'COMPLETED', 'FAILED'));

-- A wallet can never go negative, whatever a future debit path does
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_balance_non_negative" CHECK ("balance" >= 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0);

-- Attempt counters are never negative; at least one attempt is always allowed
ALTER TABLE "events"
  ADD CONSTRAINT "events_attempt_count_non_negative" CHECK ("attemptCount" >= 0),
  ADD CONSTRAINT "events_max_attempts_positive" CHECK ("maxAttempts" >= 1);

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_attempt_count_non_negative" CHECK ("attemptCount" >= 0);

ALTER TABLE "dead_letter_events"
  ADD CONSTRAINT "dead_letter_events_attempt_count_non_negative" CHECK ("attemptCount" >= 0);
