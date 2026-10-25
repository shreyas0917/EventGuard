import { getRetryableEvents } from "../services/eventClaimService.js";
import { processEvent } from "../kafka/eventWorker.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";

let retryWorkerRunning = false;
let retryWorkerInterval: NodeJS.Timeout | null = null;

export function startRetryWorker(intervalMs: number = config.retry_poll_interval_ms): void {
  if (retryWorkerRunning) {
    logger.warn("[RetryWorker] Retry worker already running");
    return;
  }

  retryWorkerRunning = true;
  logger.info(`[RetryWorker] Starting retry worker with ${intervalMs}ms poll interval`);

  retryWorkerInterval = setInterval(async () => {
    try {
      const retryableEvents = await getRetryableEvents();

      if (retryableEvents.length > 0) {
        logger.info(`[RetryWorker] Found ${retryableEvents.length} retryable event(s)`);

        for (const event of retryableEvents) {
          logger.info(
            `[RetryWorker] Retrying event ${event.eventId} (attempt ${event.attemptCount}/${event.maxAttempts})`
          );

          try {
            await processEvent({
              eventId: event.eventId,
              eventType: event.eventType,
              payload: event.payload,
            });
          } catch (error) {
            logger.error(`[RetryWorker] Error retrying event ${event.eventId}`, error);
            // Continue with next event even if this one fails
          }
        }
      }
    } catch (error) {
      logger.error("[RetryWorker] Error in retry worker loop", error);
    }
  }, intervalMs);
}

export function stopRetryWorker(): void {
  if (!retryWorkerRunning || !retryWorkerInterval) {
    logger.warn("[RetryWorker] Retry worker not running");
    return;
  }

  clearInterval(retryWorkerInterval);
  retryWorkerRunning = false;
  logger.info("[RetryWorker] Retry worker stopped");
}

export function isRetryWorkerRunning(): boolean {
  return retryWorkerRunning;
}
