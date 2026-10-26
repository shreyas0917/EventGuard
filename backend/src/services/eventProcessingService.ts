import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { processClaimedEvent } from "../kafka/eventWorker.js";
import { claimFailedEventForReplay } from "./eventClaimService.js";
import { clearEventCompletedCache } from "./redisIdempotencyCache.js";

export interface ProcessEventResult {
  success: boolean;
  error?: string;
}

/**
 * Replay a FAILED event once, for the DLQ replay endpoint.
 *
 * The event is claimed directly (FAILED → PROCESSING) with a fencing token, so
 * the retry worker or a late Kafka delivery cannot run it at the same time. It
 * then goes through the same fenced completion as any other attempt; the
 * original eventId is kept, so the ledger's UNIQUE guard still applies.
 */
export async function processEventById(
  eventId: string,
  eventType: string,
  payload: any
): Promise<ProcessEventResult> {
  try {
    logger.info(`[EventProcessing] Starting replay for event ${eventId}`);

    const event = await prisma.event.findUnique({
      where: { eventId },
      select: { status: true },
    });

    if (!event) {
      logger.error(`[EventProcessing] Event ${eventId} not found in database`);
      return { success: false, error: "Event not found in database" };
    }

    if (event.status === "COMPLETED") {
      // Already done — idempotent no-op success for replay callers
      logger.info(`[EventProcessing] Event ${eventId} already COMPLETED; treating replay as success`);
      return { success: true };
    }

    await clearEventCompletedCache(eventId);
    const claimToken = await claimFailedEventForReplay(eventId);

    if (!claimToken) {
      return { success: false, error: `Event is ${event.status}, only FAILED events can be replayed` };
    }

    const outcome = await processClaimedEvent({ eventId, eventType, payload }, claimToken);

    if (outcome === "completed") {
      logger.info(`[EventProcessing] Replay completed for event ${eventId}`);
      return { success: true };
    }

    const after = await prisma.event.findUnique({
      where: { eventId },
      select: { status: true, lastError: true },
    });
    const error = after?.lastError || `Event not completed after replay (status=${after?.status ?? "missing"})`;
    logger.error(`[EventProcessing] ${error}`);
    return { success: false, error };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[EventProcessing] Replay failed for event ${eventId}`, error);
    return { success: false, error: errorMessage };
  }
}
