import { getRetryableEvents } from "../services/eventClaimService.js";
import { processEvent } from "../kafka/eventWorker.js";
import { logger, withLogContext } from "../lib/logger.js";
import { config } from "../config/index.js";

let retryWorkerRunning = false;
let retryWorkerTimer: NodeJS.Timeout | null = null;

/**
 * One recovery pass: re-run every event whose retry backoff has elapsed, and every
 * PROCESSING event whose lease expired because its worker crashed. Each goes back
 * through processEvent(), so the usual claim and fencing rules apply.
 * Returns how many events were attempted.
 */
export async function runRetryCycle(): Promise<number> {
  const retryableEvents = await getRetryableEvents();

  if (retryableEvents.length > 0) {
    logger.info(`[RetryWorker] Found ${retryableEvents.length} retryable event(s)`);
  }

  for (const event of retryableEvents) {
    logger.info(
      event.status === "PROCESSING"
        ? `[RetryWorker] Recovering event ${event.eventId}: its processing lease expired`
        : event.status === "RECEIVED"
          ? `[RetryWorker] Recovering event ${event.eventId}: never claimed`
          : `[RetryWorker] Retrying event ${event.eventId} (attempt ${event.attemptCount}/${event.maxAttempts})`
    );

    try {
      await withLogContext({ trigger: "retry-worker" }, () =>
        processEvent({
          eventId: event.eventId,
          eventType: event.eventType,
          payload: event.payload,
        })
      );
    } catch (error) {
      logger.error(`[RetryWorker] Error retrying event ${event.eventId}`, error);
      // Continue with next event even if this one fails
    }
  }

  return retryableEvents.length;
}

export function startRetryWorker(intervalMs: number = config.retry_poll_interval_ms): void {
  if (retryWorkerRunning) {
    logger.warn("[RetryWorker] Retry worker already running");
    return;
  }

  retryWorkerRunning = true;
  logger.info(`[RetryWorker] Starting retry worker with ${intervalMs}ms poll interval`);

  // Self-scheduling so a slow pass never overlaps the next one
  const cycle = async () => {
    try {
      await runRetryCycle();
    } catch (error) {
      logger.error("[RetryWorker] Error in retry worker loop", error);
    }
    if (retryWorkerRunning) {
      retryWorkerTimer = setTimeout(cycle, intervalMs);
    }
  };

  retryWorkerTimer = setTimeout(cycle, intervalMs);
}

export function stopRetryWorker(): void {
  if (!retryWorkerRunning) {
    logger.warn("[RetryWorker] Retry worker not running");
    return;
  }

  if (retryWorkerTimer) {
    clearTimeout(retryWorkerTimer);
    retryWorkerTimer = null;
  }
  retryWorkerRunning = false;
  logger.info("[RetryWorker] Retry worker stopped");
}

export function isRetryWorkerRunning(): boolean {
  return retryWorkerRunning;
}
