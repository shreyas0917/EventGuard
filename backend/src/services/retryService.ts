import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { prisma, TX_OPTIONS } from "../lib/prisma.js";
import { upsertDeadLetter } from "./dlqService.js";
import { eventsDeadLettered, retriesScheduled } from "../lib/metrics.js";

export function calculateNextRetryTime(attemptCount: number): Date {
  // Exponential backoff: baseDelay * 2^(attemptCount - 1)
  const delay = Math.min(
    config.retry_base_delay_ms * Math.pow(2, attemptCount - 1),
    config.max_retry_delay_ms
  );

  const nextRetryAt = new Date(Date.now() + delay);
  logger.info(
    `[Retry] Calculated next retry for attempt ${attemptCount}: +${delay}ms (at ${nextRetryAt.toISOString()})`
  );

  return nextRetryAt;
}

export function shouldRetry(attemptCount: number, maxAttempts: number): boolean {
  const willRetry = attemptCount < maxAttempts;
  logger.info(
    `[Retry] Should retry check: attempt ${attemptCount}/${maxAttempts} = ${willRetry}`
  );
  return willRetry;
}

export type FailureOutcome = "retrying" | "failed" | "lease-lost";

/**
 * Record a failed attempt, fenced by the claim token, in one transaction:
 *   - attempts left → RETRYING with exponential backoff
 *   - attempts exhausted → FAILED plus an open dead-letter row (inserted, or
 *     reopened if this event was dead-lettered before)
 * If the claim was taken over meanwhile, nothing is written ("lease-lost").
 */
export async function handleProcessingFailure(
  eventId: string,
  claimToken: string,
  errorMessage: string,
  eventType: string,
  payload: any
): Promise<FailureOutcome> {
  try {
    logger.error(`[Retry] Event ${eventId} processing failed: ${errorMessage}`);

    const outcome = await prisma.$transaction(async (tx) => {
      const event = await tx.event.findUnique({
        where: { eventId },
        select: { status: true, claimToken: true, attemptCount: true, maxAttempts: true },
      });

      if (!event || event.status !== "PROCESSING" || event.claimToken !== claimToken) {
        logger.warn(`[Retry] Claim on ${eventId} was lost; leaving the failure to the current owner`);
        return "lease-lost" as const;
      }

      const { attemptCount, maxAttempts } = event;
      logger.info(`[Retry] Attempt ${attemptCount}/${maxAttempts}`);
      const fence = { eventId, status: "PROCESSING" as const, claimToken };

      if (shouldRetry(attemptCount, maxAttempts)) {
        const nextRetryAt = calculateNextRetryTime(attemptCount);
        const { count } = await tx.event.updateMany({
          where: fence,
          data: { status: "RETRYING", lastError: errorMessage, nextRetryAt, claimToken: null, leaseExpiresAt: null },
        });
        if (count !== 1) return "lease-lost" as const;

        await tx.eventLog.create({
          data: { eventId, status: "FAILED_ATTEMPT", message: `Attempt ${attemptCount} failed: ${errorMessage}` },
        });
        logger.info(`[Retry] Event ${eventId} scheduled for retry at ${nextRetryAt.toISOString()}`);
        return "retrying" as const;
      }

      // Exhausted max attempts: FAILED and dead-lettered atomically
      const { count } = await tx.event.updateMany({
        where: fence,
        data: { status: "FAILED", lastError: errorMessage, nextRetryAt: null, claimToken: null, leaseExpiresAt: null },
      });
      if (count !== 1) return "lease-lost" as const;

      await tx.eventLog.createMany({
        data: [
          { eventId, status: "FAILED_ATTEMPT", message: `Attempt ${attemptCount} failed: ${errorMessage}` },
          { eventId, status: "FAILED", message: `Event failed after ${attemptCount} attempts: ${errorMessage}` },
        ],
      });
      await upsertDeadLetter(tx, { eventId, eventType, payload, reason: errorMessage, attemptCount });

      logger.error(`[Retry] Event ${eventId} reached maximum attempts (${maxAttempts}) and was dead-lettered`);
      return "failed" as const;
    }, TX_OPTIONS);

    // Counted only after the transaction committed
    if (outcome === "retrying") retriesScheduled.inc();
    if (outcome === "failed") eventsDeadLettered.inc();
    return outcome;
  } catch (error) {
    logger.error(`[Retry] Error handling processing failure for ${eventId}`, error);
    throw error;
  }
}

export async function shouldProcessFailSimulation(eventId: string): Promise<boolean> {
  if (!config.fail_processing_for_event_id) {
    return false;
  }

  const shouldFail = eventId === config.fail_processing_for_event_id;
  if (shouldFail) {
    logger.warn(
      `[Retry] INTENTIONAL FAILURE SIMULATION for event ${eventId} (FAIL_PROCESSING_FOR_EVENT_ID set)`
    );
  }
  return shouldFail;
}
