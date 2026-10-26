import { processOutboxBatch } from "../services/outboxPublisher.js";
import { logger } from "../lib/logger.js";

export interface OutboxWorkerConfig {
  intervalMs: number;
  batchSize: number;
  enabled: boolean;
}

const defaultConfig: OutboxWorkerConfig = {
  intervalMs: parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || "500", 10),
  batchSize: parseInt(process.env.OUTBOX_BATCH_SIZE || "50", 10),
  enabled: true, // Enabled in Phase 4 with Kafka integration
};

let isRunning = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Poll the outbox. Each cycle schedules the next one only after it finishes, so
 * cycles never overlap; a full batch means more is waiting, so the next cycle
 * starts immediately instead of after the interval.
 */
export function startOutboxWorker(config: OutboxWorkerConfig = defaultConfig) {
  if (isRunning) {
    logger.warn("Outbox worker is already running");
    return;
  }

  if (!config.enabled) {
    logger.info("Outbox worker not started (disabled)");
    return;
  }

  isRunning = true;
  logger.info(`Starting Outbox Worker (interval: ${config.intervalMs}ms, batch: ${config.batchSize})`);

  const cycle = async () => {
    let published = 0;
    try {
      published = await processOutboxBatch({ batchSize: config.batchSize, enabled: config.enabled });
    } catch (error) {
      logger.error("Outbox worker cycle failed", error);
    }
    if (isRunning) {
      timer = setTimeout(cycle, published >= config.batchSize ? 0 : config.intervalMs);
    }
  };

  timer = setTimeout(cycle, 0);
}

export function stopOutboxWorker() {
  if (!isRunning) {
    logger.warn("Outbox worker is not running");
    return;
  }

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  isRunning = false;
  logger.info("Outbox worker stopped");
}

export function isOutboxWorkerRunning(): boolean {
  return isRunning;
}
