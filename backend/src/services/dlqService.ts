import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export interface DeadLetterInput {
  eventId: string;
  eventType: string;
  payload: any;
  reason: string;
  attemptCount: number;
}

/**
 * Open a dead-letter entry inside the caller's transaction. An event that was
 * dead-lettered before (and replayed or retried) reopens its existing row instead
 * of colliding with dead_letter_events.eventId UNIQUE.
 */
export async function upsertDeadLetter(tx: Prisma.TransactionClient, input: DeadLetterInput): Promise<void> {
  const failedAt = new Date();
  await tx.deadLetterEvent.upsert({
    where: { eventId: input.eventId },
    create: { ...input, status: "PENDING", failedAt },
    update: { reason: input.reason, attemptCount: input.attemptCount, status: "PENDING", failedAt },
  });
  await tx.eventLog.create({
    data: { eventId: input.eventId, status: "DLQ_CREATED", message: `Event moved to DLQ: ${input.reason}` },
  });
  logger.info(`[DLQ] Event ${input.eventId} moved to DLQ after ${input.attemptCount} attempts`);
}

export async function getDLQEvents(status?: string): Promise<any[]> {
  try {
    const where = status ? { status: status as any } : {};

    const events = await prisma.deadLetterEvent.findMany({
      where,
      orderBy: { failedAt: "desc" },
    });

    return events;
  } catch (error) {
    logger.error("[DLQ] Error fetching DLQ events", error);
    throw error;
  }
}

export async function getDLQEvent(eventId: string): Promise<any> {
  try {
    const dlqEvent = await prisma.deadLetterEvent.findUnique({
      where: { eventId },
    });

    return dlqEvent;
  } catch (error) {
    logger.error(`[DLQ] Error fetching DLQ event ${eventId}`, error);
    throw error;
  }
}

/** A REPLAYING entry untouched this long is treated as abandoned (the replaying process died). */
const STALE_REPLAY_MS = 5 * 60 * 1000;

/**
 * Atomically move a dead-letter entry to REPLAYING. Returns false if another
 * replay holds it (or it is resolved), so concurrent replay requests cannot
 * both run.
 */
export async function startReplay(eventId: string): Promise<boolean> {
  try {
    const { count } = await prisma.deadLetterEvent.updateMany({
      where: {
        eventId,
        OR: [
          { status: "PENDING" },
          { status: "REPLAYING", updatedAt: { lt: new Date(Date.now() - STALE_REPLAY_MS) } },
        ],
      },
      data: {
        status: "REPLAYING",
      },
    });

    if (count !== 1) {
      return false;
    }

    await prisma.eventLog.create({
      data: {
        eventId,
        status: "REPLAY_STARTED",
        message: "Replay from DLQ initiated",
      },
    });

    logger.info(`[DLQ] Replay started for event ${eventId}`);
    return true;
  } catch (error) {
    logger.error(`[DLQ] Error starting replay for ${eventId}`, error);
    throw error;
  }
}

export async function completeReplay(eventId: string): Promise<void> {
  try {
    await prisma.deadLetterEvent.update({
      where: { eventId },
      data: {
        status: "RESOLVED",
      },
    });

    await prisma.eventLog.create({
      data: {
        eventId,
        status: "DLQ_RESOLVED",
        message: "DLQ event successfully replayed",
      },
    });

    logger.info(`[DLQ] Replay completed and resolved for event ${eventId}`);
  } catch (error) {
    logger.error(`[DLQ] Error completing replay for ${eventId}`, error);
    throw error;
  }
}

export async function failReplay(eventId: string, newReason: string): Promise<void> {
  try {
    await prisma.deadLetterEvent.update({
      where: { eventId },
      data: {
        status: "PENDING",
        reason: newReason,
      },
    });

    await prisma.eventLog.create({
      data: {
        eventId,
        status: "REPLAY_FAILED",
        message: `Replay failed: ${newReason}`,
      },
    });

    logger.info(`[DLQ] Replay failed for event ${eventId}, returned to PENDING`);
  } catch (error) {
    logger.error(`[DLQ] Error failing replay for ${eventId}`, error);
    throw error;
  }
}

export async function resolveDLQManually(eventId: string, reason: string): Promise<void> {
  try {
    await prisma.deadLetterEvent.update({
      where: { eventId },
      data: {
        status: "RESOLVED",
      },
    });

    await prisma.eventLog.create({
      data: {
        eventId,
        status: "DLQ_RESOLVED",
        message: `Manually resolved: ${reason}`,
      },
    });

    logger.info(`[DLQ] Event ${eventId} manually resolved`);
  } catch (error) {
    logger.error(`[DLQ] Error resolving event ${eventId}`, error);
    throw error;
  }
}

export async function isDLQEventExists(eventId: string): Promise<boolean> {
  try {
    const dlqEvent = await prisma.deadLetterEvent.findUnique({
      where: { eventId },
    });

    return !!dlqEvent;
  } catch (error) {
    logger.error(`[DLQ] Error checking DLQ existence for ${eventId}`, error);
    return false;
  }
}
