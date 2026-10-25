-- Migration: Add DeadLetterEvent table for Phase 8 DLQ support
-- Adds only the dead_letter_events table without affecting existing data or tables.

-- CreateEnum
CREATE TYPE "DLQStatus" AS ENUM ('PENDING', 'REPLAYING', 'RESOLVED');

-- CreateTable
CREATE TABLE "dead_letter_events" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "status" "DLQStatus" NOT NULL DEFAULT 'PENDING',
    "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letter_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dead_letter_events_eventId_key" UNIQUE ("eventId")
);

-- CreateIndex
CREATE INDEX "dead_letter_events_status_idx" ON "dead_letter_events"("status");
CREATE INDEX "dead_letter_events_failedAt_idx" ON "dead_letter_events"("failedAt");
