-- Migration: Fix column name mismatches to align with Prisma schema
-- Phase 10 - Database schema reconciliation

-- ===== events table =====
-- Rename eventid to eventId (to match Prisma camelCase)
ALTER TABLE "events" RENAME COLUMN "eventid" TO "eventId";

-- Rename eventtype to eventType
ALTER TABLE "events" RENAME COLUMN "eventtype" TO "eventType";

-- Recreate indexes with new column names
DROP INDEX IF EXISTS "events_eventid_idx";
DROP INDEX IF EXISTS "events_eventid_key";
CREATE INDEX "events_eventid_idx" ON "events"("eventId");
CREATE UNIQUE INDEX "events_eventId_key" ON "events"("eventId");

-- ===== wallet_transactions table =====
ALTER TABLE "wallet_transactions" RENAME COLUMN "walletid" TO "walletId";
ALTER TABLE "wallet_transactions" RENAME COLUMN "eventid" TO "eventId";
ALTER TABLE "wallet_transactions" RENAME COLUMN "createdat" TO "createdAt";

-- Recreate indexes with new column names
DROP INDEX IF EXISTS "idx_wallet_tx_wallet";
DROP INDEX IF EXISTS "idx_wallet_tx_event";
DROP INDEX IF EXISTS "idx_wallet_tx_created";
DROP INDEX IF EXISTS "wallet_transactions_eventid_key";

CREATE INDEX "idx_wallet_tx_wallet" ON "wallet_transactions"("walletId");
CREATE INDEX "idx_wallet_tx_event" ON "wallet_transactions"("eventId");
CREATE INDEX "idx_wallet_tx_created" ON "wallet_transactions"("createdAt");
CREATE UNIQUE INDEX "wallet_transactions_eventId_key" ON "wallet_transactions"("eventId");

-- Drop and recreate foreign key constraint
ALTER TABLE "wallet_transactions" DROP CONSTRAINT IF EXISTS "wallet_transactions_walletid_fkey";
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_walletId_fkey"
  FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE;

-- ===== event_logs table =====
ALTER TABLE "event_logs" RENAME COLUMN "eventid" TO "eventId";

-- Recreate indexes with new column names
DROP INDEX IF EXISTS "event_logs_eventid_idx";
CREATE INDEX "event_logs_eventId_idx" ON "event_logs"("eventId");

-- Drop and recreate foreign key constraint
ALTER TABLE "event_logs" DROP CONSTRAINT IF EXISTS "event_logs_eventid_fkey";
ALTER TABLE "event_logs" ADD CONSTRAINT "event_logs_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "events"("eventId") ON DELETE CASCADE;
