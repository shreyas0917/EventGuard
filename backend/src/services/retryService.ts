import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { moveToDLQ } from "./dlqService.js";

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

export async function handleProcessingFailure(
  eventId: string,
  errorMessage: string,
  attemptCount: number,
  maxAttempts: number,
  eventType: string,
  payload: any
): Promise<void> {
  try {
    logger.error(`[Retry] Event ${eventId} processing failed: ${errorMessage}`);
    logger.info(`[Retry] Attempt ${attemptCount}/${maxAttempts}`);

    // Add failure log entry
    await prisma.eventLog.create({
      data: {
        eventId,
        status: "FAILED_ATTEMPT",
        message: `Attempt ${attemptCount} failed: ${errorMessage}`,
      },
    });

    if (shouldRetry(attemptCount, maxAttempts)) {
      // Schedule retry
      const nextRetryAt = calculateNextRetryTime(attemptCount);

      await prisma.event.update({
        where: { eventId },
        data: {
          status: "RETRYING",
          lastError: errorMessage,
          nextRetryAt,
        },
      });

      logger.info(
        `[Retry] Event ${eventId} scheduled for retry at ${nextRetryAt.toISOString()}`
      );
    } else {
      // Exhausted max attempts - move to DLQ
      await prisma.event.update({
        where: { eventId },
        data: {
          status: "FAILED",
          lastError: errorMessage,
          nextRetryAt: null,
        },
      });

      await prisma.eventLog.create({
        data: {
          eventId,
          status: "FAILED",
          message: `Event failed after ${maxAttempts} attempts: ${errorMessage}`,
        },
      });

      logger.error(`[Retry] Event ${eventId} reached maximum attempts (${maxAttempts})`);

      // Move to DLQ
      try {
        await moveToDLQ(eventId, eventType, payload, errorMessage, attemptCount);
      } catch (dlqError) {
        logger.error(`[Retry] Failed to move event ${eventId} to DLQ`, dlqError);
        throw dlqError;
      }
    }
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
