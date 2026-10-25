-- Migration 4: Reconcile Prisma schema with migration history (additive / idempotent)
-- Adds objects present in schema.prisma but missing from migrations 0–3:
--   Event.maxAttempts, Event.lastError, Event.nextRetryAt
--   Wallet, WalletTransaction
--   Payment (+ PaymentStatus)
--   WebhookEvent (+ WebhookStatus)
--
-- Safe for existing EventGuard DBs that already received some of these via db push:
-- uses IF NOT EXISTS / exception handlers. Does not drop or rewrite data.

-- =============================================================================
-- Event retry columns (Phase 7)
-- =============================================================================
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "maxAttempts" INTEGER DEFAULT 3;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "nextRetryAt" TIMESTAMP(3);

UPDATE "events" SET "maxAttempts" = 3 WHERE "maxAttempts" IS NULL;
ALTER TABLE "events" ALTER COLUMN "maxAttempts" SET DEFAULT 3;
ALTER TABLE "events" ALTER COLUMN "maxAttempts" SET NOT NULL;

-- =============================================================================
-- Wallets (Phase 6) — may already exist on long-lived DBs
-- =============================================================================
CREATE TABLE IF NOT EXISTS "wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "wallets_userId_key" ON "wallets"("userId");
CREATE INDEX IF NOT EXISTS "wallets_userId_idx" ON "wallets"("userId");

CREATE TABLE IF NOT EXISTS "wallet_transactions" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_eventId_key" ON "wallet_transactions"("eventId");
CREATE INDEX IF NOT EXISTS "wallet_transactions_walletId_idx" ON "wallet_transactions"("walletId");
CREATE INDEX IF NOT EXISTS "wallet_transactions_eventId_idx" ON "wallet_transactions"("eventId");
CREATE INDEX IF NOT EXISTS "wallet_transactions_createdAt_idx" ON "wallet_transactions"("createdAt");

DO $$
BEGIN
    ALTER TABLE "wallet_transactions"
        ADD CONSTRAINT "wallet_transactions_walletId_fkey"
        FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN duplicate_table THEN NULL;
END $$;

-- =============================================================================
-- Payments (Phase 6 / 9)
-- =============================================================================
DO $$
BEGIN
    CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'REFUND_FAILED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "payments" (
    "id" TEXT NOT NULL,
    "razorpayPaymentId" TEXT,
    "razorpayOrderId" TEXT,
    "orderNumber" TEXT,
    "userId" TEXT,
    "amount" DECIMAL(15,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payments_razorpayPaymentId_key" ON "payments"("razorpayPaymentId");
CREATE INDEX IF NOT EXISTS "payments_razorpayPaymentId_idx" ON "payments"("razorpayPaymentId");
CREATE INDEX IF NOT EXISTS "payments_razorpayOrderId_idx" ON "payments"("razorpayOrderId");
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments"("status");

-- =============================================================================
-- Webhook events (Phase 9)
-- =============================================================================
DO $$
BEGIN
    CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "webhook_events" (
    "id" TEXT NOT NULL,
    "razorpayEventId" TEXT,
    "eventType" TEXT NOT NULL,
    "paymentId" TEXT,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_razorpayEventId_key" ON "webhook_events"("razorpayEventId");
CREATE INDEX IF NOT EXISTS "webhook_events_razorpayEventId_idx" ON "webhook_events"("razorpayEventId");
CREATE INDEX IF NOT EXISTS "webhook_events_eventType_idx" ON "webhook_events"("eventType");
CREATE INDEX IF NOT EXISTS "webhook_events_status_idx" ON "webhook_events"("status");
