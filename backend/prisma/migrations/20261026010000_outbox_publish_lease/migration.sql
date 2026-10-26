-- Outbox publish lease. Workers claim PENDING rows with FOR UPDATE SKIP LOCKED and
-- stamp lockedUntil, so concurrent publishers never take the same rows. A worker that
-- crashes mid-batch simply lets the lease expire and the rows are published again
-- (consumers are idempotent, so a re-publish is safe). Purely additive.
ALTER TABLE "outbox_events" ADD COLUMN "lockedUntil" TIMESTAMP(3);

CREATE INDEX "outbox_events_status_lockedUntil_idx" ON "outbox_events"("status", "lockedUntil");
