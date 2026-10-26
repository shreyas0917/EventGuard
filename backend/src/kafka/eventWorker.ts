import { prisma } from "../lib/prisma.js";
import { logger, withLogContext } from "../lib/logger.js";
import {
  duplicateDeliveries,
  eventEndToEndLatency,
  eventProcessingDuration,
  eventsProcessed,
} from "../lib/metrics.js";
import { acquireLock, releaseLock } from "../services/redisLockService.js";
import {
  markEventCompletedInCache,
  isEventCompletedInCache,
} from "../services/redisIdempotencyCache.js";
import { claimEventForProcessing, recordDuplicateDelivery } from "../services/eventClaimService.js";
import { completeEvent } from "../services/eventCompletionService.js";
import { handleProcessingFailure, shouldProcessFailSimulation } from "../services/retryService.js";
import { maybeCrash } from "../lib/faultInjection.js";

export interface KafkaEvent {
  eventId: string;
  eventType: string;
  payload: any;
}

export type ProcessOutcome = "completed" | "failed" | "lease-lost";

const PROCESSING_DELAY_MS = parseInt(process.env.PROCESSING_DELAY_MS || "0", 10);

const DUPLICATE_REASONS = {
  "already-completed": "Duplicate - already completed",
  "already-processing": "Duplicate - another worker holds the claim",
  "already-failed": "Event previously failed",
  "retry-scheduled": "Duplicate - retry already scheduled",
} as const;

async function recordDuplicate(eventId: string, reason: string, message: string): Promise<void> {
  duplicateDeliveries.inc({ reason });
  await recordDuplicateDelivery(eventId, message);
}

export async function processEvent(kafkaMessage: KafkaEvent): Promise<void> {
  return withLogContext({ eventId: kafkaMessage.eventId }, () => processEventInContext(kafkaMessage));
}

async function processEventInContext(kafkaMessage: KafkaEvent): Promise<void> {
  const { eventId } = kafkaMessage;

  try {
    logger.info(`[Worker] Received event: ${eventId}`);

    // STEP 1: Fast check using Redis cache (optimization only)
    if (await isEventCompletedInCache(eventId)) {
      logger.info(`[Worker] Event in Redis completed cache: ${eventId}`);
      await recordDuplicate(eventId, "completed_cache", "Duplicate delivery - found in completed cache");
      return;
    }

    // STEP 2: Redis lock (coordination only).
    // Redis infrastructure failures throw RedisLockError (must not be treated as contention).
    const lockHandle = await acquireLock(eventId);

    if (!lockHandle.acquired) {
      logger.info(`[Worker] Redis lock contention for ${eventId} - another worker holds the lock`);
      await recordDuplicate(eventId, "lock_contention", "Concurrent processing detected - Redis lock unavailable");
      // Normal contention: do not process. Offset may commit; the lock holder owns the work.
      return;
    }

    try {
      // STEP 3: Atomic claim in PostgreSQL - the durable gate. Exactly one caller wins.
      const claim = await claimEventForProcessing(eventId);

      if (claim.outcome === "not-found") {
        logger.warn(`[Worker] Event not found: ${eventId}`);
        return;
      }

      if (claim.outcome !== "claimed") {
        logger.info(`[Worker] Not claimable (${claim.outcome}): ${eventId}`);
        await recordDuplicate(eventId, claim.outcome.replace("-", "_"), DUPLICATE_REASONS[claim.outcome]);
        if (claim.outcome === "already-completed") {
          await markEventCompletedInCache(eventId);
        }
        return;
      }

      await processClaimedEvent(kafkaMessage, claim.claimToken);
    } finally {
      // Always release the lock (if acquired)
      await releaseLock(lockHandle);
    }
  } catch (error) {
    logger.error(`[Worker] Unexpected error processing event ${eventId}`, error);
    throw error;
  }
}

/**
 * Run an event this worker has claimed. The business effect and COMPLETED commit
 * together, fenced by the claim token; failures are recorded under the same fence.
 *
 * Failures are handled here rather than rethrown: rethrowing would make Kafka
 * redeliver immediately, while the retry worker applies backoff. If even recording
 * the failure fails (database down), the claim's lease expires and the retry
 * worker recovers the event.
 */
export async function processClaimedEvent(event: KafkaEvent, claimToken: string): Promise<ProcessOutcome> {
  const startedAt = process.hrtime.bigint();
  const outcome = await runClaimedEvent(event, claimToken);
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  const labels = { event_type: event.eventType, outcome: outcome.replace("-", "_") };
  eventsProcessed.inc(labels);
  eventProcessingDuration.observe(labels, seconds);
  return outcome;
}

async function runClaimedEvent(event: KafkaEvent, claimToken: string): Promise<ProcessOutcome> {
  const { eventId, eventType, payload } = event;

  try {
    await prisma.eventLog.create({
      data: { eventId, status: "PROCESSING", message: "Event processing started" },
    });

    logger.info(`[Worker] Processing event: ${eventId} (type: ${eventType})`);

    // Check for test failure simulation
    if (await shouldProcessFailSimulation(eventId)) {
      throw new Error("Intentional failure simulation for testing retry mechanism");
    }

    // Simulate processing with optional delay for testing (outside any transaction)
    await simulateProcessing(PROCESSING_DELAY_MS);
    maybeCrash("crash-before-commit", eventId);

    const completion = await completeEvent(event, claimToken);
    maybeCrash("crash-after-commit", eventId);
    if (!completion.completed) {
      logger.warn(`[Worker] Claim on ${eventId} expired and was taken over; nothing written`);
      return "lease-lost";
    }

    await markEventCompletedInCache(eventId);
    const endToEndSeconds = (Date.now() - completion.createdAt.getTime()) / 1000;
    eventEndToEndLatency.observe({ event_type: eventType }, endToEndSeconds);
    logger.info(`[Worker] Event completed: ${eventId}`, { endToEndMs: Math.round(endToEndSeconds * 1000) });
    return "completed";
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[Worker] Processing failed for ${eventId}: ${errorMessage}`);

    try {
      const outcome = await handleProcessingFailure(eventId, claimToken, errorMessage, eventType, payload);
      return outcome === "lease-lost" ? "lease-lost" : "failed";
    } catch (retryError) {
      logger.error(`[Worker] Error handling processing failure for ${eventId}`, retryError);
      return "failed";
    }
  }
}

async function simulateProcessing(delayMs: number): Promise<void> {
  if (delayMs > 0) {
    logger.debug(`[Worker] Processing delay: ${delayMs}ms`);
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
