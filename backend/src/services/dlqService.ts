import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export async function moveToDLQ(
  eventId: string,
  eventType: string,
  payload: any,
  reason: string,
  attemptCount: number
): Promise<void> {
  try {
    // Use transaction to ensure atomic DLQ creation with event update
    await prisma.$transaction(async (tx) => {
      // Create DLQ record
      await tx.deadLetterEvent.create({
        data: {
          eventId,
          eventType,
          payload,
          reason,
          attemptCount,
          status: "PENDING",
          failedAt: new Date(),
        },
      });

      logger.info(`[DLQ] Event ${eventId} moved to DLQ after ${attemptCount} attempts`);
    });

    // Add EventLog entry
    await prisma.eventLog.create({
      data: {
        eventId,
        status: "DLQ_CREATED",
        message: `Event moved to DLQ: ${reason}`,
      },
    });
  } catch (error) {
    logger.error(`[DLQ] Error moving event ${eventId} to DLQ`, error);
    throw error;
  }
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

export async function startReplay(eventId: string): Promise<void> {
  try {
    await prisma.deadLetterEvent.update({
      where: { eventId },
      data: {
        status: "REPLAYING",
      },
    });

    await prisma.eventLog.create({
      data: {
        eventId,
        status: "REPLAY_STARTED",
        message: "Replay from DLQ initiated",
      },
    });

    logger.info(`[DLQ] Replay started for event ${eventId}`);
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
