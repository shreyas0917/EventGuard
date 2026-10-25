import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { processEvent } from "../kafka/eventWorker.js";
import { prepareEventForDlqReplay } from "./eventClaimService.js";
import { clearEventCompletedCache } from "./redisIdempotencyCache.js";

export interface ProcessEventResult {
  success: boolean;
  error?: string;
}

/**
 * Process an event by its eventId.
 *
 * Used by the DLQ replay flow to re-run a permanently-failed event
 * through the full idempotency pipeline. The original eventId is
 * preserved so that all idempotency layers (Redis cache, PostgreSQL
 * claim, UNIQUE constraints) remain active during replay.
 *
 * @param eventId - The original event's eventId (preserved across replay)
 * @param eventType - The event type to process
 * @param payload - The event payload
 * @returns ProcessEventResult indicating success or failure
 */
export async function processEventById(
  eventId: string,
  eventType: string,
  payload: any
): Promise<ProcessEventResult> {
  try {
    logger.info(`[EventProcessing] Starting replay for event ${eventId}`);

    // Verify the event exists in the database
    const event = await prisma.event.findUnique({
      where: { eventId },
    });

    if (!event) {
      logger.error(`[EventProcessing] Event ${eventId} not found in database`);
      return { success: false, error: "Event not found in database" };
    }

    // Replay-only reopen: FAILED → RETRYING so claimEventForProcessing can proceed.
    // Normal Kafka/retry paths still treat FAILED as terminal.
    if (event.status === "FAILED") {
      await clearEventCompletedCache(eventId);
      await prepareEventForDlqReplay(eventId);
    } else if (event.status === "COMPLETED") {
      // Already done — idempotent no-op success for replay callers
      logger.info(
        `[EventProcessing] Event ${eventId} already COMPLETED; treating replay as success`
      );
      return { success: true };
    }

    // Process through the standard pipeline (same eventId)
    await processEvent({ eventId, eventType, payload });

    // Do not trust a silent early-return as success (e.g. already-failed)
    const after = await prisma.event.findUnique({
      where: { eventId },
      select: { status: true },
    });

    if (after?.status !== "COMPLETED") {
      const error = `Event not completed after replay (status=${after?.status ?? "missing"})`;
      logger.error(`[EventProcessing] ${error}`);
      return { success: false, error };
    }

    logger.info(`[EventProcessing] Replay completed for event ${eventId}`);
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[EventProcessing] Replay failed for event ${eventId}`, error);
    return { success: false, error: errorMessage };
  }
}
