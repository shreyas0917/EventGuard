import { processOutboxBatch } from "../services/outboxPublisher.js";
import { logger } from "../lib/logger.js";

export interface OutboxWorkerConfig {
  intervalMs: number;
  batchSize: number;
  enabled: boolean;
}

const defaultConfig: OutboxWorkerConfig = {
  intervalMs: parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || "2000", 10),
  batchSize: parseInt(process.env.OUTBOX_BATCH_SIZE || "10", 10),
  enabled: true, // Enabled in Phase 4 with Kafka integration
};

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

export function startOutboxWorker(config: OutboxWorkerConfig = defaultConfig) {
  if (isRunning) {
    logger.warn("Outbox worker is already running");
    return;
  }

  isRunning = true;

  if (!config.enabled) {
    logger.info("Outbox worker not started (disabled)");
    isRunning = false;
    return;
  }

  logger.info(`Starting Outbox Worker (interval: ${config.intervalMs}ms)`);

  intervalId = setInterval(async () => {
    try {
      await processOutboxBatch({
        batchSize: config.batchSize,
        enabled: config.enabled,
      });
    } catch (error) {
      logger.error("Outbox worker cycle failed", error);
    }
  }, config.intervalMs);
}

export function stopOutboxWorker() {
  if (!isRunning) {
    logger.warn("Outbox worker is not running");
    return;
  }

  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  isRunning = false;
  logger.info("Outbox worker stopped");
}

export function isOutboxWorkerRunning(): boolean {
  return isRunning;
}
