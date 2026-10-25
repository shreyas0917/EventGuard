import {
  getPendingOutboxEvents,
  markOutboxAsPublished,
  recordOutboxPublishingFailure,
} from "./eventService.js";
import { publishEvent } from "../kafka/producer.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

export interface OutboxPublisherConfig {
  batchSize: number;
  enabled: boolean;
}

const defaultConfig: OutboxPublisherConfig = {
  batchSize: 10,
  enabled: true, // Enabled in Phase 4 when Kafka producer is integrated
};

// Publish event to Kafka using the producer
async function publishEventToKafka(eventId: string, eventType: string, payload: any): Promise<void> {
  await publishEvent(eventId, eventType, payload);
}

export async function processOutboxBatch(
  config: OutboxPublisherConfig = defaultConfig
): Promise<number> {
  if (!config.enabled) {
    logger.debug("Outbox worker is disabled");
    return 0;
  }

  const pendingEvents = await getPendingOutboxEvents(config.batchSize);

  if (pendingEvents.length === 0) {
    logger.debug("No pending outbox events to process");
    return 0;
  }

  logger.info(`[Outbox] Processing ${pendingEvents.length} pending outbox events`);

  let successCount = 0;

  for (const outboxEvent of pendingEvents) {
    try {
      logger.info(`[Outbox] Publishing ${outboxEvent.eventId}`);

      // Publish to Kafka
      await publishEventToKafka(
        outboxEvent.eventId,
        outboxEvent.eventType,
        outboxEvent.payload
      );

      // Mark as published only if Kafka publishing succeeds
      await markOutboxAsPublished(outboxEvent.eventId);
      successCount++;

      logger.info(`[Outbox] Published ${outboxEvent.eventId}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await recordOutboxPublishingFailure(outboxEvent.eventId, errorMessage);

      logger.error(
        `[Outbox] Failed to publish ${outboxEvent.eventId}`,
        error
      );
    }
  }

  logger.info(`[Outbox] Batch processed: ${successCount}/${pendingEvents.length}`);
  return successCount;
}

export async function publishSingleOutboxEvent(eventId: string): Promise<void> {
  try {
    const outboxEvent = await prisma.outboxEvent.findUnique({
      where: { eventId },
    });

    if (!outboxEvent) {
      throw new Error(`Outbox event not found: ${eventId}`);
    }

    await publishEventToKafka(
      outboxEvent.eventId,
      outboxEvent.eventType,
      outboxEvent.payload
    );
    await markOutboxAsPublished(eventId);
    logger.info(`[Outbox] Manually published ${eventId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await recordOutboxPublishingFailure(eventId, errorMessage);
    logger.error(`[Outbox] Manual publish failed for ${eventId}`, error);
    throw error;
  }
}
