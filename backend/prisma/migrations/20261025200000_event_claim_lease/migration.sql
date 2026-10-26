-- Atomic, fenced event claims: a worker claims an event by setting a fresh
-- claimToken and a lease; completion and failure writes only apply while the
-- token still matches, and an expired lease can be taken over after a crash.
ALTER TABLE "events" ADD COLUMN "claimToken" TEXT;
ALTER TABLE "events" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

-- Events left PROCESSING before this migration have no lease; make them
-- immediately recoverable instead of stuck forever.
UPDATE "events" SET "leaseExpiresAt" = NOW() WHERE "status" = 'PROCESSING';

CREATE INDEX "events_status_nextRetryAt_idx" ON "events"("status", "nextRetryAt");
CREATE INDEX "events_status_leaseExpiresAt_idx" ON "events"("status", "leaseExpiresAt");
