import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export type EventClaimResult =
  | "claimed"
  | "already-processing"
  | "already-completed"
  | "already-failed"
  | "not-found"
  | "retrying";

export async function claimEventForProcessing(
  eventId: string
): Promise<EventClaimResult> {
  try {
    // Check current event status
    const event = await prisma.event.findUnique({
      where: { eventId },
    });

    if (!event) {
      logger.warn(`[Idempotency] Event not found: ${eventId}`);
      return "not-found";
    }

    // Check if already completed
    if (event.status === "COMPLETED") {
      logger.info(`[Idempotency] Event already completed: ${eventId}`);
      return "already-completed";
    }

    // Check if already processing
    if (event.status === "PROCESSING") {
      logger.info(`[Idempotency] Event already processing: ${eventId}`);
      return "already-processing";
    }

    // Check if permanently failed
    if (event.status === "FAILED") {
      logger.info(`[Idempotency] Event already failed: ${eventId}`);
      return "already-failed";
    }

    // Attempt to claim: RECEIVED → PROCESSING or RETRYING → PROCESSING
    // Use transaction to ensure atomicity
    const updated = await prisma.event.update({
      where: { eventId },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
      },
    });

    if (updated.status === "PROCESSING" || updated.status === "RETRYING") {
      logger.info(`[Idempotency] Event claimed for processing: ${eventId}`);
      return "claimed";
    }

    return "already-processing";
  } catch (error) {
    logger.error(`[Idempotency] Error claiming event ${eventId}`, error);
    throw error;
  }
}

export async function markEventAsCompleted(
  eventId: string,
  processedAt: Date = new Date()
): Promise<void> {
  try {
    await prisma.event.update({
      where: { eventId },
      data: {
        status: "COMPLETED",
        processedAt,
      },
    });

    logger.info(`[Idempotency] Event marked as completed: ${eventId}`);
  } catch (error) {
    logger.error(`[Idempotency] Error marking event as completed ${eventId}`, error);
    throw error;
  }
}

export async function recordDuplicateDelivery(
  eventId: string,
  message: string = "Duplicate event delivery ignored"
): Promise<void> {
  try {
    await prisma.eventLog.create({
      data: {
        eventId,
        status: "DUPLICATE",
        message,
      },
    });

    logger.info(`[Idempotency] Recorded duplicate delivery: ${eventId}`);
  } catch (error) {
    logger.error(`[Idempotency] Error recording duplicate delivery ${eventId}`, error);
    throw error;
  }
}

export async function getEventStatus(
  eventId: string
): Promise<string | null> {
  try {
    const event = await prisma.event.findUnique({
      where: { eventId },
      select: { status: true },
    });

    return event?.status || null;
  } catch (error) {
    logger.error(`[Idempotency] Error getting event status ${eventId}`, error);
    throw error;
  }
}

export async function markEventAsRetrying(
  eventId: string,
  errorMessage: string,
  nextRetryAt: Date
): Promise<void> {
  try {
    await prisma.event.update({
      where: { eventId },
      data: {
        status: "RETRYING",
        lastError: errorMessage,
        nextRetryAt,
      },
    });

    logger.info(`[Retry] Event ${eventId} marked as RETRYING, next retry at ${nextRetryAt.toISOString()}`);
  } catch (error) {
    logger.error(`[Retry] Error marking event as retrying ${eventId}`, error);
    throw error;
  }
}

export async function markEventAsFailed(
  eventId: string,
  errorMessage: string
): Promise<void> {
  try {
    await prisma.event.update({
      where: { eventId },
      data: {
        status: "FAILED",
        lastError: errorMessage,
        nextRetryAt: null,
      },
    });

    logger.info(`[Retry] Event ${eventId} marked as FAILED after max attempts`);
  } catch (error) {
    logger.error(`[Retry] Error marking event as failed ${eventId}`, error);
    throw error;
  }
}

export async function resetEventForRetry(eventId: string): Promise<void> {
  try {
    await prisma.event.update({
      where: { eventId },
      data: {
        status: "RETRYING",
        nextRetryAt: new Date(),
      },
    });

    logger.info(`[Retry] Event ${eventId} reset for manual retry`);
  } catch (error) {
    logger.error(`[Retry] Error resetting event for retry ${eventId}`, error);
    throw error;
  }
}

/**
 * Explicit DLQ replay reopen.
 * Only FAILED events may be reopened; normal claim still treats FAILED as terminal.
 */
export async function prepareEventForDlqReplay(eventId: string): Promise<void> {
  try {
    const event = await prisma.event.findUnique({ where: { eventId } });

    if (!event) {
      throw new Error(`Event not found for DLQ replay: ${eventId}`);
    }

    if (event.status !== "FAILED") {
      throw new Error(
        `DLQ replay requires FAILED status, found ${event.status} for ${eventId}`
      );
    }

    await prisma.event.update({
      where: { eventId },
      data: {
        status: "RETRYING",
        nextRetryAt: new Date(),
        lastError: null,
        // Fresh attempt budget so replay can run through the normal pipeline
        attemptCount: 0,
      },
    });

    await prisma.eventLog.create({
      data: {
        eventId,
        status: "REPLAY_PREPARED",
        message: "Event reopened from FAILED for DLQ replay",
      },
    });

    logger.info(`[DLQ] Event ${eventId} prepared for replay (FAILED → RETRYING)`);
  } catch (error) {
    logger.error(`[DLQ] Error preparing event ${eventId} for replay`, error);
    throw error;
  }
}

export async function getRetryableEvents(): Promise<any[]> {
  try {
    const now = new Date();
    const events = await prisma.event.findMany({
      where: {
        status: "RETRYING",
        nextRetryAt: { lte: now },
      },
      select: {
        eventId: true,
        eventType: true,
        payload: true,
        attemptCount: true,
        maxAttempts: true,
        lastError: true,
        nextRetryAt: true,
      },
    });

    return events;
  } catch (error) {
    logger.error("[Retry] Error fetching retryable events", error);
    throw error;
  }
}

export async function getFailedEvents(): Promise<any[]> {
  try {
    const events = await prisma.event.findMany({
      where: { status: "FAILED" },
      select: {
        eventId: true,
        eventType: true,
        attemptCount: true,
        lastError: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return events;
  } catch (error) {
    logger.error("[Retry] Error fetching failed events", error);
    throw error;
  }
}

export async function getRetryingEvents(): Promise<any[]> {
  try {
    const events = await prisma.event.findMany({
      where: { status: "RETRYING" },
      select: {
        eventId: true,
        eventType: true,
        attemptCount: true,
        nextRetryAt: true,
        lastError: true,
      },
      orderBy: { nextRetryAt: "asc" },
    });

    return events;
  } catch (error) {
    logger.error("[Retry] Error fetching retrying events", error);
    throw error;
  }
}
