import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";

export type EventClaimResult =
  | { outcome: "claimed"; claimToken: string }
  | { outcome: "already-processing" }
  | { outcome: "already-completed" }
  | { outcome: "already-failed" }
  | { outcome: "retry-scheduled" }
  | { outcome: "not-found" };

function leaseExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + config.event_lease_seconds * 1000);
}

/**
 * Atomically claim an event for processing.
 *
 * One conditional UPDATE moves the event to PROCESSING, stamps a fresh fencing
 * token and a lease, and bumps attemptCount. PostgreSQL re-checks the WHERE clause
 * after waiting on the row lock, so among any number of concurrent callers exactly
 * one gets count = 1. Claimable states:
 *   - RECEIVED
 *   - RETRYING whose backoff has elapsed
 *   - PROCESSING whose lease expired (the previous worker crashed or stalled)
 */
export async function claimEventForProcessing(eventId: string): Promise<EventClaimResult> {
  const now = new Date();
  const claimToken = randomUUID();

  const { count } = await prisma.event.updateMany({
    where: {
      eventId,
      OR: [
        { status: "RECEIVED" },
        { status: "RETRYING", OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
        { status: "PROCESSING", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
      ],
    },
    data: {
      status: "PROCESSING",
      attemptCount: { increment: 1 },
      claimToken,
      leaseExpiresAt: leaseExpiry(now),
      nextRetryAt: null,
    },
  });

  if (count === 1) {
    logger.info(`[Idempotency] Event claimed for processing: ${eventId}`);
    return { outcome: "claimed", claimToken };
  }

  // Lost the race or not claimable: report why, for the duplicate log
  const event = await prisma.event.findUnique({ where: { eventId }, select: { status: true } });
  switch (event?.status) {
    case undefined:
      logger.warn(`[Idempotency] Event not found: ${eventId}`);
      return { outcome: "not-found" };
    case "COMPLETED":
      return { outcome: "already-completed" };
    case "FAILED":
      return { outcome: "already-failed" };
    case "RETRYING":
      return { outcome: "retry-scheduled" };
    default:
      return { outcome: "already-processing" };
  }
}

/**
 * DLQ replay: reopen a FAILED event for exactly one more attempt. Claims it
 * directly (FAILED → PROCESSING) so no other worker can pick it up in between.
 * Returns the claim token, or null if the event is not FAILED.
 */
export async function claimFailedEventForReplay(eventId: string): Promise<string | null> {
  const event = await prisma.event.findUnique({ where: { eventId }, select: { maxAttempts: true } });
  if (!event) return null;

  const claimToken = randomUUID();
  const { count } = await prisma.event.updateMany({
    where: { eventId, status: "FAILED" },
    data: {
      status: "PROCESSING",
      // The replay is the final attempt: a failure goes straight back to FAILED + DLQ
      attemptCount: event.maxAttempts,
      claimToken,
      leaseExpiresAt: leaseExpiry(),
      nextRetryAt: null,
      lastError: null,
    },
  });

  if (count !== 1) return null;

  await prisma.eventLog.create({
    data: { eventId, status: "REPLAY_PREPARED", message: "Event reopened from FAILED for one replay attempt" },
  });
  logger.info(`[DLQ] Event ${eventId} claimed for replay (FAILED → PROCESSING)`);
  return claimToken;
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

/**
 * Manual retry of a FAILED event: schedule it for the retry worker now.
 * Conditional on FAILED, so it cannot clobber an event that moved on meanwhile.
 * Returns false if the event was not FAILED.
 */
export async function resetEventForRetry(eventId: string): Promise<boolean> {
  try {
    const { count } = await prisma.event.updateMany({
      where: { eventId, status: "FAILED" },
      data: {
        status: "RETRYING",
        nextRetryAt: new Date(),
      },
    });

    if (count === 1) {
      logger.info(`[Retry] Event ${eventId} reset for manual retry`);
    }
    return count === 1;
  } catch (error) {
    logger.error(`[Retry] Error resetting event for retry ${eventId}`, error);
    throw error;
  }
}

/**
 * Events the retry worker should run now:
 *   - RETRYING events whose backoff elapsed
 *   - PROCESSING events whose lease expired because their worker died mid-flight
 *   - RECEIVED events that were never claimed. A Kafka delivery that finds the Redis
 *     lock held treats it as contention and commits its offset; if the holder was a
 *     crashed worker (or a timed-out SET that still landed), no one else would ever
 *     run the event. The database is the source of truth, so the sweeper does.
 */
export async function getRetryableEvents(limit: number = 50): Promise<any[]> {
  try {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - config.stale_received_seconds * 1000);
    const events = await prisma.event.findMany({
      where: {
        OR: [
          { status: "RETRYING", nextRetryAt: { lte: now } },
          { status: "PROCESSING", leaseExpiresAt: { lt: now } },
          { status: "RECEIVED", createdAt: { lt: staleBefore } },
        ],
      },
      select: {
        eventId: true,
        eventType: true,
        payload: true,
        status: true,
        attemptCount: true,
        maxAttempts: true,
        lastError: true,
        nextRetryAt: true,
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
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
