import { publishEvent, publishEvents } from "../kafka/producer.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { outboxPublished, outboxPublishFailures } from "../lib/metrics.js";
import { config } from "../config/index.js";

export interface OutboxPublisherConfig {
  batchSize: number;
  enabled: boolean;
}

const defaultConfig: OutboxPublisherConfig = {
  batchSize: 10,
  enabled: true, // Enabled in Phase 4 when Kafka producer is integrated
};

/** Failed rows back off before the next attempt: 1 s, 2 s, 4 s ... capped here. */
const MAX_BACKOFF_SECONDS = 60;

interface ClaimedOutboxRow {
  id: string;
  eventId: string;
  eventType: string;
  payload: any;
  attemptCount: number;
}

/**
 * Lease up to `limit` PENDING rows for this worker.
 *
 * FOR UPDATE SKIP LOCKED means concurrent publishers (several API replicas, or two
 * overlapping poll cycles) claim disjoint rows instead of waiting on or duplicating
 * each other. The lease also covers a crash between "published to Kafka" and "marked
 * PUBLISHED": the rows become claimable again when it expires and are re-published,
 * which consumers absorb as a duplicate delivery.
 */
export async function claimPendingOutboxBatch(limit: number): Promise<ClaimedOutboxRow[]> {
  return prisma.$queryRaw<ClaimedOutboxRow[]>`
    UPDATE "outbox_events"
    SET "lockedUntil" = NOW() + make_interval(secs => ${config.outbox_lease_seconds})
    WHERE "id" IN (
      SELECT "id" FROM "outbox_events"
      WHERE "status" = 'PENDING' AND ("lockedUntil" IS NULL OR "lockedUntil" < NOW())
      ORDER BY "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "eventId", "eventType", "payload", "attemptCount"`;
}

async function markPublished(rows: ClaimedOutboxRow[]): Promise<void> {
  await prisma.outboxEvent.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, status: "PENDING" },
    data: { status: "PUBLISHED", publishedAt: new Date(), lockedUntil: null },
  });
}

/** Keep the rows PENDING, record the error and back off before the next attempt. */
async function recordFailure(rows: ClaimedOutboxRow[], errorMessage: string): Promise<void> {
  await prisma.$transaction(
    rows.map((row) => {
      const backoffSeconds = Math.min(2 ** row.attemptCount, MAX_BACKOFF_SECONDS);
      return prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          attemptCount: { increment: 1 },
          lastError: errorMessage,
          lockedUntil: new Date(Date.now() + backoffSeconds * 1000),
        },
      });
    })
  );
}

/** Claim, publish and mark one batch. Returns how many rows were published. */
export async function processOutboxBatch(
  config: OutboxPublisherConfig = defaultConfig
): Promise<number> {
  if (!config.enabled) {
    logger.debug("Outbox worker is disabled");
    return 0;
  }

  const batch = await claimPendingOutboxBatch(config.batchSize);

  if (batch.length === 0) {
    logger.debug("No pending outbox events to process");
    return 0;
  }

  try {
    await publishEvents(batch);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await recordFailure(batch, errorMessage);
    outboxPublishFailures.inc(batch.length);
    logger.error(`[Outbox] Failed to publish batch of ${batch.length}; will retry with backoff`, error);
    return 0;
  }

  await markPublished(batch);
  outboxPublished.inc(batch.length);
  logger.info(`[Outbox] Published ${batch.length} event(s)`);
  return batch.length;
}

export async function publishSingleOutboxEvent(eventId: string): Promise<void> {
  const outboxEvent = await prisma.outboxEvent.findUnique({
    where: { eventId },
  });

  if (!outboxEvent) {
    throw new Error(`Outbox event not found: ${eventId}`);
  }

  try {
    await publishEvent(outboxEvent.eventId, outboxEvent.eventType, outboxEvent.payload);
    await markPublished([outboxEvent]);
    logger.info(`[Outbox] Manually published ${eventId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await recordFailure([outboxEvent], errorMessage);
    logger.error(`[Outbox] Manual publish failed for ${eventId}`, error);
    throw error;
  }
}
